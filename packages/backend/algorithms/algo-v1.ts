/*  algo-wyntn-v0.ts
 *  ------------------------------------------------------------------
 *  end-to-end pipeline:
 *    ─ stream (DB) .................................... async input
 *    ─ why-map              (llmMap) ................... rationale text
 *    ─ judge-filter         (llmFilter) ................ KEEP / SKIP
 *    ─ tournament-top-k    (llmSelect) ................ pair-wise duels
 *    ─ contextualise        (llmMap) ................... add background / links
 *    ─ fold-to-single-string (fold) .................... bullet list
 *    ─ narrativise          (llmMap) ................... cohesive story + “don’t miss”
 *    ─ markup / tagging     (llmMap) ................... HTML-ish output
 *    ─ run()  ➜  [ finalHTML ]
 *  ------------------------------------------------------------------ */

import { DB, NewsItem }          from "@wyntn/common/src/db";
import { Flow, setLogger }       from "@wyntn/common/src/t-flow/flow";
import { ChatMsg }               from "@wyntn/common/src/t-flow/llm";
import { startWsServer }         from "../ws-server";

/* ------------------------------------------------------------------ */
/* Config                                                             */
/* ------------------------------------------------------------------ */
const MODELS        = ["openai/gpt-4o"];
const TOP_K         = 10;
const WHY_CONC      = 8;
const JUDGE_CONC    = 8;
const DUEL_CONC     = 4;
const CTX_CONC      = 8;

setLogger(startWsServer(4000), { snapshotMs: 500 });

/* ------------------------------------------------------------------ */
/* Prompt helpers                                                     */
/* ------------------------------------------------------------------ */

/* 1a — rationale (“why or why not”) */
const whyPrompt = (item: NewsItem): ChatMsg[] => [
  {
    role: "user",
    content:
`Here is a tech/science news item:

Title:  "${item.title}"
Source: ${item.url}

Give a concise sentence *to a software-engineer generalist* explaining
why reading this article might be interesting **or** stating briefly why
it’s probably not worth their time.

Respond with **only** that one or two-sentence rationale.`,
  },
];

/* 1b — judge prompt (KEEP / SKIP) */
const judgePrompt = (rationale: string): ChatMsg[] => [
  {
    role: "user",
    content:
`Below is a rationale.  If it persuades you that the user *should* read
the article, respond exactly KEEP.  Otherwise respond exactly SKIP.

"${rationale}"`,
  },
];

/* 2 — duel prompt for tournament */
interface RationaleItem { item: NewsItem; why: string }
const duelPrompt = (a: RationaleItem, b: RationaleItem): ChatMsg[] => [
  {
    role: "user",
    content:
`You are selecting the more compelling item for a busy engineer.

A) ${a.item.title}
   Why: ${a.why}

B) ${b.item.title}
   Why: ${b.why}

Which would you recommend they read first?
Respond with EXACTLY "A" or "B".`,
  },
];

/* 3 — contextualiser */
interface Enriched extends RationaleItem { context: string; links: string[] }
const ctxPrompt = (ri: RationaleItem): ChatMsg[] => [
  {
    role: "user",
    content:
`Give a *single* background sentence that helps a software-engineer
generalist understand any unfamiliar term or concept in the headline
below, then list up to three authoritative links in Markdown format.

Headline: ${ri.item.title}
Why it matters: ${ri.why}

Respond as JSON with keys:
  - context  (string)
  - links    (array of markdown strings)`,
  },
];

/* 4 — narrative synthesis prompt (takes one big string) */
const narrativePrompt = (bulletList: string): ChatMsg[] => [
  {
    role: "user",
    content:
`Here’s a curated list of today’s most important tech & science news.
Please weave them into a brief, engaging narrative for our daily
“What You Need To Know” column.  End with a short “Don't miss” section
listing the items for skimmers.

Items:
${bulletList}`,
  },
];

