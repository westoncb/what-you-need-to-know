import { DB, NewsItem }          from "@wyntn/common/src/db";
import { Flow, setLogger }       from "@wyntn/common/src/t-flow/flow";
import { ChatMsg }               from "@wyntn/common/src/t-flow/llm";
import { startWsServer }         from "../ws-server";

/* ------------------------------------------------------------------ */
/* Config                                                             */
/* ------------------------------------------------------------------ */
const MODELS = ["openai/gpt-4.1"];
const TOP_K         = 10;
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

/* 1a — rationale (“why or why not”) */
const whyPrompt = (item: NewsItem): ChatMsg[] => [
  {
    role: "user",
    content:
    `so i'm trying to decide whether to spend more time reading this or not, but i'd like your opinion on whether it'll be worthwhile for me or not. i'm generally interested in CS research, especially as it pertains to ai, and especially for anything that might impact ai product development possibilities or the tech investment landscape. new capabilities for developing products, new market potentials, up and coming players, etc. are all of interest. on the research side, i'm interested in anything with potentially lasting intellectual interest—this could be from any field not just CS; math, bio, electrical engineering, material science, manufacturing and robots—whatever.

    if it's something at all in this realm and just a "big deal," like people will be talking about it, then that should give it a pass as well. or even better: if it's something that *should* be a big deal but people are likely to miss!

    this is one of a bunch of options i've got though and my time is limited, so what i'm really looking for is to get your insight into whether this is likely to be valuable to know about. especially for cases where the implications might be subtle for someone who doesn't fully know surrounding context or details of the field it comes from. the reading i do in this phase of my day is basically around "staying abreast of important developments"; so what i'm hoping is that if it's something i really should't miss, then for you to pursuade me to put the time into reading—and it you think it's probably not significant, to help me prune it early so i can focus on what really matters.

    currently i'm considering this ${item.src === 'hn' ? 'hn story' : 'arxiv paper'} titled "${item.title}"

    and i can share the ${item.src === 'hn' ? 'first part of it' : 'abstract'}:

    ##########################
    ${item.summary}
    ##########################

    whether it's theoretical or practical, niche or general—this is all fine; what i'm looking for is quality, and to stay informed. seperating signal from noise and giving attention to serious valuable work and important general occurances. curious to hear your opinion on this one. please keep it somewhat short, like 3 paragraphs max.`,
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

    If you think the argument is in *favor* or reading it, respond exactly KEEP.  Otherwise respond exactly SKIP
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
      `hey ${model}, can you give me your take on the folowing? i want you to retain all the important concrete details without glossing over anything, but i also want you to be opinionated. these come from hacker news stories and arxiv abstracts. i know the game, and even in these prestigious outlets (i mean they aren't just random Medium articles) it can still be hard to separate signal from noise. i want your raw opinions on these: what's their upshot, their likely true significance in your estimate

      here's today's list:
      <recent_events>
      ${bulletList}
      </recent_events>

      i'm basically looking to separate the chaff from the grain here—or, less archaically, i'm trying to find genuine quality/value as opposed to distraction. each of these items has already passed some filters so i'd like to understand the concrete, specific details of each in addition to getting your no holds barred quality/value assessment. whether the item is "real-world" vs theoretical doesn't matter; only interested in an abstract measure of quality/value of the work. don't be tricked by the language of the presentations—they're basically all going to self-describe as earth-shattering advancements: our task here is to read between the lines. please order your takes where highest quality/value items are presented first.
      `,
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
  const raw = await db.getNews(day, 100); await db.close();
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
        model: "anthropic/claude-3.5-haiku",
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
        model: "openai/o1",
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
