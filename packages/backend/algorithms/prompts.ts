import { NewsItem }          from "@wyntn/common/src/db";
import { ChatMsg }               from "@wyntn/common/src/t-flow/llm";
export interface WhyObj   { item: NewsItem; why: string }
export interface EnhancedItem extends WhyObj { overview: string }
export interface Enriched extends EnhancedItem { context: string}
export interface RationaleItem { item: NewsItem; why: string }
export interface Enriched extends RationaleItem { context: string}

export const profile = `I am interested in software engineering and AI research.`

/* 1a — rationale (“why or why not”) */
export const whyPrompt = (item: NewsItem): ChatMsg[] => [
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
export const judgePrompt = (rationale: string): ChatMsg[] => [
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
export const overviewPrompt = (item: WhyObj): ChatMsg[] => [
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
export const duelPrompt = (a: RationaleItem, b: RationaleItem): ChatMsg[] => [
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

// prompts.ts
export const ctxPrompt = (ri: RationaleItem): ChatMsg[] => [
  {
    role: "user",
    content: `
Write one concise paragraph that gives enough background context to a generalist software engineer to understand any unfamiliar term or
concept the following.

Headline: ${ri.item.title}
Why it matters: ${ri.why}

Return **only** JSON of the form:
{
  "context": "<string>"
}`,
  },
];


/* 4 — narrative synthesis prompt (takes one big string) */


export const makeNarrativePrompt = (model: string) => {
  return (bulletList: string): ChatMsg[] => [
    {
      role: "user",
      content:
      `i've got this news/research paper filtering pipeline going and it's produced this set of items for me to learn about today (note: there may be errors or partial data since this comes from an automated system)

              —and here's the list:
              <list>
              ${bulletList}
              </list>

            please give me your take on the items. you're free to be opinionated in your presentation. this is for a highly technical audience likely to jump in and read the papers or other articles themselves but your reads on each will help to guide their attention.` ,
    },
  ];
}

/* 5 — markup / tagging prompt */
export function markupPrompt(prose: string, items: NewsItem[]): ChatMsg[] {
  return [
    {
      role: "system",
      content: `You are a document markup specialist. Convert the input text into structured HTML using the following document primitives:

DOCUMENT STRUCTURE:
- <article class="article"> - Wrap the entire document
  - <h1 class="article-title"> - Main article title
  - <p class="lede"> - Opening summary paragraph
  - <section class="section" data-source-id="[item-id]"> - Individual content sections with source ID attribute
    - <h2 class="section-title"> - Section title/heading
    - <p> - Regular paragraphs
    - <p class="dropcap"> - First paragraph of each section (will get a drop cap)
    - <blockquote class="pullquote"> - Important quotes pulled out for emphasis
    - <ul class="article-list"> - Unordered lists
      - <li> - List items
    - <span class="highlight"> - Inline text to emphasize

GUIDELINES:
1. Always wrap the entire document in <article class="article">
2. Use <h1 class="article-title"> only once for the main title
3. Each main section should be wrapped in <section class="section">
4. Add a data-source-id attribute to each section, using the ID from the corresponding source item
5. Mark the first paragraph of each section with class="dropcap"
6. Use <span class="highlight"> for key phrases to emphasize inline
7. Use semantic HTML tags appropriately (p, blockquote, ul, li)
8. Do not use the dropcap class on list items or blockquotes

SOURCE ITEM LINKING:
1. For each section, determine which source item it best corresponds to
2. Add that source item's ID as a data-source-id attribute on the section tag
3. Do not wrap section titles in anchor tags - we'll handle linking separately

Return valid HTML without <html>, <head>, or <body> tags. Only include the structured content—and please do not alter any of the original language, just mark-up.`,
    },
    { role: "user", content: `
Here is the article: ${prose}

And here is meta data for each of the source items which were used to write the article:

${JSON.stringify(items.map(i => ({id: i.item.id, title: i.item.title, url: i.item.url})))}
      `.trim() },
  ];
}
