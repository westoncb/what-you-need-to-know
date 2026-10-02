import { loadProfile } from "./profile";
import { NewsItem }          from "@wyntn/common/src/db";
import { ChatMsg }               from "@wyntn/common/src/t-flow/llm";
export interface WhyObj   { item: NewsItem; why: string }
export interface EnhancedItem extends WhyObj { overview: string }
export interface Enriched extends EnhancedItem { context: string}
export interface RationaleItem { item: NewsItem; why: string }
export interface Enriched extends RationaleItem { context: string}

export const profile = loadProfile();

/* 1a — rationale (“why or why not”) */
export const whyPrompt = (item: NewsItem): ChatMsg[] => [
  {
    role: "user",
    content:
    `so i'm trying to decide whether to spend more time reading this or not, but i'd like your opinion on whether it'll be worthwhile for me or not. ${profile}

    it doesn't have to be specifically related to anything i've told you about myself; you've gotta infer the details of who i am in total for yourself. that's just an arbitrary snapshot i wrote up real quick.

    currently i'm considering this ${item.src === 'hn' ? 'hn story' : 'arxiv paper'} titled "${item.title}"

    and i can share the ${item.src === 'hn' ? 'first part of it' : 'abstract'}:

    ##########################
    ${item.summary}
    ##########################

    curious to hear your opinion on this one. please stay under ~3 paragraphs.`,
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

    If you think there's *any* chance it could be valuable for me to read it, respond exactly KEEP.  Otherwise respond exactly SKIP
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
      `hey ${model}, can you explain what's goin on in each of these to me in full technical detail? chances are i may not reading any of these in full myself so it's important that you go into detail; definitely looking more for "teach me the literal content" over "summary". i also want your raw, realistic take on practical real world impact. i don't care what an abstract or article claims, i mean from your experience seeing how these things goes and the practical realities around it and so on: i want to know if something strikes you as genuinely deep and important or incremental or anywhere between. take them as they are—i realize they may be incomplete so you've got to work with what you've got.

                  <article_info>
                  ${bulletList}
                  </article_info>

      please please please don't use bullets or lists or tables or anything! i want to hear your beautiful sentences! a final note: i say "technical," but not everythign that comes through will necessarily be technical: i just mean the real *meat* of what's being talked about.
                  ` ,
    },
  ];
}

/* 5 — markup / tagging prompt */
export function markupPrompt(prose: string, items: NewsItem[]): ChatMsg[] {
  return [
    {
      role: "system",
      content: `You are a document markup specialist. Convert the input text into structured HTML that enhances readability and visual hierarchy while preserving the original content and meaning. Use these flexible document primitives:

CORE PRIMITIVES:
- <article class="content-piece"> - Wrap the entire document
- <h1 class="main-title"> - Main document title (if present)
- <p class="intro"> - Any introductory/overview text
- <section class="content-section" data-source-id="[item-id]"> - Distinct content sections
  - <h2 class="section-heading"> - Section headings or titles
  - <h3 class="subsection-heading"> - Sub-section headings
  - <p> - Regular paragraphs
  - <p class="emphasis"> - Key paragraphs deserving extra attention
  - <blockquote class="key-quote"> - Important statements or quotes to highlight
  - <ul class="point-list"> / <ol class="numbered-list"> - Lists of items
    - <li> - List items
  - <span class="highlight"> - Important inline phrases
  - <div class="assessment-block"> - Evaluative or assessment sections
  - <hr class="section-divider"> - Visual separation between major sections

GUIDELINES:
1. Adapt to the document's natural structure - don't force a specific format
2. Identify the logical sections of the document and assign appropriate data-source-id attributes
3. Use <span class="highlight"> sparingly for truly important phrases
4. Preserve all original content and language
5. If a section clearly relates to a source item, add the corresponding data-source-id attribute
6. Add class="emphasis" to paragraphs that contain key insights or conclusions
7. Use <div class="assessment-block"> for evaluative content like "Practical impact assessment"
8. When lists appear in the original text, use appropriate <ul> or <ol> tags

SOURCE ITEM LINKING:
1. For each major section, determine which source item it best corresponds to
2. Add that source item's ID as a data-source-id attribute on the section tag
3. If a section discusses multiple sources or no clear source, omit the data-source-id attribute

Return valid HTML that enhances readability and visual hierarchy while preserving the complete original content. Avoid adding <html>, <head>, or <body> tags.`,
    },
    { role: "user", content: `
Here is the document to markup: <document>${prose}</document>

And here is meta data for each of the source items which were used to write this document:

${JSON.stringify(items.map(i => ({id: i.item.id, title: i.item.title, url: i.item.url})))}
      `.trim() },
  ];
}
