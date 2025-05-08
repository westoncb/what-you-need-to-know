import { run } from "../algorithms/mmge-v1";

(async () => {
  try {
    await run();
  } catch (err) {
    console.error("MMGE test failed:", err);
    process.exit(1);
  }
})();
