import { DB, NewsItem, DailyReport }          from "@wyntn/common/src/db";
import { Flow, setLogger }       from "@wyntn/common/src/t-flow/flow";
import { startWsServer }         from "../ws-server";
import {WhyObj, Enriched, EnhancedItem,
  whyPrompt, judgePrompt, duelPrompt,
  makeNarrativePrompt, overviewPrompt,
  ctxPrompt, markupPrompt} from './prompts'

/* ------------------------------------------------------------------ */
/* Config                                                             */
/* ------------------------------------------------------------------ */
const MODELS = ["openai/gpt-4.1"];
const TOP_K         = 8;
const DEFAULT_CONCURRENCY      = 4;
const JUDGE_CONC    = 4;
const DUEL_CONC     = 4;

setLogger(startWsServer(4000), { snapshotMs: 500 });

/* ------------------------------------------------------------------ */
/* Utility                                                             */
/* ------------------------------------------------------------------ */
function todayPhoenix(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Phoenix" })
           .format(new Date()).slice(0, 10);
}

/* bullet-list formatter used by fold() */
function bullet(e: Enriched): string {
  return `• **${e.item.title}**\n\n — <extract>${e.item.summary}</extract>`;
}

/* internal accumulator while folding */
interface BuildCtx {
  bullets : string;        // for narrative prompt
  report  : DailyReport;   // is gradually filled
}

function makeSeed(model: string): BuildCtx {
  return {
    bullets : "",
    report  : {
      generated_at : new Date().toISOString(),
      model,
      headline     : "Today in Tech & Research",
      narrative_html: "",
      items        : [],
    },
  };
}

/* ------------------------------------------------------------------ */
/* Main runner for one model                                           */
/* ------------------------------------------------------------------ */
async function runForModel(model: string) {
  const db  = new DB(); await db.open();
  const day = todayPhoenix();
  const raw = await db.getNews(day, 80); await db.close();
  if (!raw.length) { console.log("No news for", day); return; }

  const reportArr = await Flow
    .from<NewsItem>(raw)

    /* 1a ─ rationale ------------------------------------------------- */
    .llmMap<WhyObj>(
      whyPrompt,
      {
        model,
        temperature:  0.4,
        max_tokens: 800,

        /* merge raw string with the source item */
        post: (raw, item) => ({
          item,
          why: raw.trim(),
        }),
      },
      DEFAULT_CONCURRENCY,
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

    /* 1c ─ overview synthesis --------------------------------------- */
    .llmMap<EnhancedItem>(
      overviewPrompt,
      {
        model,
        temperature: 0.4,
        max_tokens: 1000,
        post: (raw, item) => ({
          ...item,
          overview: raw.trim(),
        }),
      },
      DEFAULT_CONCURRENCY,
    )

    /* 2 ─ tournament to TOP_K --------------------------------------- */
    .llmSelect(
      TOP_K,
      (a: EnhancedItem, b: EnhancedItem) => duelPrompt(a, b),
      {
        model,
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
        max_tokens : 600,
        response_format: { type: "json_object" },
        post: (raw, src) => {
          const { context } = JSON.parse(raw) as { context: string };
          return { ...src, context };          // keep Enriched shape
        },
      },
    )

    /* ---- fold: build bullets + items ------------------------- */
    .fold<BuildCtx>(makeSeed(model), (ctx, item) => {
      ctx.bullets += bullet(item) + "\n\n";     // narrative input
      ctx.report.items.push(item);              // full Enriched incl. card_html
      return ctx;
    })

      /* ---- stage-5: narrative (plain prose) -------------------- */
      .llmMap<BuildCtx>(
        obj => makeNarrativePrompt(model)(obj.bullets),   // reuse your fn
        {
          model : "anthropic/claude-3.7-sonnet",
          temperature : 0.7,
          post : (raw, obj) => {
            obj.report.narrative_raw = raw.trim();
            return obj;           // keep flowing same BuildCtx
          },
        },
        1,
      )

      /* ---- stage-6: markup (HTML/CSS) -------------------------- */
      .llmMap<BuildCtx>(
        obj => markupPrompt(obj.report.narrative_raw),    // you’ll write this
        {
          model,
          temperature : 0.4,
          max_tokens  : 3000,
          post : (raw, obj) => {
            obj.report.narrative_html = raw.trim();
            return obj;
          },
        },
        1,
      )

      .run();

  const report = reportArr[0].report;
  console.log(`\n=== WYNTN OUTPUT for ${model} ===\n`);
  console.log(report.narrative_html);

  await db.open();
  await db.writeFinalReport(day, model, report);   // new helper
  await db.close();

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
