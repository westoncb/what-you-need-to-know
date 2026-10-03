#!/usr/bin/env tsx
/** Export writer-specific reports and their availability index for the static site. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DB, type DailyReport } from "@wyntn/common/src/db";
import { modelConfig, type ReportIndexEntry } from "@wyntn/common/src/models";

const KEEP_DAYS = 30;
const OUT_DIR = fileURLToPath(new URL("../../frontend/public/data/", import.meta.url));

/** Publish reports from the database; exported files are generated output. */
export async function exportReports(outDir = OUT_DIR) {
  const byDay = new Map<string, Map<string, DailyReport>>();
  function remember(day: string, report: DailyReport) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !report.model || !report.narrative_html?.trim() || !Array.isArray(report.items)) {
      throw new Error(`Invalid report for ${day}.`);
    }
    if (!report.writer || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(report.writer.id) || !report.run_id) {
      throw new Error(`Missing or invalid writer/run identity in report for ${day}.`);
    }
    const key = report.writer.id;
    const reports = byDay.get(day) ?? new Map<string, DailyReport>();
    const previous = reports.get(key);
    if (!previous || Date.parse(report.generated_at) >= Date.parse(previous.generated_at)) {
      reports.set(key, report);
    }
    byDay.set(day, reports);
  }

  const db = new DB();
  await db.open();
  try {
    for (const day of db.getRecentFinalDays(KEEP_DAYS)) {
      for (const row of db.getReports(day, "final")) remember(day, JSON.parse(row.content));
    }
  } finally {
    await db.close();
  }

  // A failed generation or an empty database must not clear a published index.
  // Check before creating directories or replacing any exported files.
  if (!byDay.size) {
    throw new Error("No reports found in the database; existing exported files were left unchanged. Generate a report successfully before exporting.");
  }

  fs.mkdirSync(outDir, { recursive: true });

  const index: ReportIndexEntry[] = [];
  for (const day of [...byDay.keys()].sort().reverse().slice(0, KEEP_DAYS)) {
    let reports = [...byDay.get(day)!.values()].sort((a, b) => Date.parse(b.generated_at) - Date.parse(a.generated_at));
    // A partly successful rerun must not mix writers from different selections.
    const latestRun = reports[0].run_id;
    reports = reports.filter(report => report.run_id === latestRun);

    const entry: ReportIndexEntry = { day, headline: reports[0].headline, reports: [] };
    fs.mkdirSync(path.join(outDir, day), { recursive: true });
    for (const report of reports) {
      const id = report.writer.id;
      const file = `${day}/${id}.json`;
      const target = path.join(outDir, file);
      fs.writeFileSync(`${target}.tmp`, JSON.stringify(report, null, 2) + "\n");
      fs.renameSync(`${target}.tmp`, target);
      entry.reports.push({ writerId: report.writer.id, model: report.model, file });
    }
    index.push(entry);
  }

  const indexFile = path.join(outDir, "index.json");
  fs.writeFileSync(`${indexFile}.tmp`, JSON.stringify(index, null, 2) + "\n");
  fs.renameSync(`${indexFile}.tmp`, indexFile);
  console.log(`Exported ${index.length} report dates to ${outDir}.`);
  for (const writer of modelConfig.writers) {
    const count = index.filter(entry => entry.reports.some(report =>
      report.writerId === writer.id
    )).length;
    console.log(`${writer.name}: reports available on ${count} dates.`);
  }
  return index;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  exportReports().catch(error => { console.error(error); process.exitCode = 1; });
}
