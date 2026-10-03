import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { DB, type DailyReport, type NewsItem } from "@wyntn/common/src/db";
import { modelConfig } from "@wyntn/common/src/models";
import { LLMError } from "@wyntn/common/src/t-flow/flow";
import { prepareSources } from "../algorithms/algo-v1";
import { exportReports } from "./site-export";

const source: NewsItem = {
  id: "hn_test", src: "hn", day: "2026-10-02", title: "Example source",
  url: "https://example.com", summary: "A source with enough text to enter preparation.",
};
const limitMessage = "Key limit exceeded (total limit). Manage it using https://openrouter.ai/settings/keys";

function setEnv(t: TestContext, key: string, value: string) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

// Route the real node-fetch transport to a local server, exercising HTTP parsing,
// error policy, and stream shutdown without contacting OpenRouter.
async function mockOpenRouter(t: TestContext, reply: (index: number) => { status: number; body: unknown }) {
  setEnv(t, "OPENROUTER_API_KEY", "test-only");
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "log", () => {});
  let calls = 0;
  const server = http.createServer((request, response) => {
    const result = reply(calls++);
    request.resume();
    response.writeHead(result.status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.mock.method(https, "request", (_url: unknown, options: http.RequestOptions) =>
    http.request(`http://127.0.0.1:${address.port}/`, options));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return () => calls;
}

for (const status of [403, 200]) {
  test(`key budget failure propagates and stops queued work (HTTP ${status})`, async t => {
    const calls = await mockOpenRouter(t, () => ({ status, body: { error: { code: 403, message: limitMessage } } }));
    const items = Array.from({ length: 20 }, (_, i) => ({ ...source, id: `hn_${i}` }));
    await assert.rejects(prepareSources(items), error => {
      assert.ok(error instanceof LLMError);
      assert.match(error.message, /OpenRouter 403: Key limit exceeded/);
      assert.equal(error.retryable, false);
      assert.equal(error.attempts, 1);
      return true;
    });
    // Already-started calls drain; further batches must not be attempted.
    assert.ok(calls() >= 1 && calls() <= 8, `Expected at most one concurrent batch, got ${calls()}`);
  });
}

test("key budget failure during context generation cannot become empty context", async t => {
  const success = (content: string) => ({ status: 200, body: { choices: [{ finish_reason: "stop", message: { content } }] } });
  const calls = await mockOpenRouter(t, index => {
    if (index === 0) return success("This article is relevant.");
    if (index === 1) return success("KEEP");
    return { status: 403, body: { error: { code: 403, message: limitMessage } } };
  });
  await assert.rejects(prepareSources([source]), /OpenRouter 403: Key limit exceeded/);
  assert.equal(calls(), 3);
});

test("an unrelated 403 still follows the per-article skip policy", async t => {
  const calls = await mockOpenRouter(t, () => ({
    status: 403, body: { error: { code: 403, message: "Content rejected by moderation" } },
  }));
  await assert.rejects(prepareSources([source]), /no usable selection/);
  assert.equal(calls(), 1);
});

test("empty export preserves every existing file and does not create a fresh output directory", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "wyntn-empty-export-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  setEnv(t, "DB_PATH", path.join(dir, "empty.db"));
  const out = path.join(dir, "published");
  await mkdir(out);
  const files = { "index.json": '[{"day":"2026-10-01"}]\n', "report.json": '{"existing":"report"}\n' };
  for (const [file, data] of Object.entries(files)) await writeFile(path.join(out, file), data);

  await assert.rejects(exportReports(out), /No reports found.*left unchanged/);
  assert.deepEqual((await readdir(out)).sort(), Object.keys(files).sort());
  for (const [file, data] of Object.entries(files)) assert.equal(await readFile(path.join(out, file), "utf8"), data);

  const fresh = path.join(dir, "fresh");
  await assert.rejects(exportReports(fresh), /No reports found/);
  await assert.rejects(access(fresh), { code: "ENOENT" });
});

test("a successful report still exports normally", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "wyntn-valid-export-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  setEnv(t, "DB_PATH", path.join(dir, "report.db"));
  const writer = modelConfig.writers[0];
  const report: DailyReport = {
    generated_at: "2026-10-02T20:00:00Z", model: writer.model, writer,
    run_id: "test-run", pipeline_settings: modelConfig.stages, headline: "Test report",
    narrative_raw: "A report.", narrative_html: "<article><p>A report.</p></article>",
    items: [{ item: source, why: "Relevant.", context: "Background." }],
  };
  const db = new DB();
  await db.open();
  try { db.writeFinalReport(source.day, report); }
  finally { await db.close(); }
  const out = path.join(dir, "published");
  const index = await exportReports(out);
  assert.equal(index.length, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(out, "index.json"), "utf8")), index);
  assert.deepEqual(JSON.parse(await readFile(path.join(out, index[0].reports[0].file), "utf8")), report);
});
