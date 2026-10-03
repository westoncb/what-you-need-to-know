import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { DB } from "@wyntn/common/src/db";
import { run } from "../algorithms/algo-v1";
import { defaultRunOptions, parseRunOptions, reportDate } from "../run-options";
import { startWsServer } from "../ws-server";
import { runPipeline } from "./news-run";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));

test("defaults use the Phoenix date on either side of midnight", () => {
  assert.equal(reportDate(new Date("2026-10-03T06:59:59Z")), "2026-10-02");
  assert.equal(reportDate(new Date("2026-10-03T07:00:00Z")), "2026-10-03");
  assert.deepEqual(defaultRunOptions(new Date("2026-10-03T06:00:00Z")), {
    date: "2026-10-02", limit: 50, observe: false,
  });
});

test("options accept real dates and reject typos and invalid limits", () => {
  assert.deepEqual(parseRunOptions("mmge:run", ["--date", "2024-02-29", "--limit", "5", "--observe"]).options,
    { date: "2024-02-29", limit: 5, observe: true });
  for (const date of ["2025-02-29", "2026-04-31", "2026-13-01", "2026-1-01", "nonsense"]) {
    assert.throws(() => parseRunOptions("news:run", ["--date", date]), /calendar date/);
  }
  for (const limit of ["0", "-1", "1.5", "NaN", "1e3", "9007199254740992"]) {
    assert.throws(() => parseRunOptions("news:run", [`--limit=${limit}`]), /positive integer/);
  }
  assert.throws(() => parseRunOptions("news:run", ["--limt", "5"]), /Unknown option/);
  assert.throws(() => parseRunOptions("news:fetch", ["--limit", "5"]), /Unknown option/);
  assert.throws(() => parseRunOptions("mmge:run", ["extra"]), /Unexpected argument/);
});

test("combined command passes one date and limit through ordered steps", async () => {
  const options = parseRunOptions("news:run", ["--date", "2026-10-02", "--limit", "3"]).options;
  const calls: string[] = [];
  await runPipeline(options, {
    fetch: async input => { assert.equal(input, options); calls.push(`fetch:${input.date}`); },
    generate: async input => { assert.equal(input, options); calls.push(`generate:${input.date}:${input.limit}`); },
    export: async () => { calls.push("export"); return []; },
  });
  assert.deepEqual(calls, ["fetch:2026-10-02", "generate:2026-10-02:3", "export"]);
});

test("combined command never starts later steps after a failure", async () => {
  for (const failing of ["fetch", "generate", "export"]) {
    const calls: string[] = [];
    const step = async (name: string) => {
      calls.push(name);
      if (name === failing) throw new Error(`${name} failed`);
    };
    await assert.rejects(runPipeline(defaultRunOptions(), {
      fetch: () => step("fetch"), generate: () => step("generate"),
      export: async () => { await step("export"); return []; },
    }), new RegExp(`${failing} failed`));
    assert.deepEqual(calls, ["fetch", "generate", "export"].slice(0, ["fetch", "generate", "export"].indexOf(failing) + 1));
  }
});

test("generation uses the requested database date and input limit", async t => {
  t.mock.method(DB.prototype, "open", async () => {});
  t.mock.method(DB.prototype, "close", async () => {});
  const getNews = t.mock.method(DB.prototype, "getNews", () => []);
  await assert.rejects(run({ date: "2024-02-29", limit: 3 }), /No news for 2024-02-29/);
  assert.deepEqual(getNews.mock.calls[0].arguments, ["2024-02-29", 3]);
});

test("observer startup awaits readiness and rejects an occupied port", async () => {
  const logger = await startWsServer(0);
  await logger.close();
  const busy = createServer();
  await new Promise<void>(resolve => busy.listen(0, "127.0.0.1", resolve));
  try {
    const address = busy.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(startWsServer(address.port), { code: "EADDRINUSE" });
  } finally {
    await new Promise<void>((resolve, reject) => busy.close(error => error ? reject(error) : resolve()));
  }
});

test("CLI help and validation have no work side effects; missing news exits nonzero", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wyntn-command-test-"));
  const env = { ...process.env, DB_PATH: path.join(dir, "test.db"), OPENROUTER_API_KEY: "" };
  const cli = (file: string, args: string[]) => exec(process.execPath,
    ["--import", "tsx", `packages/backend/cli/${file}.ts`, ...args],
    { cwd: root, env, timeout: 10_000 });
  try {
    for (const file of ["news-fetch", "mmge-run", "news-run"]) {
      assert.match((await cli(file, ["--help"])).stdout, /Usage: pnpm/);
    }
    await assert.rejects(access(env.DB_PATH), { code: "ENOENT" });
    await assert.rejects(cli("news-run", ["--limit", "0"]), error => {
      assert.equal((error as any).code, 1);
      assert.match((error as any).stderr, /positive integer/);
      assert.doesNotMatch((error as any).stdout, /Starting news fetcher/);
      return true;
    });
    await assert.rejects(cli("mmge-run", ["--date", "2000-01-01", "--limit", "1"]), error => {
      assert.equal((error as any).code, 1);
      assert.match((error as any).stderr, /No news for 2000-01-01/);
      assert.doesNotMatch((error as any).stdout, /Observer dashboard/);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generation needs port 4000 only with --observe and releases it on failure", async t => {
  const busy = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      busy.once("error", reject);
      busy.listen(4000, "127.0.0.1", resolve);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      t.skip("Port 4000 belongs to another running process.");
      return;
    }
    throw error;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "wyntn-observer-test-"));
  const cli = (extra: string[]) => exec(process.execPath,
    ["--import", "tsx", "packages/backend/cli/mmge-run.ts", "--date", "2000-01-01", ...extra],
    { cwd: root, env: { ...process.env, DB_PATH: path.join(dir, "test.db"), OPENROUTER_API_KEY: "", BROWSER: "none" }, timeout: 10_000 });
  try {
    await assert.rejects(cli([]), error => {
      assert.match((error as any).stderr, /No news for 2000-01-01/);
      return true;
    });
    await assert.rejects(cli(["--observe"]), error => {
      assert.equal((error as any).code, 1);
      assert.match((error as any).stderr, /EADDRINUSE/);
      assert.doesNotMatch((error as any).stdout, /Generating reports/);
      return true;
    });
    await new Promise<void>(resolve => busy.close(() => resolve()));
    await assert.rejects(cli(["--observe"]), error => {
      assert.equal((error as any).code, 1);
      assert.match((error as any).stdout, /Observer dashboard: http:\/\/127\.0\.0\.1:/);
      assert.match((error as any).stderr, /No news for 2000-01-01/);
      return true;
    });
    // A subsequent listener can immediately claim the port after CLI cleanup.
    await new Promise<void>((resolve, reject) => {
      busy.once("error", reject);
      busy.listen(4000, "127.0.0.1", resolve);
    });
  } finally {
    if (busy.listening) await new Promise<void>(resolve => busy.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
