#!/usr/bin/env tsx
/**
 * Copies the latest DailyReport JSON files out of SQLite into
 * frontend/public/data/, writes an index.json for the frontend, and pushes to
 * the gh-pages branch.
 */
import fs from "fs";
import path from "path";
import { execSync } from "node:child_process";
import { DB, DailyReport } from "@wyntn/common/src/db";

/* ---------- config ---------- */
const KEEP_DAYS      = 30;                   // how many days of JSON to ship
// Updated to write directly to the frontend package's public directory
const OUT_DIR        = path.resolve(".", "packages", "frontend", "public", "data");
const GIT_AUTO_PUSH  = false;                // flip to false while testing

/* ---------- util ---------- */
function todayISO() { return new Date().toISOString().slice(0, 10); }

/* ---------- main ---------- */
async function main() {
  const db = new DB();
  await db.open();

  /* pull most recent N distinct days that have a final report */
  const days = db.getRecentFinalDays(KEEP_DAYS);

  if (!days.length) {
    console.log("No reports found; nothing to export.");
    await db.close();
    return;
  }

  // Create the output directory if it doesn't exist
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Creating reports in: ${OUT_DIR}`);

  const index: { day:string; headline:string }[] = [];

  for (const day of days) {
    const rep = db.getFinalReport(day);
    if (!rep) continue;                      // shouldn't happen

    const file = path.join(OUT_DIR, `${day}.json`);
    fs.writeFileSync(file, JSON.stringify(rep, null, 2), "utf8");
    console.log("✅ wrote", file);

    index.push({ day, headline: rep.headline });
  }

  /* write simple index the SPA can fetch once */
  fs.writeFileSync(
    path.join(OUT_DIR, "index.json"),
    JSON.stringify(index, null, 2),
    "utf8"
  );

  await db.close();

  /* ---------- push to gh-pages (optional) ---------- */
  if (GIT_AUTO_PUSH) {
    try {
      // Updated git add path to match the new output directory
      execSync(`git add ${OUT_DIR} && git commit -m 'site export' && git push`, { stdio: "inherit" });
      console.log("🚀 Pushed updated data to origin.");
    } catch (err: any) {
      console.error("git push failed:", err.message);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
