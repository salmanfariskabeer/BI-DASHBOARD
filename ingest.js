// ingest.js — CSV ingestion logic shared by server.js (daily uploads, into
// sales_current) and load_history.js (one-time historical load, into
// sales_history). Kept in one place so the two never drift out of sync on
// column matching or date parsing.

const fs = require('fs');
const zlib = require('zlib');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

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
  // The export is often MIXED: valid UTF-8 text plus stray cp1252 bytes (e.g.
  // Sahat's raw 0xA0 non-breaking space). Neither utf-8 (ignore_errors silently
  // drops the whole line, so all of that outlet's rows vanished) nor DuckDB's
  // strict latin-1 ("File is not latin-1 encoded") handles that. So: if the
  // file isn't clean UTF-8, transcode it in Node -- valid UTF-8 sequences pass
  // through, any stray byte is converted from cp1252 -- and hand DuckDB UTF-8.
  let readPath = csvPath, tmpPath = null, encoding = 'utf-8';
  if (!(await isValidUtf8(csvPath, !!options.compressed))) {
    tmpPath = `${csvPath}.utf8.tmp`;
    await transcodeToUtf8(csvPath, tmpPath, !!options.compressed);
    readPath = tmpPath;
    encoding = 'cp1252->utf-8';
  }
  console.log(`[ingest] ${targetTable}: ${csvPath} encoding=${encoding}`);
  options = tmpPath ? { ...options, compressed: false } : options;
  const compressionArg = options.compressed ? `, compression='gzip'` : '';
  const dialectArgs = `, delim=',', quote='"', escape='"', header=true, strict_mode=false, encoding='utf-8'`;
  try {
  // ignore_errors + strict_mode=false cover occasional malformed rows (seen
  // in real data) -- they're skipped rather than failing the whole ingest,
  // consistent with how unparseable trandate rows are already dropped and
  // reported via `skipped` below.
  const desc = await run(`DESCRIBE SELECT * FROM read_csv_auto(${esc(readPath)}, sample_size=200000, ignore_errors=true${dialectArgs}${compressionArg})`);
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
    FROM read_csv_auto(${esc(readPath)}, sample_size=200000, ignore_errors=true, all_varchar=false${dialectArgs}${compressionArg})
  `);
  const [{ total }] = await run(`SELECT count(*)::BIGINT AS total FROM ${stagingTable}`);
  const [{ kept }] = await run(`SELECT count(*)::BIGINT AS kept FROM ${stagingTable} WHERE trandate IS NOT NULL`);
  await exec(`CREATE OR REPLACE TABLE ${targetTable} AS SELECT * FROM ${stagingTable} WHERE trandate IS NOT NULL`);
  await exec(`DROP TABLE ${stagingTable}`);
  await exec(`CREATE INDEX IF NOT EXISTS idx_${targetTable}_date ON ${targetTable}(trandate)`);
  return { total: Number(total), kept: Number(kept), skipped: Number(total) - Number(kept), encoding };
  } finally {
    if (tmpPath) fs.promises.unlink(tmpPath).catch(() => {});
  }
}

const CP1252 = (() => {
  const dec = new TextDecoder('windows-1252');
  return Array.from({ length: 256 }, (_, i) => Buffer.from(dec.decode(Uint8Array.of(i)), 'utf8'));
})();

function openSource(p, compressed) {
  const st = fs.createReadStream(p);
  return compressed ? st.pipe(zlib.createGunzip()) : st;
}

async function isValidUtf8(p, compressed) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for await (const chunk of openSource(p, compressed)) decoder.decode(chunk, { stream: true });
    decoder.decode();
    return true;
  } catch (e) {
    if (e instanceof TypeError || e.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return false;
    throw e;
  }
}

// Length of a valid UTF-8 sequence starting at buf[i], 0 if invalid, -1 if
// it may be valid but is cut off by the end of the buffer.
function utf8SeqLen(buf, i) {
  const b = buf[i];
  const n = b >= 0xC2 && b <= 0xDF ? 2 : b >= 0xE0 && b <= 0xEF ? 3 : b >= 0xF0 && b <= 0xF4 ? 4 : 0;
  if (!n) return 0;
  for (let k = 1; k < n; k++) {
    if (i + k >= buf.length) return -1;
    if ((buf[i + k] & 0xC0) !== 0x80) return 0;
  }
  if (b === 0xE0 && buf[i + 1] < 0xA0) return 0;
  if (b === 0xED && buf[i + 1] > 0x9F) return 0;
  if (b === 0xF0 && buf[i + 1] < 0x90) return 0;
  if (b === 0xF4 && buf[i + 1] > 0x8F) return 0;
  return n;
}

function mixedToUtf8Transform() {
  let carry = Buffer.alloc(0);
  const convert = (buf, final) => {
    const out = [];
    let run = 0, i = 0;
    while (i < buf.length) {
      if (buf[i] < 0x80) { i++; continue; }
      const n = utf8SeqLen(buf, i);
      if (n > 0) { i += n; continue; }
      if (n < 0 && !final) break;
      if (i > run) out.push(buf.subarray(run, i));
      out.push(CP1252[buf[i]]);
      i++; run = i;
    }
    if (i > run) out.push(buf.subarray(run, i));
    carry = i < buf.length ? Buffer.from(buf.subarray(i)) : Buffer.alloc(0);
    return Buffer.concat(out);
  };
  return new Transform({
    transform(chunk, _e, cb) { cb(null, convert(Buffer.concat([carry, chunk]), false)); },
    flush(cb) { cb(null, convert(carry, true)); },
  });
}

async function transcodeToUtf8(src, dest, compressed) {
  await pipeline(openSource(src, compressed), mixedToUtf8Transform(), fs.createWriteStream(dest));
}

module.exports = { resolveColumns, DATE_EXPR, ingestCsvInto, esc, TABLE_SCHEMA_SQL, CANONICAL_COLUMNS };
