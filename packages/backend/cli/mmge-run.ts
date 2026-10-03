import { run } from "../algorithms/algo-v1";
import { setLogger } from "@wyntn/common/src/t-flow/flow";
import { startWsServer } from "../ws-server";
import { defaultRunOptions, type RunOptions } from "../run-options";
import { isMain, runCommand } from "./command";

export async function generateReports(options: RunOptions = defaultRunOptions()) {
  const logger = options.observe ? await startWsServer(4000) : null;
  let closeDashboard: (() => Promise<void>) | undefined;
  try {
    if (logger) {
      setLogger(logger, { snapshotMs: 500 });
      const { startObserverDashboard } = await import("../../observer-ui/dev-server");
      const dashboard = await startObserverDashboard();
      closeDashboard = dashboard.close;
      console.log(`Observer dashboard: ${dashboard.url}`);
    }
    await run(options);
  } finally {
    try {
      if (logger) {
        setLogger(null);
        await logger.close();
      }
    } finally {
      await closeDashboard?.();
    }
  }
}

if (isMain(import.meta.url)) void runCommand("mmge:run", generateReports);
