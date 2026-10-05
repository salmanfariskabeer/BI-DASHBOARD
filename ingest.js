// ingest.js — CSV ingestion logic shared by server.js (daily uploads, into
// sales_current) and load_history.js (one-time historical load, into
// sales_history). Kept in one place so the two never drift out of sync on
// column matching or date parsing.

const fs = require('fs');
const zlib = require('zlib');

const CANONICAL_COLUMNS = [
  'Branch', 'supplier', 'MainGroupName', 'SubGroup', 'Subgroup2', 'groupname',
  'brand', 'itembarcode', 'Description', 'Unit', 'TotalQty', 'SalesTotal', 'TotalCost',
];
const TABLE_SCHEMA_SQL = `
  trandate DATE, Branch VARCHAR, supplier VARCHAR, MainGroupName VARCHAR, SubGroup VARCHAR,
  Subgroup2 VARCHAR, groupname VARCHAR, brand VARCHAR, itembarcode VARCHAR, Description VARCHAR,
  Unit VARCHAR, TotalQty DOUBLE, SalesTotal DOUBLE, TotalCost DOUBLE
`;

// Canonical column -> accepted header aliases (case/whitespace-insensitive match).
const REQUIRED = {
  trandate: ['trandate'],
  SalesTotal: ['salestotal'],
};
const OPTIONAL = {
  Branch: ['branch'], supplier: ['supplier'], MainGroupName: ['maingroupname'],
  SubGroup: ['subgroup'], Subgroup2: ['subgroup2'], groupname: ['groupname'],
  brand: ['brand'], itembarcode: ['itembarcode'], Description: ['description'],
  Unit: ['unit'], TotalQty: ['totalqty'], TotalCost: ['totalcost'],
};