/* 5 — markup / tagging prompt */
const markupPrompt = (narrative: string): ChatMsg[] => [
  {
    role: "user",
    content:
`Convert the following narrative into HTML.
 • Wrap each news item title in <strong>.
 • Insert <section> tags for logical breaks.
 • Enclose the “Don't miss” list in <ul><li>.
 • Where you mention an item, wrap it in <span class="ref">...</span> so
   the front-end can attach tootips.

Narrative:
${narrative}`,
  },
];

/* ------------------------------------------------------------------ */
/* Utility                                                             */
/* ------------------------------------------------------------------ */
function todayPhoenix(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Phoenix" })
           .format(new Date()).slice(0, 10);
}

/* bullet-list formatter used by fold() */
function bullet(e: Enriched): string {
  const links = e.links.join(" ");
  return `• **${e.item.title}** — ${e.context}\n  ${links}`;
}

/* ------------------------------------------------------------------ */
/* Main runner for one model                                           */
/* ------------------------------------------------------------------ */
async function runForModel(model: string) {
  const db  = new DB(); await db.open();
  const day = todayPhoenix();
  const raw = await db.getNews(day); await db.close();
  if (!raw.length) { console.log("No news for", day); return; }

  /* ---------- helpers ---------- */
  interface WhyObj   { item: NewsItem; why: string }
  interface Enriched extends WhyObj { context: string; links: string[] }

  const htmlArr = await Flow
    .from<NewsItem>(raw.slice(0, 10))          // safety cap

    /* 1a ─ rationale ------------------------------------------------- */
    .llmMap<WhyObj>(
      whyPrompt,                                // promptFn
      {
        model,
        temperature:  0.4,
        max_tokens:   80,

        /* merge raw string with the source item */
        post: (raw, item) => ({
          item,
          why: raw.trim(),
        }),
      },
      WHY_CONC,
    )

    /* 1b ─ judge   --------------------------------------------------- */
    .llmFilter(
      (o: WhyObj) => judgePrompt(o.why),
      {
        model,
        temperature: 0.0,
        post: raw => raw.trim() === "KEEP",
      },
      JUDGE_CONC,
    )

    /* 2 ─ tournament to TOP_K --------------------------------------- */
    .llmSelect(
      TOP_K,
      (a: WhyObj, b: WhyObj) => duelPrompt(a, b),  // 2nd arg = promptFn
      {
        model,                        // model lives in opts
        temperature: 0.0,
        post: (raw, pair) => raw.trim() === "A" ? pair.a : pair.b,
      },
      DUEL_CONC,
    )


    /* 3 ─ contextualise winners ------------------------------------- */
    .llmMap<Enriched>(
      ctxPrompt,
      {
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        post: (obj, src) => {
          console.log("PRE_OBJECT", obj);
          obj = JSON.parse(obj);
          const { context, links } = obj as { context:string; links:string[] };
          return { ...src, context, links };
        },
      },
    )

    /* 4 ─ fold enriched items → single bullet-list string ----------- */
    .fold(
      "",
      (acc, e) => acc + bullet(e) + "\n\n",
    )

    /* 5 ─ narrative synthesis --------------------------------------- */
    .llmMap<string>(
      narrativePrompt,
      {
        model,
        temperature: 0.7,
        max_tokens:  900,
        post: raw => raw.trim(),
      },
      1,
    )

    /* 6 ─ markup pass ----------------------------------------------- */
    .llmMap<string>(
      markupPrompt,
      {
        model,
        temperature: 0.4,
        max_tokens:  1000,
        post: raw => raw.trim(),
      },
      1,
    )

    .run();

  const finalHTML = htmlArr[0];
  console.log(`\n=== WYNTN OUTPUT for ${model} ===\n`);
  console.log(finalHTML);

  // Persist if desired
  // await db.open(); db.writeReport(day, model, "final", finalHTML); await db.close();
}


/* ------------------------------------------------------------------ */
/* Kick off once per model                                             */
/* ------------------------------------------------------------------ */
export async function run() {
  for (const model of MODELS) {
    try { await runForModel(model); }
    catch (err) { console.error("Pipeline failed for", model, err); }
  }
}

/* If file executed directly ---------------------------------------- */
if (import.meta.url === process.argv[1]) {
  run().then(() => process.exit());
}
