import DOMPurify from "dompurify";
import type { ReportIndexEntry, WriterConfig } from "@wyntn/common/src/models";

export function sanitizeReportHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "article", "section", "h1", "h2", "h3", "h4", "h5", "h6",
      "p", "blockquote", "ul", "ol", "li", "span", "div", "hr", "br",
      "strong", "b", "em", "i", "a", "code", "pre", "sup", "sub",
      "table", "thead", "tbody", "tr", "th", "td",
    ],
    ALLOWED_ATTR: ["class", "data-source-id", "href", "title"],
    ALLOW_DATA_ATTR: false,
  });
}

export interface ReportItem {
  id: string;
  src: string;
  title: string;
  url?: string;
  summary: string;
  context: string;
  overview: string;
  why: string;
}

export interface PublishedReport {
  day: string;
  generated_at?: string;
  model: string;
  headline: string;
  narrative_html: string;
  items: ReportItem[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const text = (value: unknown) => typeof value === "string" ? value : "";

export function sourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeReport(value: unknown, day: string): PublishedReport {
  if (!isObject(value) || !text(value.narrative_html).trim() || !Array.isArray(value.items)) {
    throw new Error(`The report for ${day} is incomplete or invalid.`);
  }

  const generatedAt = text(value.generated_at);
  return {
    day,
    generated_at: generatedAt && Number.isFinite(Date.parse(generatedAt)) ? generatedAt : undefined,
    model: text(value.model) || "Unknown model",
    headline: text(value.headline) || "Tech & Research",
    narrative_html: text(value.narrative_html),
    items: value.items.map((entry, index) => {
      if (!isObject(entry)) throw new Error(`The report for ${day} has an invalid source item.`);
      // Existing exports wrap the source under `item`; also accept flat reports.
      const item = isObject(entry.item) ? entry.item : entry;
      return {
        id: text(item.id) || `source-${index}`,
        src: text(item.src),
        title: text(item.title) || "Untitled source",
        url: sourceUrl(item.url),
        summary: text(item.summary),
        context: text(entry.context),
        overview: text(entry.overview),
        why: text(entry.why),
      };
    }),
  };
}

export async function loadReportIndex(
  baseUrl: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ReportIndexEntry[]> {
  const response = await fetcher(`${baseUrl}data/index.json`, { signal, cache: "no-cache" });
  if (!response.ok) throw new Error(`Could not load the report index (HTTP ${response.status}).`);
  const index: unknown = await response.json();
  if (!Array.isArray(index) || index.some(entry =>
    !isObject(entry) || typeof entry.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.day) ||
    !Array.isArray(entry.reports) || entry.reports.some(report =>
      !isObject(report) || !text(report.model) || typeof report.file !== "string" ||
      !new RegExp(`^${entry.day}/[a-z0-9-]+\\.json$`).test(report.file) ||
      (report.writerId !== undefined && (typeof report.writerId !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(report.writerId)))
    )
  )) throw new Error("The report index has an invalid format.");
  return (index as ReportIndexEntry[]).sort((a, b) => b.day.localeCompare(a.day));
}

export async function loadWriterReport(
  baseUrl: string,
  day: ReportIndexEntry,
  writer: WriterConfig,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<PublishedReport | null> {
  const entry = day.reports.find(report => report.writerId === writer.id) ??
    day.reports.find(report => !report.writerId && report.model === writer.model);
  if (!entry) return null;

  const response = await fetcher(`${baseUrl}data/${entry.file}`, { signal, cache: "no-cache" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not load ${writer.name}'s report (HTTP ${response.status}).`);
  const data: unknown = await response.json();
  if (!isObject(data) || data.model !== entry.model ||
      (entry.writerId && (!isObject(data.writer) || data.writer.id !== entry.writerId))) {
    throw new Error("This report does not match its index entry.");
  }
  return normalizeReport(data, day.day);
}