function esc(v) {
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function resolveColumns(actualCols) {
  const norm = (s) => s.trim().toLowerCase();
  const byNorm = new Map(actualCols.map((c) => [norm(c), c]));
  const resolved = {};
  const missing = [];
  for (const [canon, aliases] of Object.entries(REQUIRED)) {
    const hit = aliases.map((a) => byNorm.get(a)).find(Boolean);
    if (!hit) missing.push(canon); else resolved[canon] = hit;
  }
  if (missing.length) {
    throw new Error(`Missing required column(s): ${missing.join(', ')}. Found columns: ${actualCols.join(', ')}`);
  }
  for (const [canon, aliases] of Object.entries(OPTIONAL)) {
    const hit = aliases.map((a) => byNorm.get(a)).find(Boolean);
    resolved[canon] = hit || null; // null -> selected as a literal NULL below
  }
  return resolved;
}

const DATE_EXPR = (col) => `COALESCE(
  TRY_CAST(${col} AS DATE),
  CAST(TRY_CAST(${col} AS TIMESTAMP) AS DATE),
  CAST(TRY_STRPTIME(CAST(${col} AS VARCHAR), '%d/%m/%Y') AS DATE),
  CAST(TRY_STRPTIME(CAST(${col} AS VARCHAR), '%m/%d/%Y') AS DATE),
  CAST(TRY_STRPTIME(CAST(${col} AS VARCHAR), '%Y/%m/%d') AS DATE)
)`;

// Ingests a CSV file into `targetTable` (CREATE OR REPLACE — the caller
// decides whether that's a daily-replaced table or a one-time historical
// load). `run`/`exec` are the same tiny DuckDB promise wrappers server.js and
// load_history.js each define locally.
// Pinning the dialect (delim/quote/escape/header) instead of leaving DuckDB
// to sniff it avoids a failure seen on large gzip-compressed uploads: the
// auto-sniffer's sampling appears to misdetect the dialect once a compressed
// file gets big enough, even though the same file works fine uncompressed or
// small. Every export from this source is plain comma-delimited with a
// header row, so pinning these is safe and sidesteps that failure mode.
async function ingestCsvInto(run, exec, csvPath, targetTable, options = {}) {
  const compressionArg = options.compressed ? `, compression='gzip'` : '';
  // Encoding is detected per file. Some exports are valid UTF-8; others (the
  // original source export) are cp1252 -- at least one outlet (Sahat) has a
  // raw single-byte 0xA0 (non-breaking space) in its name, which is invalid
  // UTF-8. Under utf-8, ignore_errors below drops that whole LINE before it
  // reaches `total` (never counted as `skipped` either), so every row of that
  // outlet silently vanished. So: utf-8 only when the file is verifiably valid
  // UTF-8, otherwise latin-1, which maps every byte to a character and so can
  // never drop a line. (Hardcoding either one breaks the other kind of file.)
  const encoding = await detectCsvEncoding(csvPath, !!options.compressed);
  console.log(`[ingest] ${targetTable}: decoding ${csvPath} as ${encoding}`);
  const dialectArgs = `, delim=',', quote='"', escape='"', header=true, strict_mode=false, encoding='${encoding}'`;
  // ignore_errors + strict_mode=false cover occasional malformed rows (seen
  // in real data) -- they're skipped rather than failing the whole ingest,
  // consistent with how unparseable trandate rows are already dropped and
  // reported via `skipped` below.
  const desc = await run(`DESCRIBE SELECT * FROM read_csv_auto(${esc(csvPath)}, sample_size=200000, ignore_errors=true${dialectArgs}${compressionArg})`);
  const actualCols = desc.map((d) => d.column_name);
  const r = resolveColumns(actualCols);
  const sel = (canon) => (r[canon] ? `"${r[canon]}"` : 'NULL');
  // A correctly-decoded non-breaking space (U+00A0, from that same raw 0xA0
  // byte) still isn't a plain space -- it would sit silently in the middle
  // of a name like "SAHAT<nbsp>AL<nbsp>MADINA...", never stripped by a
  // leading/trailing TRIM() at query time, and never equal to the same
  // outlet typed with normal spaces anywhere else (targets, filters). Every
  // text column gets it normalized to a plain space at ingest, once, here.
  const txt = (canon) => `REPLACE(CAST(${sel(canon)} AS VARCHAR), CHR(160), ' ')`;
  const stagingTable = `${targetTable}_staging`;
  await exec(`
    CREATE OR REPLACE TABLE ${stagingTable} AS
    SELECT
      ${DATE_EXPR(`"${r.trandate}"`)} AS trandate,
      ${txt('Branch')} AS Branch,
      ${txt('supplier')} AS supplier,
      ${txt('MainGroupName')} AS MainGroupName,
      ${txt('SubGroup')} AS SubGroup,
      ${txt('Subgroup2')} AS Subgroup2,
      ${txt('groupname')} AS groupname,
      ${txt('brand')} AS brand,
      ${txt('itembarcode')} AS itembarcode,
      ${txt('Description')} AS Description,
      ${txt('Unit')} AS Unit,
      TRY_CAST(${sel('TotalQty')} AS DOUBLE) AS TotalQty,
      TRY_CAST("${r.SalesTotal}" AS DOUBLE) AS SalesTotal,
      TRY_CAST(${sel('TotalCost')} AS DOUBLE) AS TotalCost
    FROM read_csv_auto(${esc(csvPath)}, sample_size=200000, ignore_errors=true, all_varchar=false${dialectArgs}${compressionArg})
  `);
  const [{ total }] = await run(`SELECT count(*)::BIGINT AS total FROM ${stagingTable}`);
  const [{ kept }] = await run(`SELECT count(*)::BIGINT AS kept FROM ${stagingTable} WHERE trandate IS NOT NULL`);
  await exec(`CREATE OR REPLACE TABLE ${targetTable} AS SELECT * FROM ${stagingTable} WHERE trandate IS NOT NULL`);
  await exec(`DROP TABLE ${stagingTable}`);
  await exec(`CREATE INDEX IF NOT EXISTS idx_${targetTable}_date ON ${targetTable}(trandate)`);
  return { total: Number(total), kept: Number(kept), skipped: Number(total) - Number(kept), encoding };
}

// Streams the (optionally gzipped) file through a fatal UTF-8 decoder.
// Returns 'utf-8' if every byte sequence is valid, else 'latin-1'.
async function detectCsvEncoding(csvPath, compressed) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    let stream = fs.createReadStream(csvPath);
    if (compressed) stream = stream.pipe(zlib.createGunzip());
    for await (const chunk of stream) decoder.decode(chunk, { stream: true });
    decoder.decode();
    return 'utf-8';
  } catch (e) {
    if (e instanceof TypeError || e.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return 'latin-1';
    throw e;
  }
}

module.exports = { resolveColumns, DATE_EXPR, ingestCsvInto, esc, TABLE_SCHEMA_SQL, CANONICAL_COLUMNS };
