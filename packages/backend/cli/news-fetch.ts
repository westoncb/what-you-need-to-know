import { DB, NewsItem } from "@wyntn/common/src/db";
import { XMLParser } from "fast-xml-parser";
import fetch from "node-fetch";
import { ContentExtractor } from "../utils/content-extractor";
import { defaultRunOptions, REPORT_TIME_ZONE, type GenerationOptions } from "../run-options";
import { isMain, runCommand } from "./command";

interface HNSearchResponse {
  hits: Array<{
    objectID: string;
    title?: string;
    url?: string;
    story_text?: string;
  }>;
}

/* ---------- Helpers ---------------------------------------------- */

function toNewsItemHN(hit: any, day: string, extractedContent?: string): NewsItem {
  return {
    id: `hn_${hit.objectID}`,
    src: "hn",
    day,
    title: hit.title ?? "",
    url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
    // Check for both existence AND non-emptiness of story_text
    summary: (hit.story_text && hit.story_text.trim().length > 0)
      ? hit.story_text
      : extractedContent || "",
  };
}

function toNewsItemArxiv(entry: any, day: string): NewsItem {
  const arxivId = (entry.id as string).match(/\/(\d+\.\d+)/)?.[1] ?? entry.id;
  return {
    id: `arxiv_${arxivId}`,
    src: "arxiv",
    day,
    title: (entry.title as string).trim().replace(/\s+/g, " "),
    url: entry.id,
    summary: (entry.summary as string).trim(),
  };
}

/* ---------- Fetchers --------------------------------------------- */

async function fetchHN(day: string): Promise<NewsItem[]> {
  console.log("Fetching HN stories...");
  const url =
    "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=50";
  const json: HNSearchResponse = await fetch(url).then((r) => r.json());

  // Create our content extractor instance
  const extractor = new ContentExtractor({
    maxContentLength: 8000, // Allow slightly longer content than default
    fetchTimeoutMs: 15000,  // Longer timeout for slow sites
  });

  // Process each HN item with content extraction, with concurrency limit
  const results = [];
  const concurrencyLimit = 3; // Process 3 URLs at a time (more conservative)
  let processed = 0;

  console.log(`Found ${json.hits.length} HN stories, extracting content...`);

  // Process in batches to avoid too many simultaneous connections
  for (let i = 0; i < json.hits.length; i += concurrencyLimit) {
    const batch = json.hits.slice(i, i + concurrencyLimit);
    const batchPromises = batch.map(async (hit) => {
      // Always try to extract content if there's a URL
      let extractedContent = '';

      try {
        if (hit.url) {
          // Log if we're processing a story with text
          const hasStoryText = hit.story_text && hit.story_text.trim().length > 0;
          if (hasStoryText) {
            console.log(`Story ${hit.objectID} already has text (${hit.story_text.length} chars), but extracting from URL anyway as backup`);
          }

          const content = await extractor.extract(hit.url);
          extractedContent = content?.text || '';

          // Log extraction results
          if (extractedContent) {
            console.log(`Successfully extracted ${extractedContent.length} chars from ${hit.url}`);
          } else {
            console.log(`Could not extract content from ${hit.url}`);
          }
        }
      } catch (error) {
        console.error(`Error processing ${hit.url}: ${error.message}`);
      }

      processed++;
      if (processed % 5 === 0) {
        console.log(`Processed ${processed}/${json.hits.length} stories...`);
      }

      return toNewsItemHN(hit, day, extractedContent);
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Small delay between batches to be nice to servers
    if (i + concurrencyLimit < json.hits.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return results;
}

async function fetchArxiv(day: string): Promise<NewsItem[]> {
  console.log("Fetching arXiv papers...");
  const feedUrl =
    "https://export.arxiv.org/api/query?search_query=cat:cs*&start=0&max_results=100&sortBy=submittedDate&sortOrder=descending";
  const xml = await fetch(feedUrl).then((r) => r.text());
  const parser = new XMLParser({ ignoreAttributes: false, isArray: (n) => n === "entry" });
  const obj = parser.parse(xml);
  const entries = obj.feed.entry ?? [];

  // Use a 24-hour window instead of midnight cutoff
  const now = new Date();
  const oneDayAgo = new Date(now);
  oneDayAgo.setHours(now.getHours() - 24);

  console.log(`Retrieved ${entries.length} abstracts from Arxiv.`);

  // console.log(`Filtering for papers published after: ${oneDayAgo.toISOString()}`);

  return entries
    // .filter((e: any) => {
    //   const pubDate = new Date(e.published);
    //   return pubDate >= oneDayAgo;
    // })
    .map((e: any) => toNewsItemArxiv(e, day));
}

/* ---------- CLI --------------------------------------------------- */

export async function fetchNews({ date: day }: Pick<GenerationOptions, "date"> = defaultRunOptions()) {
  console.log("Starting news fetcher...");
  console.log(`📅 Fetching current news into ${day} (${REPORT_TIME_ZONE})`);

  const [hnItems, arxivItems] = await Promise.all([
    fetchHN(day),
    fetchArxiv(day),
  ]);

  console.log(`Found ${hnItems.length} HN items and ${arxivItems.length} arXiv items`);

  // Log summary content length statistics
  const hnContentStats = hnItems.map(item => item.summary?.length || 0);
  const avgHnContentLength = hnContentStats.reduce((a, b) => a + b, 0) / hnContentStats.length || 0;
  console.log(`Average HN content length: ${Math.round(avgHnContentLength)} characters`);

  // Show how many items have substantial content
  const itemsWithContent = hnItems.filter(item => item.summary?.length > 200).length;
  console.log(`HN items with substantial content: ${itemsWithContent}/${hnItems.length}`);

  // Detailed content analysis
  console.log("\nDetailed content analysis:");
  hnItems.forEach((item, index) => {
    console.log(`[${index + 1}] ID: ${item.id} | URL: ${item.url.substring(0, 50)}${item.url.length > 50 ? '...' : ''}`);
    console.log(`    Title: ${item.title.substring(0, 50)}${item.title.length > 50 ? '...' : ''}`);
    console.log(`    Summary length: ${item.summary?.length || 0} chars`);
    if (item.summary?.length === 0) {
      console.log(`    WARNING: No content extracted for this item!`);
    }
    console.log(``);
  });

  const db = new DB();
  await db.open();

  console.log("Storing items in database...");
  for (const item of hnItems) await db.upsertNews(item);
  for (const item of arxivItems) await db.upsertNews(item);

  await db.close();

  console.log(
    `✅ Stored ${hnItems.length} HN & ${arxivItems.length} arXiv items in SQLite`,
  );
}

if (isMain(import.meta.url)) void runCommand("news:fetch", fetchNews);
