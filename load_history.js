// load_history.js — one-time load of historical data (e.g. all of 2025) into
// sales_history. This is separate from the daily /api/upload flow because:
//   1. It's a one-off, not something that should run on a schedule.
//   2. Historical files can be far bigger than a single day's export (the
//      2025 file is ~3GB) — well past what you'd want going over HTTP.
//   3. sales_history must never be touched by the daily job, which only ever
//      replaces sales_current — this script is the only thing that writes here.
//
// IMPORTANT: stop the running server first. DuckDB locks its database file
// for one process at a time, so this and server.js can't have it open at once.
//
// Usage:
//   node load_history.js "D:\path\to\Sales_All_Branches_2025.csv"
//
// Safe to re-run: it replaces sales_history wholesale each time, so re-running
// with a corrected file (or a bigger one covering more years) just works.

const path = require('path');
const fs = require('fs');
const { DuckDBInstance } = require('@duckdb/node-api');
const { ingestCsvInto, TABLE_SCHEMA_SQL } = require('./ingest');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'warehouse.duckdb');
fs.mkdirSync(DATA_DIR, { recursive: true });

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Usage: node load_history.js <path-to-historical-csv>');
  process.exit(1);
}

// @duckdb/node-api (the maintained DuckDB client; the old `duckdb` package
// is deprecated and its prebuilt binaries are gone, so installs fell back to
// compiling DuckDB from source and Railway builds hung).
// run() returns plain row objects like the old client did; BIGINTs come back
// as JS bigint, so they're turned into Numbers (all our counts fit safely).
const dbReady = DuckDBInstance.create(DB_PATH).then((instance) => instance.connect());
const toPlain = (v) => (typeof v === 'bigint' ? Number(v) : v);

async function run(sql) {
  const con = await dbReady;
  const reader = await con.runAndReadAll(sql);
  return reader.getRowObjectsJS().map((row) => {
    for (const k of Object.keys(row)) row[k] = toPlain(row[k]);
    return row;
  });
}
async function exec(sql) {
  const con = await dbReady;
  await con.run(sql);
}

(async () => {
  console.log(`[${new Date().toISOString()}] Loading historical file into sales_history: ${csvPath}`);
  const start = Date.now();

  await exec(`CREATE TABLE IF NOT EXISTS sales_history (${TABLE_SCHEMA_SQL})`);
  await exec(`CREATE TABLE IF NOT EXISTS sales_current (${TABLE_SCHEMA_SQL})`);

  const result = await ingestCsvInto(run, exec, csvPath, 'sales_history');
  await exec(`CREATE OR REPLACE VIEW sales AS SELECT * FROM sales_history UNION ALL SELECT * FROM sales_current`);

  const [range] = await run(`SELECT min(trandate) AS dmin, max(trandate) AS dmax FROM sales_history`);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`Done in ${elapsed}s: ${result.kept.toLocaleString()} rows kept` +
    (result.skipped ? `, ${result.skipped.toLocaleString()} skipped (no readable date)` : '') +
    ` — date range ${range.dmin} to ${range.dmax}`);
  process.exit(0);
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
