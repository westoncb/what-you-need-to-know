/*  packages/backend/algorithms/mmge-v1.ts
 *  Flow smoke-test with filter ➜ duel-select ➜ map
 *  (model returns winning item as JSON)
 *  -------------------------------------------------------------- */

import { DB, NewsItem }          from "@wyntn/common/db";
import { Flow }                  from "@wyntn/common/flow";
import { ChatMsg }               from "@wyntn/common/openrouter";

/* ---------- config ---------------------------------------------- */

const MODEL          = "openai/gpt-4o";
const MAX_ITEMS      = 12;   // keep it cheap
const KEEP_THRESHOLD = 5;    // pick top 5

function todayPhoenix(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Phoenix" })
    .format(new Date())
    .slice(0, 10);
}

const profile = "i'm generally interested in CS research, especially as it pertains to ai, and especially for anything that might impact ai product development possibilities or the tech investment landscape. new capabilities for developing products, new market potentials, up and coming players, etc. are all of interest. on the research side, i'm interested in anything with potentially lasting intellectual interest—this could be from any field not just CS; math, bio, whatever"

/* ---------- Prompts --------------------------------------------- */

// 1) Judge: keep if title has letter 'e' / 'E'
const judgePrompt = (item: NewsItem): ChatMsg[] => [
  {
    role : "user",
    content:
`A user with the profile soon to be given would like for you to explain why this news item would be of interest to them. Be concise, but try to draw out some of the implications for them.

User profile: "${profile}"

Item title: "${item.title}"
Item summary: "${item.summary}"
`,
  },
];

// 2) Duel: model returns JSON of the earlier-title item
const duelPrompt = (a: string, b: string): ChatMsg[] => [
  {
    role : "user",
    content:
`We have two passages describing why a certain news item might be interesting to a user with the given profile:

${profile}

Here are the passages:

A: ${a}

B: ${b}

Which item (A or B) do you think the user would be most interested in hearing about?
Respond with **exactly** the text of the winning item. No extra text.`,
  },
];

// 3) Context one-liner
// const contextPrompt = (item: string): ChatMsg[] => [
//   {
//     role : "user",
//     content:
// `Write one catchy line of context for this tech news item:
// "${item.title}"`,
//   },
// ];

/* ---------- run() ----------------------------------------------- */

export async function run() {
  const day = todayPhoenix();
  const db  = new DB();  await db.open();

  const items = (await db.getNews(day)).slice(0, MAX_ITEMS);
  await db.close();

  if (!items.length) {
    console.log("No news; run pnpm news:fetch first.");
    return;
  }

  console.log(`▶ Flow test with ${items.length} items …`);

  const top5 = await Flow.from(items)
    /* 1 ─ filter */
    .llmMap<string>(
      MODEL,
      judgePrompt,
      { temperature: 0.3, max_tokens: 1000, parse: t => t.trim() },
    )
    /* 2 ─ tournament-select top 5 */
    .llmSelect(
      KEEP_THRESHOLD,
      MODEL,
      duelPrompt,
      { temperature: 0, response_format:{type:"json_object"}, parse: JSON.parse },
    )
    /* 3 ─ map to context line */
    // .llmMap<string>(
    //   MODEL,
    //   contextPrompt,
    //   { temperature: 0.3, max_tokens: 40, parse: t => t.trim() },
    // )
    .run();

  console.log("\n=== FINAL 5 ===");
  top5.forEach((ctx, i) => console.log(`${i + 1}. ${ctx}`));
}
