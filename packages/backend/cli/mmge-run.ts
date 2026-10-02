import { run } from "../algorithms/algo-v1";
import { setLogger } from "@wyntn/common/src/t-flow/flow";
import { startWsServer } from "../ws-server";

(async () => {
  const logger = startWsServer(4000);
  setLogger(logger, { snapshotMs: 500 });
  try {
    await run();
  } catch (error) {
    console.error("Report generation failed:", error);
    process.exitCode = 1;
  } finally {
    setLogger(null);
    await logger.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
