import { DB, NewsItem }          from "@wyntn/common/src/db";
import { Flow, setLogger }       from "@wyntn/common/src/t-flow/flow";
import { ChatMsg }               from "@wyntn/common/src/t-flow/llm";
import { startWsServer }         from "../ws-server";

/* ------------------------------------------------------------------ */
/* Config                                                             */
/* ------------------------------------------------------------------ */
const MODELS = ["openai/gpt-4.1"];
const TOP_K         = 5;
const WHY_CONC      = 8;
const JUDGE_CONC    = 8;
const DUEL_CONC     = 4;

interface WhyObj   { item: NewsItem; why: string }
interface EnhancedItem extends WhyObj { overview: string }
interface Enriched extends EnhancedItem { context: string; links: string[] }

setLogger(startWsServer(4000), { snapshotMs: 500 });

/* ------------------------------------------------------------------ */
/* Prompt helpers                                                     */
/* ------------------------------------------------------------------ */

const profile = `I am interested in software engineering and AI research.`

/* 1a — rationale (“why or why not”) */
const whyPrompt = (item: NewsItem): ChatMsg[] => [
  {
    role: "user",
    content:
    `so i'm trying to decide whether to spend more time reading this or not, but i'd like your opinion on whether it'll be worthwhile for me or not. ${profile}

    if it's something at all in this realm or just a "big deal," like people will be talking about it, then i'm probably interested. or even better: if it's something that *should* be a big deal but people are likely to miss!

    currently i'm considering this ${item.src === 'hn' ? 'hn story' : 'arxiv paper'} titled "${item.title}"

    and i can share the ${item.src === 'hn' ? 'first part of it' : 'abstract'}:

    ##########################
    ${item.summary}
    ##########################

    curious to hear your opinion on this one. please keep it somewhat short, like 3 paragraphs max.`,
  },
];

/* 1b — judge prompt (KEEP / SKIP) */
const judgePrompt = (rationale: string): ChatMsg[] => [
  {
    role: "user",
    content:
    `Below is an argument for or against whether someone should read a particular article.

    This is the argument/opinion:

    ${rationale}

    And here is some info on my background: ${profile}

    If you think the argument is *at all* in favor of me reading it, respond exactly KEEP.  Otherwise respond exactly SKIP
    `,
  },
];

/* 1c — synthesize overview from why + summary */
const overviewPrompt = (item: WhyObj): ChatMsg[] => [
  {
    role: "user",
    content:
    `I need you to synthesize these two given pieces of text into a coherent, detailed, unified whole.

    You're receiving two pieces of information:
    1. The "summary" - which is either an academic abstract or the first ~500 words of an article
    2. A "rationale" - which explains why this content might be significant or worth reading

    Your task is to write ~3 paragraphs that capture the essentials of both - what the content is about and why it matters. you should use as much concrete, specific detail as possible, if any such details are given in the original texts. this synthesis should be "non-lossy" in regards to concrete details.

    Title: ${item.item.title}

    <summary>
    ${item.item.summary}
    </summary>

    <rationale>
    ${item.why}
    </rationale>

    An important final note: it's important to keep this fully sober and accurate. Even if the original text has sensationalizing elements, your synthesis should not. The prime goal here is to efficiently convey technically accurate information without editorializing.

    Respond with just the synthesized paragraphs, no additional text. And to reiterate: keep *all* technical details, and zero editorializating or hype of any kind.`,
  },
];

/* 2 — duel prompt for tournament */
interface RationaleItem { item: NewsItem; why: string }
const duelPrompt = (a: RationaleItem, b: RationaleItem): ChatMsg[] => [
  {
    role: "user",
    content:
    `so i'm trying to decide which of these two articles to read, and i'd like your opinion on which to give priority to. consider the arguments given for each and go with the one that's stronger.

    here are the items to evaluate:

    A) ${a.item.title}
       Why: ${a.why}

    B) ${b.item.title}
       Why: ${b.why}

    which should i read?

    please respond with EXACTLY "A" or "B".`,
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


const makeNarrativePrompt = (model: string) => {
  return (bulletList: string): ChatMsg[] => [
    {
      role: "user",
      content:
      `hey ${model}, i've got this news/research paper filtering pipeline going and it's produced this set of items for me to learn about today (note: there may be errors or partial data since this comes from an automated system)

        —and here's the list:
        <list>
        ${bulletList}
        </list>

      please write me a piece to read that weaves the critical new ideas into a kind of "narrative of what happened today". it's important to retain technical details, and you're free to be opinionated in your presentation: i don't want to you just take everything stated in the above items at face value but rather use your judgement about what's most valuable and convey it to me. don't "LARP" though, give it to me real and unadulterated, no fancy packaging or holds barred or linkedin techno-marketing-babble—let's go right to meat of it. you can assume high general technical literacy` ,
    },
  ];
}

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
  return `• **${e.item.title}**\n\n — <extract>${e.item.summary}</extract>`;
}

/* ------------------------------------------------------------------ */
/* Main runner for one model                                           */
/* ------------------------------------------------------------------ */
async function runForModel(model: string) {
  const db  = new DB(); await db.open();
  const day = todayPhoenix();
  const raw = await db.getNews(day, 60); await db.close();
  if (!raw.length) { console.log("No news for", day); return; }

  const reportArr = await Flow
    .from<NewsItem>(raw)          // safety cap

    /* 1a ─ rationale ------------------------------------------------- */
    .llmMap<WhyObj>(
      whyPrompt,                                // promptFn
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
      WHY_CONC,  // We can reuse the same concurrency as the why stage
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
        model: "anthropic/claude-3.5-haiku",
        temperature: 0,
        response_format: { type: "json_object" },
        post: (obj, src) => {
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
      makeNarrativePrompt(model),
      {
        model: "anthropic/claude-3.7-sonnet",
        temperature: 0.7,
        post: raw => raw.trim(),
      },
      1,
    )

    /* 6 ─ markup pass ----------------------------------------------- */
    // .llmMap<string>(
    //   markupPrompt,
    //   {
    //     model: "anthropic/claude-3.5-haiku",
    //     temperature: 0.4,
    //     max_tokens:  5000,
    //     post: raw => raw.trim(),
    //   },
    //   1,
    // )

    .run();

  const finalJSON = reportArr[0];
  console.log(`\n=== WYNTN OUTPUT for ${model} ===\n`);
  console.log(finalJSON);

  // await db.open(); db.writeReport(day, model, "final", finalJSON); await db.close();
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
