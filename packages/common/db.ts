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

  getNews(day: string): NewsItem[] {
    const res = this.db.exec(`SELECT * FROM news_items WHERE day=? ORDER BY src,id`, [day]);
    return res[0]?.values.map((v) => Object.fromEntries(res[0].columns.map((c, i) => [c, v[i]]))) as NewsItem[] ?? [];
  }

  writeReport(day: string, llm: string, stage: Stage, content: string, ver="v1.0") {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO mmge_reports (day,llm_id,algo_version,stage,content)
      VALUES (:day,:llm,:ver,:stage,:content)
    `);
    stmt.run({ day, llm, ver, stage, content });
    stmt.free();
  }

  getReports(day: string, stage?: Stage): MMGEReport[] {
    const res = this.db.exec(
      `SELECT * FROM mmge_reports WHERE day=?${stage ? " AND stage=?" : ""} ORDER BY llm_id`,
      stage ? [day, stage] : [day],
    );
    return res[0]?.values.map((v) => Object.fromEntries(res[0].columns.map((c, i) => [c, v[i]]))) as MMGEReport[] ?? [];
  }
}
