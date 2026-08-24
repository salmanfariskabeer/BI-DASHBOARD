// server.js — Salem Mall BI backend.
//
// Ingests the daily sales export (CSV preferred, XLSX also accepted) into a
// DuckDB file on disk, then answers every dashboard request with a small
// aggregated query against it. The browser never holds the raw rows — at
// 1M+ rows/day that's the difference between "instant" and "unusable".
//
// Data model: two tables behind one view.
//   sales_history — loaded once via load_history.js (e.g. all of 2025),
//                   never touched by the daily upload.
//   sales_current — replaced wholesale by every /api/upload (2026 onwards).
//   sales         — a VIEW = sales_history UNION ALL sales_current. Every
//                   query below reads from `sales`, so history and the daily
//                   feed are transparently combined without the two ever
//                   overlapping or double-counting.

const express = require('express');
const multer = require('multer');
const duckdb = require('duckdb');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { ingestCsvInto, TABLE_SCHEMA_SQL } = require('./ingest');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '13661366';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'warehouse.duckdb');
const TMP_DIR = path.join(DATA_DIR, 'incoming');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

const db = new duckdb.Database(DB_PATH);
const con = db.connect();

function run(sql) {
  return new Promise((resolve, reject) => con.all(sql, (err, rows) => (err ? reject(err) : resolve(rows))));
}
function exec(sql) {
  return new Promise((resolve, reject) => con.run(sql, (err) => (err ? reject(err) : resolve())));
}

/* ============================================================
   DIMENSION MODEL — maps the app's field keys to SQL over the raw
   source columns (trandate, Branch, supplier, MainGroupName, SubGroup,
   Subgroup2, groupname, brand, itembarcode, Description, Unit, TotalQty,
   SalesTotal, TotalCost). Profit/Margin from the source file are ignored;
   GP and GP% are derived from SalesTotal-TotalCost, matching the original
   client-side dashboard so every number stays consistent with past exports.
   ============================================================ */
const DIM_SQL = {
  outlet: "COALESCE(NULLIF(TRIM(Branch),''), 'Unknown Outlet')",
  category: "COALESCE(NULLIF(TRIM(MainGroupName),''), '(Uncategorized)')",
  class_: "COALESCE(NULLIF(TRIM(SubGroup),''), '(Unclassified)')",
  subclass: "COALESCE(NULLIF(TRIM(Subgroup2),''), '')",
  group: "COALESCE(NULLIF(TRIM(groupname),''), '')",
  brand: "COALESCE(NULLIF(TRIM(brand),''), 'NO BRAND')",
  supplier: "COALESCE(NULLIF(TRIM(supplier),''), 'UNSPECIFIED')",
  item: "COALESCE(TRIM(Description),'')",
  month: "strftime(trandate, '%Y-%m')",
  weekday: "strftime(trandate, '%a')",
  day: "strftime(trandate, '%Y-%m-%d')",
};
const BASE_FILTER_DIMS = ['outlet', 'category', 'class_', 'supplier'];
const METRIC_KEYS = ['sales', 'cost', 'gp', 'gppct', 'qty', 'count', 'daysSold'];

function dimExpr(dim) {
  const expr = DIM_SQL[dim];
  if (!expr) throw new Error('Unknown dimension: ' + dim);
  return expr;
}
function esc(v) {
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function buildWhere(filters, extra) {
  const clauses = ['1=1'];
  filters = filters || {};
  for (const key of BASE_FILTER_DIMS) {
    const val = filters[key];
    if (val && val !== 'All') clauses.push(`${dimExpr(key)} = ${esc(val)}`);
  }
  if (filters.dateFrom) clauses.push(`trandate >= ${esc(filters.dateFrom)}::DATE`);
  if (filters.dateTo) clauses.push(`trandate < ${esc(filters.dateTo)}::DATE + INTERVAL 1 DAY`);
  for (const e of extra || []) {
    if (!e || !e.dim || !Array.isArray(e.values) || e.values.length === 0) continue;
    clauses.push(`${dimExpr(e.dim)} IN (${e.values.map(esc).join(',')})`);
  }
  return clauses.join(' AND ');
}
// daysSold = COUNT(DISTINCT trandate): how many distinct calendar days within
// the filtered range had at least one sale for whatever's being grouped (an
// item, a category, ...) -- a "how often does this actually sell" measure,
// separate from count (row/line-item volume, which drives Avg Basket Value
// and shouldn't be redefined to mean something else).
const SUM_SELECT = `SUM(SalesTotal)::DOUBLE AS sales, SUM(TotalCost)::DOUBLE AS cost, SUM(TotalQty)::DOUBLE AS qty, COUNT(*)::BIGINT AS count, COUNT(DISTINCT trandate)::BIGINT AS daysSold`;
function withDerived(row) {
  const sales = row.sales || 0, cost = row.cost || 0, gp = sales - cost;
  return { sales, cost, gp, gppct: sales !== 0 ? gp / sales : 0, qty: row.qty || 0, count: Number(row.count) || 0, daysSold: Number(row.daysSold) || 0 };
}

/* ============================================================
   INGEST
   ============================================================ */
async function ingestFromCsv(csvPath, targetTable, options) {
  return ingestCsvInto(run, exec, csvPath, targetTable, options);
}

// XLSX: parsed with SheetJS (same header-detection idea as the old client-side
// loader — scan sheets for one containing "trandate"), then written out as a
// temp CSV so ingestion reuses the exact same, already-tested CSV path.
function findDataSheetXlsx(wb) {
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet || !sheet['!ref']) continue;
    const json = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });
    if (json.length && Object.keys(json[0]).some((k) => k.trim().toLowerCase() === 'trandate')) {
      return { name, json };
    }
  }
  return null;
}
function csvEscapeCell(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
async function ingestFromXlsx(xlsxPath, targetTable) {
  const wb = XLSX.readFile(xlsxPath, { cellDates: true });
  const found = findDataSheetXlsx(wb);
  if (!found) throw new Error('Could not find a sheet containing a "trandate" column in this workbook.');
  const rows = found.json;
  if (!rows.length) throw new Error('That sheet has no data rows.');
  const headers = Object.keys(rows[0]);
  const csvPath = xlsxPath + '.csv';
  const stream = fs.createWriteStream(csvPath);
  stream.write(headers.map(csvEscapeCell).join(',') + '\n');
  for (const row of rows) stream.write(headers.map((h) => csvEscapeCell(row[h])).join(',') + '\n');
  await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));
  try {
    return await ingestFromCsv(csvPath, targetTable);
  } finally {
    fs.unlink(csvPath, () => {});
  }
}

