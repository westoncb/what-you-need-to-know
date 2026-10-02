import { DB, type NewsItem, type DailyReport } from "@wyntn/common/src/db";
import { Flow } from "@wyntn/common/src/t-flow/flow";
import { randomUUID } from "node:crypto";
import { modelConfig, type WriterConfig } from "@wyntn/common/src/models";
import {WhyObj, Enriched, EnhancedItem,
  whyPrompt, judgePrompt, duelPrompt,
  makeNarrativePrompt, overviewPrompt,
  ctxPrompt, markupPrompt} from './prompts'

/* ------------------------------------------------------------------ */
/* Config                                                             */
/* ------------------------------------------------------------------ */
const TOP_K         = 8;
const DEFAULT_CONCURRENCY      = 8;
const JUDGE_CONC    = 8;
const DUEL_CONC     = 4;

const { stages } = modelConfig;

/* ------------------------------------------------------------------ */
/* Utility                                                             */
/* ------------------------------------------------------------------ */
function todayPhoenix(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Phoenix" })
           .format(new Date()).slice(0, 10);
}

/* bullet-list formatter used by fold() */
function bullet(e: Enriched): string {
  return `• **Title: ${e.item.title}**\n<extract>${e.item.summary}</extract>\n\n`;
}

/* internal accumulator while folding */
type WriterReport = DailyReport & { writer: WriterConfig; run_id: string };

interface BuildCtx {
  bullets : string;        // for narrative prompt
  report  : WriterReport;
}

function makeSeed(writer: WriterConfig, runId: string, items: Enriched[]): BuildCtx {
  return {
    bullets : items.map(item => bullet(item) + "\n\n").join(""),
    report  : {
      generated_at : new Date().toISOString(),
      model: writer.model,
      writer: { ...writer },
      run_id: runId,
      pipeline_settings: structuredClone(stages),
      headline     : "Today in Tech & Research",
      narrative_html: "",
      items        : structuredClone(items),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Shared preparation: performed once for all writers                  */
/* ------------------------------------------------------------------ */
export async function prepareSources(raw: NewsItem[]): Promise<Enriched[]> {
  return Flow
    .from<NewsItem>(raw)

    /* 1a ─ rationale ------------------------------------------------- */
    .llmMap<WhyObj>(
      whyPrompt,
      {
        ...stages.readingRationale,

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
        ...stages.relevanceJudge,
        post: raw => raw.trim() === "KEEP",
      },
      JUDGE_CONC,
    )

    /* 1c ─ overview synthesis --------------------------------------- */
    .llmMap<EnhancedItem>(
      overviewPrompt,
      {
        ...stages.sourceOverview,
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
        ...stages.articleSelection,
        post: (raw, pair) => raw.trim() === "A" ? pair.a : pair.b,
      },
      DUEL_CONC,
    )


    /* 3 ─ contextualise winners ------------------------------------- */
    .llmMap<Enriched>(
      ctxPrompt,
      {
        ...stages.backgroundContext,
        post: (raw, src) => {
          const { context } = JSON.parse(raw) as { context: string };
          return { ...src, context };          // keep Enriched shape
        },
      },
    )

    .run();
}

/* Each writer receives a fresh report object built from the same inputs. */
export async function writeArticle(writer: WriterConfig, runId: string, items: Enriched[]): Promise<WriterReport> {
  const { id, name, ...settings } = writer;
  const reportArr = await Flow.from([makeSeed(writer, runId, items)])
      /* ---- stage-5: narrative (plain prose) -------------------- */
      .llmMap<BuildCtx>(
        obj => makeNarrativePrompt(writer.model)(obj.bullets),
        {
          ...settings,
          post : (raw, obj) => {
            obj.report.narrative_raw = raw.trim();
            return obj;
          },
        },
        1,
      )

      /* ---- stage-6: markup (HTML/CSS) -------------------------- */
      .llmMap<BuildCtx>(
        obj => markupPrompt(obj.report.narrative_raw, obj.report.items),
        {
          ...stages.htmlFormatting,
          post : (raw, obj) => {
            obj.report.narrative_html = raw.trim();
            return obj;
          },
        },
        1,
      )

      .run();

  const report = reportArr[0]?.report;
  if (!report?.narrative_raw?.trim() || !report.narrative_html?.trim()) {
    throw new Error(`Article generation failed for ${writer.name}.`);
  }
  return report;
}

export async function run() {
  const db = new DB();
  await db.open();
  const day = todayPhoenix();
  const raw = db.getNews(day, 50);
  await db.close();
  if (!raw.length) throw new Error(`No news for ${day}; run news:fetch first.`);

  const items = await prepareSources(raw);
  if (!items.length || items.some(item => !item?.item || typeof item.context !== "string")) {
    throw new Error("Shared source preparation produced no usable selection.");
  }
  const runId = randomUUID();
  const failed: string[] = [];
  for (const writer of modelConfig.writers) {
    try {
      const report = await writeArticle(writer, runId, items);
      await db.open();
      try {
        db.writeFinalReport(day, report);
      } finally {
        await db.close();
      }
      console.log(`Saved ${day} report by ${writer.name} (${writer.model}).`);
    } catch (error) {
      failed.push(writer.name);
      console.error(`Article generation failed for ${writer.name}:`, error);
    }
  }
  if (failed.length) throw new Error(`Failed writers: ${failed.join(", ")}`);
}
