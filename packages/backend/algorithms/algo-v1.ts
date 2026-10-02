import { DB, type NewsItem, type DailyReport } from "@wyntn/common/src/db";
import { Flow, SKIP, InvalidResponseError, LLMError } from "@wyntn/common/src/t-flow/flow";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import { modelConfig, type WriterConfig } from "@wyntn/common/src/models";
import { type RationaleItem, type Enriched, type WrittenArticle,
  whyPrompt, judgePrompt, duelPrompt, makeNarrativePrompt,
  ctxPrompt, markupPrompt } from "./prompts";

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
    !source.item.url?.trim() || !source.item.summary?.trim() ||
    typeof source.why !== "string" || typeof source.context !== "string"
  )) {
    throw new Error("Shared source preparation produced no usable selection or incomplete source data.");
  }
}

function parseObject(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new InvalidResponseError("Expected a JSON object.", error); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidResponseError("Expected a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function parseParagraphs(value: unknown, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) ||
      value.some(p => typeof p !== "string" || !p.trim())) {
    throw new InvalidResponseError("Expected an array of nonempty paragraphs.");
  }
  return value.map(p => p.trim());
}

function parseNarrative(raw: string, items: Enriched[]): WrittenArticle {
  const parsed = parseObject(raw);
  const intro = parseParagraphs(parsed.intro, true);
  if (!Array.isArray(parsed.sections) || parsed.sections.length !== items.length) {
    throw new InvalidResponseError("Expected exactly one article section per selected source.");
  }
  const sections = parsed.sections.map((section, index) => {
    if (!section || typeof section !== "object" || Array.isArray(section) ||
        section.source_id !== items[index].item.id ||
        typeof section.heading !== "string" || !section.heading.trim()) {
      throw new InvalidResponseError("Expected ordered source IDs and a heading for every section.");
    }
    return {
      source_id: section.source_id as string,
      heading: section.heading.trim(),
      paragraphs: parseParagraphs(section.paragraphs),
    };
  });
  return { intro, sections };
}

function articleText(document: WrittenArticle): string {
  return [...document.intro, ...document.sections.flatMap(s => [s.heading, ...s.paragraphs])].join("\n\n");
}

function parseMarkup(raw: string, document: WrittenArticle): string {
  const html = requireText(raw);
  if (!/^<article\b[\s\S]*<\/article>$/i.test(html)) {
    throw new InvalidResponseError("Expected a complete <article> HTML fragment without code fences.");
  }
  const fragment = JSDOM.fragment(html);
  const invalid = () => { throw new InvalidResponseError("HTML must preserve the writer's exact paragraphs, headings, order, and source IDs."); };
  // Require explicit blocks: unwrapped text/comments would evade paragraph checks.
  function children(node: ParentNode): Element[] {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== 1 && !(child.nodeType === 3 && !child.textContent?.trim())) invalid();
    }
    return Array.from(node.children);
  }
  const roots = children(fragment);
  const article = roots[0];
  if (roots.length !== 1 || article?.tagName !== "ARTICLE" || article.className !== "content-piece") invalid();
  const allowedClasses: Record<string, string[]> = {
    ARTICLE: ["content-piece"], SECTION: ["content-section"], H2: ["section-heading"],
    P: ["", "intro", "emphasis"], SPAN: ["highlight"], STRONG: [""], EM: [""],
    CODE: [""], SUP: [""], SUB: [""],
  };
  for (const el of [article, ...Array.from(article.querySelectorAll("*"))]) {
    if (!allowedClasses[el.tagName]?.includes(el.className) ||
        Array.from(el.attributes).some(attr => attr.name !== "class" &&
          !(el.tagName === "SECTION" && attr.name === "data-source-id"))) invalid();
  }
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  function block(el: Element | undefined, tag: string, expected: string) {
    if (!el || el.tagName !== tag || normalize(el.textContent ?? "") !== normalize(expected)) invalid();
    // Only text and inline emphasis may occur within a paragraph/heading.
    for (const descendant of Array.from(el!.querySelectorAll("*"))) {
      if (!["STRONG", "EM", "CODE", "SUP", "SUB", "SPAN"].includes(descendant.tagName)) invalid();
    }
  }
  const blocks = children(article);
  if (blocks.length !== document.intro.length + document.sections.length) invalid();
  document.intro.forEach((paragraph, index) => {
    block(blocks[index], "P", paragraph);
    if (blocks[index].className !== "intro") invalid();
  });
  document.sections.forEach((source, index) => {
    const section = blocks[document.intro.length + index];
    if (section.tagName !== "SECTION" || section.className !== "content-section" ||
        section.getAttribute("data-source-id") !== source.source_id) invalid();
    const parts = children(section);
    if (parts.length !== 1 + source.paragraphs.length) invalid();
    block(parts[0], "H2", source.heading);
    source.paragraphs.forEach((paragraph, i) => {
      block(parts[i + 1], "P", paragraph);
      if (parts[i + 1].className === "intro") invalid();
    });
  });
  return html;
}

