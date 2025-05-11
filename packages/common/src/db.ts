import initSqlJs, { Database as SQL, SqlJsStatic } from "sql.js";
import fs from "fs";
import { createRequire } from "module";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

/* ---------- Types ---------- */
export type Source = "hn" | "arxiv";
export type Stage  = "shard" | "synthesis" | "final";

export interface NewsItem   { id:string; src:Source; day:string; title:string; url:string; summary:string }
export interface MMGEReport { day:string; llm_id:string; algo_version:string; stage:Stage; content:string }

export interface DailyReport {
  generated_at  : string;
  model         : string;
  headline      : string;

  narrative_html: string;     // the “lede” / hero – already marked-up

  /** Cards that appear below the narrative */
  items: Array<{
    id      : string;
    src     : string;         // "hn", "arxiv", …
    title   : string;
    url     : string;
    summary : string;         // raw or lightly cleaned
    /** plain explanation paragraph(s) */
    context : string;
  }>;
}

export class DB {
  private SQL!: SqlJsStatic;
  private db!: SQL;
  private file = process.env.DB_PATH ?? "data/wyntn.db";

  async open() {
    const require = createRequire(import.meta.url);
        const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");

    this.SQL = await initSqlJs({
      locateFile: () => wasmPath,   // <<— point to local file
    });

    fs.mkdirSync(path.dirname(this.file), { recursive: true });

    if (fs.existsSync(this.file)) {
      const buf = fs.readFileSync(this.file);
      this.db = new this.SQL.Database(new Uint8Array(buf));
    } else {
      this.db = new this.SQL.Database();
    }

    this.initSchema();
  }

  async close() {
    const data = this.db.export();
    fs.writeFileSync(this.file, Buffer.from(data));
    this.db.close();
  }

  /* ---------- schema ---------- */
  private initSchema() {
    this.db.exec(`
      BEGIN;
      CREATE TABLE IF NOT EXISTS news_items (
        id TEXT PRIMARY KEY,
        src TEXT NOT NULL,
        day TEXT NOT NULL,
        title TEXT,
        url TEXT,
        summary TEXT
      );
      CREATE TABLE IF NOT EXISTS mmge_reports (
        day TEXT NOT NULL,
        llm_id TEXT NOT NULL,
        algo_version TEXT NOT NULL,
        stage TEXT NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (day, llm_id, stage, algo_version)
      );
      COMMIT;
    `);
  }

  /* ---------- helpers ---------- */
  upsertNews(item: NewsItem) {
    // Changed INSERT OR IGNORE to INSERT OR REPLACE to update existing records
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO news_items
      VALUES (?,?,?,?,?,?)
    `);

    // Add logging to verify the summary content is being passed to the database
    console.log(`Upserting ${item.id} with summary length: ${item.summary?.length || 0} chars`);

    stmt.run([
      item.id,
      item.src,
      item.day,
      item.title,
      item.url,
      item.summary,
    ]);
    stmt.free();
  }

  // inside your DB class
  getNews(
    day: string,
    limit: number = Number.POSITIVE_INFINITY,
    sources?: string[],
  ): NewsItem[] {
    /* ---------- pull rows ------------------------------------------------ */

    // Build the SQL and params list
    const [sql, params] = (() => {
      if (sources?.length) {
        const placeholders = sources.map(() => "?").join(",");
        return [
          `SELECT * FROM news_items
           WHERE day = ? AND src IN (${placeholders})
           ORDER BY src, id`,           // order within a source is deterministic
          [day, ...sources],
        ] as const;
      }
      return [
        `SELECT * FROM news_items
         WHERE day = ?
         ORDER BY src, id`,
        [day],
      ] as const;
    })();

    const res = this.db.exec(sql, params);

    const rows =
      res[0]?.values.map((v) =>
        Object.fromEntries(res[0].columns.map((c, i) => [c, v[i]]))
      ) as NewsItem[] ?? [];

    if (!rows.length) return []; // early exit

    /* ---------- bucket rows by source ------------------------------------ */

    const buckets: Record<string, NewsItem[]> = {};
    for (const row of rows) {
      (buckets[row.src] ??= []).push(row);
    }

    /* ---------- round-robin selection ------------------------------------ */

    const order = sources?.length
      ? [...sources]                      // preserve caller’s order
      : Object.keys(buckets).sort();      // deterministic fallback

    const output: NewsItem[] = [];
    while (output.length < limit) {
      let anyLeft = false;

      for (const src of order) {
        const bucket = buckets[src];
        if (bucket?.length) {
          output.push(bucket.shift()!);
          anyLeft = true;
          if (output.length === limit) break;
        }
      }

      if (!anyLeft) break; // all buckets exhausted
    }

    return output;
  }

  /* ---------- write typed report ----------------------------------- */
  writeFinalReport(
    day   : string,
    model : string,
    rep   : DailyReport,
    ver   = "v1.0",
  ) {
    this.writeReport(day, model, "final", rep, ver);
  }

  /* -------------------------------------------------------------- */
  /* generic writer – handles any stage                             */
  /* -------------------------------------------------------------- */
  writeReport(
    day    : string,
    llm    : string,
    stage  : Stage,
    content: unknown,
    ver    = "v1.0",
  ) {
    const payload = typeof content === "string"
      ? content
      : JSON.stringify(content);

    /* five positional ? placeholders in same order as column list */
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO mmge_reports
        (day, llm_id, algo_version, stage, content)
      VALUES (?,  ?,  ?,  ?,  ?)
    `);

    stmt.run([day, llm, ver, stage, payload]);
    stmt.free();
  }

  getReports(day: string, stage?: Stage): MMGEReport[] {
    const res = this.db.exec(
      `SELECT * FROM mmge_reports WHERE day=?${stage ? " AND stage=?" : ""} ORDER BY llm_id`,
      stage ? [day, stage] : [day],
    );
    return res[0]?.values.map((v) => Object.fromEntries(res[0].columns.map((c, i) => [c, v[i]]))) as MMGEReport[] ?? [];
  }

  /* ---------- convenient day-level fetch --------------------------- */
  /**
   * Returns the stored DailyReport for a given day (and optional model).
   * If no record is found, it returns null.
   */
   getFinalReport(day: string, model?: string): DailyReport | null {
     const sql = `
       SELECT content FROM mmge_reports
       WHERE day = ? AND stage = 'final' ${model ? "AND llm_id = ?" : ""}
       ORDER BY llm_id LIMIT 1
     `;
     const rows = this.db.exec(sql, model ? [day, model] : [day]);

     if (!rows.length) return null;
     return JSON.parse(rows[0].values[0][0] as string) as DailyReport;
   }

   /* ---------- utility: recent days with a final report ------------- */
   getRecentFinalDays(limit = 30): string[] {
     const res = this.db.exec(
       `SELECT DISTINCT day
          FROM mmge_reports
         WHERE stage = 'final'
         ORDER BY day DESC
         LIMIT ?`,
       [limit]
     );
     return res[0]?.values.map(r => r[0] as string) ?? [];
   }

}
