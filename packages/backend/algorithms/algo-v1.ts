import { DB, type NewsItem, type DailyReport } from "@wyntn/common/src/db";
import { Flow, SKIP, InvalidResponseError, LLMError } from "@wyntn/common/src/t-flow/flow";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
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

// Retrying other items/writers cannot repair a missing key, rejected credentials,
// or exhausted credit. A retryable 402 is an in-flight budget limit, not exhaustion.
function isSharedBlocker(error: unknown): boolean {
  if (!(error instanceof LLMError)) return false;
  // OpenRouter may put a numeric error code in an HTTP 200 envelope.
  const status = typeof error.code === "number" ? error.code : error.status;
  return error.kind === "configuration" || status === 401 ||
    (status === 402 && !error.retryable);
}

function requireText(raw: string): string {
  const text = raw.trim();
  if (!text) throw new InvalidResponseError("Expected nonempty text.");
  return text;
}

function validateSources(items: Enriched[]): void {
  if (!items.length || items.some(source =>
    !source?.item?.id?.trim() || !source.item.title?.trim() ||
    !source.item.url?.trim() || !source.why?.trim() || !source.overview?.trim() ||
    typeof source.context !== "string"
  )) {
    throw new Error("Shared source preparation produced no usable selection or incomplete source data.");
  }
}

function parseMarkup(raw: string, items: Enriched[]): string {
  const html = requireText(raw);
  // Parsing alone repairs truncated HTML; require the complete wrapper too.
  if (!/^<article\b[\s\S]*<\/article>$/i.test(html)) {
    throw new InvalidResponseError("Expected a complete <article> HTML fragment without code fences.");
  }
  const fragment = JSDOM.fragment(html);
  // These nodes do not supply article text after the frontend sanitizes it.
  fragment.querySelectorAll("script, style, template").forEach(node => node.remove());
  const article = fragment.querySelector("article.content-piece");
  if (fragment.children.length !== 1 || !article || article !== fragment.firstElementChild ||
      !Array.from(article.querySelectorAll("p")).some(p => p.textContent?.trim())) {
    throw new InvalidResponseError("Expected an article.content-piece containing readable paragraphs.");
  }
  const ids = new Set(items.map(source => source.item.id));
  if (Array.from(article.querySelectorAll("[data-source-id]")).some(el =>
    !ids.has(el.getAttribute("data-source-id")!)
  )) {
    throw new InvalidResponseError("HTML refers to an unknown source ID.");
  }
  return html;
}

/* bullet-list formatter used by fold() */
function bullet(e: Enriched): string {
  return `• **Title: ${e.item.title}**\n<extract>${e.item.summary}</extract>\n\n`;
}

/* internal accumulator while folding */
interface BuildCtx {
  bullets : string;        // for narrative prompt
  report  : DailyReport;
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
      narrative_raw: "",
      items        : structuredClone(items),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Shared preparation: performed once for all writers                  */
/* ------------------------------------------------------------------ */
export async function prepareSources(raw: NewsItem[]): Promise<Enriched[]> {
  const counts = {
    rationaleSkipped: 0, judgmentSkipped: 0, overviewSkipped: 0,
    relevanceRejected: 0, selectionFallbacks: 0, contextUnavailable: 0,
  };
  const recover = (error: LLMError, counter: keyof typeof counts) => {
    if (isSharedBlocker(error)) throw error;
    counts[counter]++;
  };
  let selected = 0;
  try {
    const items = await Flow
    .from<NewsItem>(raw, { onError: error => console.warn(`[Source preparation] ${error.message}`) })

    /* 1a ─ rationale ------------------------------------------------- */
    .llmMap<WhyObj>(
      whyPrompt,
      {
        ...stages.readingRationale,

        /* merge raw string with the source item */
        post: (raw, item) => ({
          item,
          why: requireText(raw),
        }),
        onFailure: error => { recover(error, "rationaleSkipped"); return SKIP; },
      },
      DEFAULT_CONCURRENCY,
    )

    /* 1b ─ judge   --------------------------------------------------- */
    .llmFilter(
      (o: WhyObj) => judgePrompt(o.why),
      {
        ...stages.relevanceJudge,
        post: raw => {
          const verdict = raw.trim();
          if (verdict !== "KEEP" && verdict !== "SKIP") {
            throw new InvalidResponseError("Expected exactly KEEP or SKIP.");
          }
          if (verdict === "SKIP") counts.relevanceRejected++;
          return verdict === "KEEP";
        },
        onFailure: error => { recover(error, "judgmentSkipped"); return SKIP; },
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
          overview: requireText(raw),
        }),
        onFailure: error => { recover(error, "overviewSkipped"); return SKIP; },
      },
      DEFAULT_CONCURRENCY,
    )