/* internal accumulator while folding */
interface BuildCtx {
  document: WrittenArticle;
  report  : DailyReport;
}

function makeSeed(writer: WriterConfig, runId: string, items: Enriched[]): BuildCtx {
  return {
    document: { intro: [], sections: [] },
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
    emptySourceSkipped: 0, rationaleSkipped: 0,
    relevanceRejected: 0, contextUnavailable: 0,
  };
  const recover = (error: LLMError, counter: keyof typeof counts) => {
    if (isSharedBlocker(error)) throw error;
    counts[counter]++;
  };
  let selected = 0;
  try {
    const items = await Flow
    .from<NewsItem>(raw, { onError: error => console.warn(`[Source preparation] ${error.message}`) })

    // A title alone is insufficient evidence for a detailed article.
    .filter(item => {
      if (item.summary.trim()) return true;
      counts.emptySourceSkipped++;
      return false;
    })

    /* 1a ─ rationale ------------------------------------------------- */
    .llmMap<RationaleItem>(
      whyPrompt,
      {
        ...stages.readingRationale,

        /* merge raw string with the source item */
        post: (raw, item) => ({
          item,
          rationale: requireText(raw),
        }),
        onFailure: error => { recover(error, "rationaleSkipped"); return SKIP; },
      },
      DEFAULT_CONCURRENCY,
    )

    /* 1b ─ judge   --------------------------------------------------- */
    .llmFilter(
      judgePrompt,
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
      },
      JUDGE_CONC,
    )

    /* 2 ─ tournament to TOP_K --------------------------------------- */
    .llmSelect(
      TOP_K,
      duelPrompt,
      {
        ...stages.articleSelection,
        post: (raw, pair) => {
          const verdict = raw.trim();
          if (verdict !== "A" && verdict !== "B") {
            throw new InvalidResponseError("Expected exactly A or B.");
          }
          return verdict === "A" ? pair.a : pair.b;
        },
      },
      DUEL_CONC,
    )


    /* 3 ─ contextualise winners ------------------------------------- */
    .llmMap<Enriched>(
      ctxPrompt,
      {
        ...stages.backgroundContext,
        post: (raw, src) => {
          const parsed = parseObject(raw);
          if (typeof parsed.context !== "string" || typeof parsed.why !== "string") {
            throw new InvalidResponseError("Expected context and why strings.");
          }
          // Explicit projection keeps the private rationale out of published data.
          return { item: src.item, context: requireText(parsed.context), why: requireText(parsed.why) };
        },
        onFailure: (error, src) => {
          recover(error, "contextUnavailable");
          return { item: src.item, why: "", context: "" };
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
      /* ---- independent article writing ----------------------- */
      .llmMap<BuildCtx>(
        obj => makeNarrativePrompt(writer.model)(obj.report.items),
        {
          ...settings,
          // The envelope is a pipeline contract, independent of writer settings.
          response_format: { type: "json_object" },
          post : (raw, obj) => {
            const document = parseNarrative(raw, obj.report.items);
            return { ...obj, document, report: { ...obj.report, narrative_raw: articleText(document) } };
          },
        },
        1,
      )

      /* ---- shared formatting model, called for each article --- */
      .llmMap<BuildCtx>(
        obj => markupPrompt(obj.document),
        {
          ...stages.htmlFormatting,
          post : (raw, obj) => {
            return { ...obj, report: { ...obj.report, narrative_html: parseMarkup(raw, obj.document) } };
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
