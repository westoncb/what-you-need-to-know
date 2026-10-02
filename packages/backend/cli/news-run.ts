import { fetchNews } from "./news-fetch";
import { generateReports } from "./mmge-run";
import { exportReports } from "./site-export";
import { type RunOptions } from "../run-options";
import { isMain, runCommand } from "./command";

const defaultSteps = { fetch: fetchNews, generate: generateReports, export: exportReports };

/** One options object keeps the batch date fixed, even across midnight. */
export async function runPipeline(options: RunOptions, steps = defaultSteps) {
  console.log(`Running fetch → generate → export for ${options.date}.`);
  await steps.fetch(options);
  await steps.generate(options);
  await steps.export();
  console.log(`Finished reports for ${options.date}. Exported files are ready to review and commit.`);
}

if (isMain(import.meta.url)) void runCommand("news:run", runPipeline);
