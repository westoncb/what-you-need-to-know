import { run } from "../algorithms/algo-v1";
import { setLogger } from "@wyntn/common/src/t-flow/flow";
import { startWsServer } from "../ws-server";
import { defaultRunOptions, type RunOptions } from "../run-options";
import { isMain, runCommand } from "./command";

export async function generateReports(options: RunOptions = defaultRunOptions()) {
  const logger = options.observe ? await startWsServer(4000) : null;
  if (logger) {
    setLogger(logger, { snapshotMs: 500 });
    console.log("Observer connection: ws://127.0.0.1:4000 (dashboard: pnpm dev:observer).");
  }
  try {
    await run(options);
  } finally {
    if (logger) {
      setLogger(null);
      await logger.close();
    }
  }
}

if (isMain(import.meta.url)) void runCommand("mmge:run", generateReports);
