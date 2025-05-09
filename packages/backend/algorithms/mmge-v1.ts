/*  flow-demo-v2.ts – streaming Flow smoke-test
 *  -------------------------------------------------------------------
 *  Pipeline (exercises all stage types):
 *    stream  → index (CPU map)                      [parallel CPU]
 *           → llmFilter (title contains "e")        [parallel LLM]
 *           → llmSelect(3) alphabetic duel          [parallel LLM]
 *           → llmMap summary → string               [parallel LLM]
 *           → collect & print
 *
 *  Shows:
 *    • async input generator (lazy DB fetch)
 *    • per-stage concurrency limits
 *    • pluggable onError hook (best-effort)
 *    • patched llmSelect parallel batches
 *--------------------------------------------------------------------*/

import { DB, NewsItem }          from "@wyntn/common/db";
import { Flow, setLogger }                  from "@wyntn/common/t-flow/flow";
import { ChatMsg }               from "@wyntn/common/t-flow/openrouter";
import { startWsServer } from "../ws-server";


setLogger(
  startWsServer(4000),
  { snapshotMs: 500, ringSize: 15 }
);

/* ---------- config -------------------------------------------------- */
const MODEL              = "openai/gpt-4o";
const MAX_ITEMS          = 20;
const KEEP_THRESHOLD     = 3;
const CPU_CONC           = 6;
const LLM_FILTER_CONC    = 8;
const LLM_SELECT_CONC    = 4;
const LLM_MAP_CONC       = 8;

function todayPhoenix(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Phoenix" })
    .format(new Date())
    .slice(0, 10);
}

/* ---------- prompts ------------------------------------------------- */
// 1) title contains letter "e" / "E"
const containsEPrompt = (item: NewsItem): ChatMsg[] => [
  {
    role: "user",
    content: `Title: "${item.title}"
Respond ONLY with KEEP if the title contains the letter E or e, otherwise SKIP.`,
  },
];

// 2) duel prompt (alphabetic order by title)
const duelPrompt = (a: NewsItem, b: NewsItem): ChatMsg[] => [
  {
    role: "user",
    content: `We have two news items as JSON.

A: ${JSON.stringify(a)}
B: ${JSON.stringify(b)}

Which item's *title* comes first alphabetically?
Respond with EXACTLY the JSON of the winning item. No extra text.`,
  },
];

// 3) one-line summary of the story
const summaryPrompt = (item: NewsItem): ChatMsg[] => [
  {
    role: "user",
    content: `In one short sentence, summarise this tech headline: "${item.title}"`,
  },
];

/* ---------- error collector ---------------------------------------- */
const errors: { err: Error; ctx: unknown }[] = [];
function onError(err: Error, ctx: unknown) {
  errors.push({ err, ctx });
  console.warn("[Flow Error]", err.message, ctx);
}

/* ---------- run ----------------------------------------------------- */
export async function run() {
  const day = todayPhoenix();
  const db  = new DB();
  await db.open();

  const all = await db.getNews(day);
  await db.close();

  if (!all.length) {
    console.log("No news; run pnpm news:fetch first.");
    return;
  }

  async function* newsStream() {
    for (let i = 0; i < Math.min(MAX_ITEMS, all.length); i++) {
      yield all[i];
    }
  }

  console.log(`▶ Flow v2 with ${Math.min(MAX_ITEMS, all.length)} items …`);

  const summaries = await Flow
    .from<NewsItem>(newsStream())
    .withOptions({ onError })

    /* 1 ─ index tag (CPU map) */
    .map((item, _idx) => item, CPU_CONC)   // just demonstrates CPU concurrency

    /* 2 ─ filter titles containing "e" */
    .llmFilter(
      MODEL,
      containsEPrompt,
      { temperature: 0, parse: t => t.trim() === "KEEP" },
      LLM_FILTER_CONC,
    )

    /* 3 ─ select alphabetically earliest 3 */
    .llmSelect(
      KEEP_THRESHOLD,
      MODEL,
      duelPrompt,
      { temperature: 0, response_format:{type:"json_object"}, parse: JSON.parse },
      LLM_SELECT_CONC,
    )

    /* 4 ─ one-line summary */
    .llmMap<string>(
      MODEL,
      summaryPrompt,
      { temperature: 0.3, max_tokens: 40, parse: t => t.trim() },
      LLM_MAP_CONC,
    )
    .run();

  console.log("\n=== FINAL 3 SUMMARIES ===");
  summaries.forEach((s, i) => console.log(`${i + 1}. ${s}`));

  if (errors.length) {
    console.log(`\n⚠️  Encountered ${errors.length} non-fatal errors (logged above).`);
  }
}
