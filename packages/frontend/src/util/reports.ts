import DOMPurify from "dompurify";

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

export async function loadLatestReport(
  baseUrl: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<PublishedReport | null> {
  const indexResponse = await fetcher(`${baseUrl}data/index.json`, { signal, cache: "no-cache" });
  if (!indexResponse.ok) throw new Error(`Could not load the report index (HTTP ${indexResponse.status}).`);
  let index: unknown;
  try {
    index = await indexResponse.json();
  } catch {
    throw new Error("The report index is not valid JSON.");
  }
  if (!Array.isArray(index) || index.some(entry =>
    !isObject(entry) || typeof entry.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.day)
  )) {
    throw new Error("The report index has an invalid format.");
  }

  const days = [...new Set(index.map(entry => entry.day as string))].sort().reverse();
  if (!days.length) return null;

  for (const day of days) {
    const response = await fetcher(`${baseUrl}data/${day}.json`, { signal, cache: "no-cache" });
    // An older valid report is still useful if a newer export was removed.
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`Could not load the report for ${day} (HTTP ${response.status}).`);
    let report: unknown;
    try {
      report = await response.json();
    } catch {
      throw new Error(`The report for ${day} is not valid JSON.`);
    }
    return normalizeReport(report, day);
  }
  throw new Error("The report index lists reports that are no longer available.");
}
