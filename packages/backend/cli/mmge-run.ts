import { run } from "../algorithms/algo-v1";

(async () => {
  try {
    await run();
  } catch (err) {
    console.error("MMGE test failed:", err);
    process.exit(1);
  }
})();
