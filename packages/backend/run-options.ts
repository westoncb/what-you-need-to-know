import { parseArgs } from "node:util";

export const REPORT_TIME_ZONE = "America/Phoenix";
export const DEFAULT_INPUT_LIMIT = 50;

export interface GenerationOptions {
  date: string;
  limit: number;
}

export interface RunOptions extends GenerationOptions {
  observe: boolean;
}

export type Command = "news:fetch" | "mmge:run" | "news:run";

export function reportDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: REPORT_TIME_ZONE }).format(now);
}

export function defaultRunOptions(now = new Date()): RunOptions {
  return { date: reportDate(now), limit: DEFAULT_INPUT_LIMIT, observe: false };
}

export function parseRunOptions(command: Command, args: string[], now = new Date()) {
  const generation = command !== "news:fetch";
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      date: { type: "string" },
      help: { type: "boolean", short: "h" },
      ...(generation ? {
        limit: { type: "string" as const },
        observe: { type: "boolean" as const },
      } : {}),
    },
  });
  const options = defaultRunOptions(now);
  if (values.date !== undefined) {
    const parsed = new Date(`${values.date}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date) ||
        !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== values.date) {
      throw new Error("--date must be a real calendar date in YYYY-MM-DD format.");
    }
    options.date = values.date;
  }
  if (values.limit !== undefined) {
    const limit = Number(values.limit);
    if (!/^[1-9]\d*$/.test(values.limit) || !Number.isSafeInteger(limit)) {
      throw new Error("--limit must be a positive integer.");
    }
    options.limit = limit;
  }
  options.observe = values.observe === true;
  return { options, help: values.help === true };
}

export function commandHelp(command: Command): string {
  const generation = command !== "news:fetch";
  return [
    `Usage: pnpm ${command} [--date YYYY-MM-DD]${generation ? " [--limit N] [--observe]" : ""}`,
    "",
    `--date     Report date (default: today in ${REPORT_TIME_ZONE}).`,
    ...(generation ? [
      `--limit    Maximum stored news items sent into generation (default: ${DEFAULT_INPUT_LIMIT}).`,
      "--observe  Open the local observer connection on 127.0.0.1:4000 during generation.",
    ] : []),
    "--help, -h Show this help.",
    "",
    ...(command !== "mmge:run" ? [
      "Fetching always retrieves current feeds; --date labels the batch, it does not backfill history.",
    ] : ["Generation reads news already stored for --date."]),
    ...(command === "news:run" ? [
      "Runs fetch → generate → export in order; a failed step stops the run.",
      "--limit reduces LLM inputs, not the number of stories downloaded. Export includes recent stored reports.",
    ] : []),
  ].join("\n");
}