async function ensureSchema() {
  await exec(`CREATE TABLE IF NOT EXISTS sales_history (${TABLE_SCHEMA_SQL})`);
  await exec(`CREATE TABLE IF NOT EXISTS sales_current (${TABLE_SCHEMA_SQL})`);
  await exec(`CREATE OR REPLACE VIEW sales AS SELECT * FROM sales_history UNION ALL SELECT * FROM sales_current`);
}

/* ============================================================
   EXPRESS APP
   ============================================================ */
const app = express();
app.use(express.json({ limit: '2mb' }));

const upload = multer({ dest: TMP_DIR, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

function requireKey(req, res, next) {
  if (!API_KEY) return next();
  if ((req.header('x-api-key') || req.query.key) !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

// Shared by both ingest routes below — only the target table differs.
async function handleUpload(req, res, targetTable) {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected multipart field "file")' });
  const name = req.file.originalname.toLowerCase();
  const gzipped = name.endsWith('.gz');
  const ext = (gzipped ? name.slice(0, -3) : name).split('.').pop() || '';

  // Multer saves the upload under a random extensionless temp name, but
  // DuckDB's CSV reader decides whether to gzip-decompress based on the
  // file's *extension*, not just the explicit compression= option — so we
  // give the temp file back its real extension before handing it to DuckDB.
  const workPath = req.file.path + (gzipped ? '.csv.gz' : ext === 'csv' ? '.csv' : `.${ext}`);
  fs.renameSync(req.file.path, workPath);

  const start = Date.now();
  try {
    let result;
    // Gzip is only supported for the raw-CSV path — DuckDB's CSV reader
    // decompresses it directly, so a large upload transfers in a fraction of
    // the time and bytes (large win on slower office links, where
    // uncompressed transfers were hitting the edge's request timeout).
    if (ext === 'csv') result = await ingestFromCsv(workPath, targetTable, { compressed: gzipped });
    else if (!gzipped && (ext === 'xlsx' || ext === 'xls')) result = await ingestFromXlsx(workPath, targetTable);
    else return res.status(400).json({ error: 'Only .csv, .csv.gz, .xlsx or .xls files are accepted' });

    const meta = {
      filename: req.file.originalname, table: targetTable, rows: result.kept, skipped: result.skipped,
      uploadedAt: new Date().toISOString(), ingestMs: Date.now() - start,
    };
    if (targetTable === 'sales_current') {
      fs.writeFileSync(path.join(DATA_DIR, 'last_upload.json'), JSON.stringify(meta));
    }
    res.json({ ok: true, ...meta });
  } catch (err) {
    console.error('Upload/ingest error:', err);
    res.status(500).json({ error: 'Ingest failed: ' + err.message });
  } finally {
    fs.unlink(workPath, () => {});
  }
}

// Only guards the daily ingest, which authenticates with its own API_KEY —
// registered before the password gate below so upload_daily.py on the HO
// server never has to deal with a browser-style password prompt.
app.post('/api/upload', requireKey, upload.single('file'), (req, res) => handleUpload(req, res, 'sales_current'));

// One-off historical loads (e.g. a full prior year) go into sales_history
// instead of sales_current, so they never get wiped by the next daily
// upload. Same auth, same gzip support, same size limits as /api/upload —
// this exists so a large one-time load can go through the same proven HTTP
// path instead of needing direct volume/DuckDB-file access.
app.post('/api/upload-history', requireKey, upload.single('file'), (req, res) => handleUpload(req, res, 'sales_history'));

// --- Password gate — everything below this line requires it. ---
// A native browser Basic Auth prompt: simplest thing that actually blocks
// both the page and the API (a client-side-only lock could be bypassed by
// hitting /api/aggregate directly), with no separate login page to build.
function requirePassword(req, res, next) {
  const auth = req.headers.authorization || '';
  const [scheme, encoded] = auth.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    if (pass === DASHBOARD_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Salem Mall BI Dashboard"');
  res.status(401).send('Password required.');
}
app.use(requirePassword);

app.get('/api/status', async (req, res) => {
  try {
    const [row] = await run(`SELECT count(*)::BIGINT AS n, min(trandate) AS dmin, max(trandate) AS dmax FROM sales`);
    let lastUpload = {};
    try { lastUpload = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'last_upload.json'), 'utf8')); } catch (e) {}
    res.json({
      loaded: Number(row.n) > 0,
      rows: Number(row.n),
      dateMin: row.dmin ? new Date(row.dmin).toISOString().slice(0, 10) : null,
      dateMax: row.dmax ? new Date(row.dmax).toISOString().slice(0, 10) : null,
      lastUpload,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Distinct values for a dimension — powers filter dropdowns and the pivot's value pickers.
app.post('/api/distinct', async (req, res) => {
  try {
    const { dim, filters, extra } = req.body || {};
    const where = buildWhere(filters, extra);
    const rows = await run(`
      SELECT DISTINCT ${dimExpr(dim)} AS v FROM sales
      WHERE ${where} AND ${dimExpr(dim)} <> ''
      ORDER BY 1
    `);
    res.json({ values: rows.map((r) => r.v) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/*
  Generic aggregation — every KPI card, chart, pivot cell and report row is
  one call to this. The browser only ever asks "give me the sums for this
  slice"; the full table never leaves the server.

  Body: { filters, extra:[{dim,values}], groupBy, columnDim, limit, sortMetric, sortDir }
*/
app.post('/api/aggregate', async (req, res) => {
  try {
    const { filters, extra, groupBy, columnDim, limit, sortMetric, sortDir } = req.body || {};
    const where = buildWhere(filters, extra);
    const metric = METRIC_KEYS.includes(sortMetric) ? sortMetric : 'sales';
    const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
    // Built from the raw SUM(...) expressions rather than the `sales`/`cost`
    // aliases: those alias names collide with the `sales` view itself once
    // used inside a compound expression like (sales - cost) — DuckDB's
    // binder resolves the bare identifier to the FROM-clause relation (a
    // STRUCT) instead of the SELECT-list alias, and errors. Referencing
    // SUM(SalesTotal)/SUM(TotalCost) directly sidesteps the collision.
    const orderExpr = metric === 'gp' ? '(SUM(SalesTotal) - SUM(TotalCost))'
      : metric === 'gppct' ? '(CASE WHEN SUM(SalesTotal)<>0 THEN (SUM(SalesTotal)-SUM(TotalCost))/SUM(SalesTotal) ELSE 0 END)'
      : metric;

    const [grandRow] = await run(`SELECT ${SUM_SELECT} FROM sales WHERE ${where}`);
    const grand = withDerived(grandRow);

    if (!groupBy) return res.json({ rows: [], grand, totalGroups: 0 });

    const [tg] = await run(`SELECT count(DISTINCT ${dimExpr(groupBy)})::BIGINT AS n FROM sales WHERE ${where}`);
    const totalGroups = Number(tg.n);
    const lim = limit ? `LIMIT ${Math.max(1, parseInt(limit, 10))}` : '';

    const ranked = await run(`
      SELECT ${dimExpr(groupBy)} AS key, ${SUM_SELECT}
      FROM sales WHERE ${where}
      GROUP BY key
      ORDER BY ${orderExpr} ${dir}
      ${lim}
    `);
    const rowsOut = ranked.map((r) => ({ key: r.key, ...withDerived(r) }));

    if (!columnDim) return res.json({ rows: rowsOut, grand, totalGroups });

    let cells = [];
    if (ranked.length) {
      const keyList = ranked.map((r) => esc(r.key)).join(',');
      const cellRows = await run(`
        SELECT ${dimExpr(groupBy)} AS key, ${dimExpr(columnDim)} AS colKey, ${SUM_SELECT}
        FROM sales WHERE ${where} AND ${dimExpr(groupBy)} IN (${keyList})
        GROUP BY key, colKey
      `);
      cells = cellRows.map((r) => ({ key: r.key, colKey: r.colKey, ...withDerived(r) }));
    }
    res.json({ rows: rowsOut, cells, grand, totalGroups });
  } catch (err) {
    console.error('Aggregate error:', err);
    res.status(400).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Salem Mall BI backend listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });
