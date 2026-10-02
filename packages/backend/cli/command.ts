import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandHelp, parseRunOptions, type Command, type RunOptions } from "../run-options";

export function isMain(url: string): boolean {
  return !!process.argv[1] && fileURLToPath(url) === path.resolve(process.argv[1]);
}

export async function runCommand(command: Command, execute: (options: RunOptions) => Promise<unknown>) {
  try {
    const { options, help } = parseRunOptions(command, process.argv.slice(2));
    if (help) {
      console.log(commandHelp(command));
      return;
    }
    await execute(options);
  } catch (error) {
    console.error(`${command} failed:`, error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
