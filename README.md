# What You Need to Know

**What You Need to Know** is a personalized news explainer for Hacker News and arXiv. It uses a reader’s bio to identify material they’re likely to find interesting, then asks LLMs to turn the selected sources into a cohesive mini-essay that explains their substance and significance.

The project contains:

- **Source collection:** Scripts fetch Hacker News posts, extract linked article text, and download arXiv abstracts into a local SQLite database.
- **The pipeline:** Uses the reader’s bio to assess relevance, filter candidates, and compare them to select up to eight sources. Each configured LLM receives the same original material and writes its own title, introductory paragraph, and narrative. A separately configured LLM formats the prose for display, while supporting notes provide background and explain why each source is worth reading.
- **Custom flow abstraction:** `t-flow` is the project’s TypeScript foundation for composing the pipeline from operations such as mapping, filtering, selection, and reduction. It handles concurrency, retries, and instrumentation.
- **Observer:** A development interface for inspecting pipeline stages, prompts, responses, and failures as a run progresses.
- **Web frontend and publication:** A React interface with tabs for comparing LLM-generated narratives, source links, and supporting notes. An export script turns database reports into static JSON so the site can run on GitHub Pages without a backend server.

The main scripts cover source collection (`news:fetch`), pipeline execution (`mmge:run`), static export (`site:export`), and the observer (`dev:observer`). Model choices live in a shared configuration; API credentials and the reader’s bio are kept out of the published site.

## Setup

Use Node.js 24 and pnpm 10.10.0 (the version pinned in `package.json`). Run commands from the repository root.

```sh
pnpm install
cp profile.example.txt profile.local.txt
```

Edit `profile.local.txt` with your reading interests and background. Without it, selection uses a generic software engineering / AI research profile.

Create a root `.env`:

```dotenv
OPENROUTER_API_KEY=your-key
DB_PATH=data/wyntn.db
```

`DB_PATH` is optional and defaults to the path shown. Generation requires an OpenRouter key with available credit. The default database, `.env`, and local bio are ignored by Git.

## Generate and view

```sh
pnpm news:run
pnpm --filter @wyntn/frontend dev
```

`news:run` fetches sources, generates narratives, and exports the site data in order. A failed step stops the run. Open the frontend at [localhost:5173/what-you-need-to-know/](http://localhost:5173/what-you-need-to-know/) (or Vite’s printed URL). It reads exported JSON, not the database, and shows the latest report date. Generation is on demand; no hourly scheduler is configured. Running again for the same date replaces each writer’s report rather than keeping an hourly archive.

To run the steps separately:

```sh
pnpm news:fetch
pnpm mmge:run
pnpm site:export
```

Useful options for `news:run` and `mmge:run`:

- `--limit 5`: consider at most five stored source items instead of the default 50. This limits generation inputs, not downloads or total LLM calls.
- `--date YYYY-MM-DD`: use a particular batch date; the default is today in `America/Phoenix`.
- `--observe`: start the observer dashboard and open it in your browser during generation.

`news:fetch` also accepts `--date`, but always fetches **current** feeds; the date labels the batch rather than retrieving historical news. Generation reads sources already stored for that date. Fetching a repeated source updates its stored batch date. Use `--help` on these commands for their options.

## Observe a run

```sh
pnpm news:run --limit 5 --observe
```

`--observe` starts the dashboard, normally at [localhost:5174](http://localhost:5174), and opens it in your browser. It connects to `ws://127.0.0.1:4000`; use the printed dashboard URL if port 5174 is busy. Both servers stop when generation ends. The open tab retains its last snapshot, but reloading after shutdown will not work.

`pnpm dev:observer` also runs the dashboard independently for development.

## Configuration and code

| Location | Purpose |
| --- | --- |
| [Model configuration](packages/common/src/models.ts) | Model IDs, temperatures, and token limits for shared stages and the `writers` array. Each writer gets a frontend tab; all writers use the fixed `htmlFormatting` stage. |
| [Pipeline](packages/backend/algorithms/algo-v1.ts) and [prompts](packages/backend/algorithms/prompts.ts) | Selection, public source notes, independent writing, and formatting that preserves the writer’s prose. |
| [t-flow](packages/common/src/t-flow/) | Custom flow operations, LLM calls, and instrumentation. |
| [CLI scripts](packages/backend/cli/) | Fetching, generation, and export commands. |
| [Frontend](packages/frontend/) / [observer](packages/observer-ui/) | Reader-facing site and development dashboard. |

The current writers are `anthropic/claude-sonnet-5.5` and `openai/gpt-5.6-sol`. All shared stages, including HTML formatting, use `~openai/gpt-luna-latest`.

The bio is sent to the selection LLMs through OpenRouter. It and the private selection rationales are excluded from exported reports; public “why” and context notes are generated separately from source text alone.

## Publish and check

The configured site address is [westoncb.github.io/what-you-need-to-know/](https://westoncb.github.io/what-you-need-to-know/).

`pnpm site:export` writes up to 30 recent report dates to `packages/frontend/public/data/`. Commit and push that directory, including `index.json`, to `main` to publish new narratives. Frontend and model-configuration changes also need to be committed and pushed. Local pipeline commands do neither. An empty database causes export to fail without changing existing exports.

The [GitHub Pages workflow](.github/workflows/pages.yml) builds and deploys on pushes to `main`, or can be started manually on `main`. Set the repository’s **Settings → Pages → Source** to **GitHub Actions**. The workflow publishes committed exports; it does not fetch news or call LLMs. The frontend base path is configured in [vite.config.ts](packages/frontend/vite.config.ts).

The old `push:today` script still references an obsolete output path; use normal Git commands instead.

```sh
pnpm test                              # CLI, export, and observer checks; no paid LLM calls
pnpm --filter @wyntn/frontend build     # Production site in packages/frontend/dist
```