    /* 2 ─ tournament to TOP_K --------------------------------------- */
    .llmSelect(
      TOP_K,
      (a: EnhancedItem, b: EnhancedItem) => duelPrompt(a, b),
      {
        ...stages.articleSelection,
        post: (raw, pair) => {
          const verdict = raw.trim();
          if (verdict !== "A" && verdict !== "B") {
            throw new InvalidResponseError("Expected exactly A or B.");
          }
          return verdict === "A" ? pair.a : pair.b;
        },
        onFailure: (error, pair) => { recover(error, "selectionFallbacks"); return pair.a; },
      },
      DUEL_CONC,
    )


    /* 3 ─ contextualise winners ------------------------------------- */
    .llmMap<Enriched>(
      ctxPrompt,
      {
        ...stages.backgroundContext,
        post: (raw, src) => {
          let parsed: unknown;
          try { parsed = JSON.parse(raw); }
          catch (error) { throw new InvalidResponseError("Expected context JSON.", error); }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
              !("context" in parsed) || typeof parsed.context !== "string") {
            throw new InvalidResponseError("Expected an object with a context string.");
          }
          return { ...src, context: requireText(parsed.context) };
        },
        onFailure: (error, src) => {
          recover(error, "contextUnavailable");
          return { ...src, context: "" };
        },
      },
    )

    .run();
    selected = items.length;
    validateSources(items);
    return items;
  } finally {
    console.log("Source preparation:", { inputs: raw.length, selected, ...counts });
  }
}

/* Each writer receives a fresh report object built from the same inputs. */
export async function writeArticle(writer: WriterConfig, runId: string, items: Enriched[]): Promise<DailyReport> {
  validateSources(items);
  const { id, name, ...settings } = writer;
  const reportArr = await Flow.from([makeSeed(writer, runId, items)])
      /* ---- stage-5: narrative (plain prose) -------------------- */
      .llmMap<BuildCtx>(
        obj => makeNarrativePrompt(writer.model)(obj.bullets),
        {
          ...settings,
          post : (raw, obj) => {
            return { ...obj, report: { ...obj.report, narrative_raw: requireText(raw) } };
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
            return { ...obj, report: { ...obj.report, narrative_html: parseMarkup(raw, obj.report.items) } };
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
  let raw: NewsItem[];
  try { raw = db.getNews(day, 50); }
  finally { await db.close(); }
  if (!raw.length) throw new Error(`No news for ${day}; run news:fetch first.`);

  const items = await prepareSources(raw);
  const runId = randomUUID();
  const failed: string[] = [];
  for (const writer of modelConfig.writers) {
    let report: DailyReport;
    try {
      report = await writeArticle(writer, runId, items);
    } catch (error) {
      if (isSharedBlocker(error)) throw error;
      failed.push(writer.name);
      console.error(`Article generation failed for ${writer.name}:`, error);
      continue;
    }
    // Storage failures stop the run; they are not writer-specific LLM failures.
    await db.open();
    try {
      db.writeFinalReport(day, report);
    } finally {
      await db.close();
    }
    console.log(`Saved ${day} report by ${writer.name} (${writer.model}).`);
  }
  if (failed.length) throw new Error(`Failed writers: ${failed.join(", ")}`);
}
