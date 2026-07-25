// ingest.js — CSV ingestion logic shared by server.js (daily uploads, into
// sales_current) and load_history.js (one-time historical load, into
// sales_history). Kept in one place so the two never drift out of sync on
// column matching or date parsing.

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
async function ingestCsvInto(run, exec, csvPath, targetTable) {
  const desc = await run(`DESCRIBE SELECT * FROM read_csv_auto(${esc(csvPath)}, sample_size=200000)`);
  const actualCols = desc.map((d) => d.column_name);
  const r = resolveColumns(actualCols);
  const sel = (canon) => (r[canon] ? `"${r[canon]}"` : 'NULL');
  const stagingTable = `${targetTable}_staging`;
  await exec(`
    CREATE OR REPLACE TABLE ${stagingTable} AS
    SELECT
      ${DATE_EXPR(`"${r.trandate}"`)} AS trandate,
      CAST(${sel('Branch')} AS VARCHAR) AS Branch,
      CAST(${sel('supplier')} AS VARCHAR) AS supplier,
      CAST(${sel('MainGroupName')} AS VARCHAR) AS MainGroupName,
      CAST(${sel('SubGroup')} AS VARCHAR) AS SubGroup,
      CAST(${sel('Subgroup2')} AS VARCHAR) AS Subgroup2,
      CAST(${sel('groupname')} AS VARCHAR) AS groupname,
      CAST(${sel('brand')} AS VARCHAR) AS brand,
      CAST(${sel('itembarcode')} AS VARCHAR) AS itembarcode,
      CAST(${sel('Description')} AS VARCHAR) AS Description,
      CAST(${sel('Unit')} AS VARCHAR) AS Unit,
      TRY_CAST(${sel('TotalQty')} AS DOUBLE) AS TotalQty,
      TRY_CAST("${r.SalesTotal}" AS DOUBLE) AS SalesTotal,
      TRY_CAST(${sel('TotalCost')} AS DOUBLE) AS TotalCost
    FROM read_csv_auto(${esc(csvPath)}, sample_size=200000, ignore_errors=true, all_varchar=false)
  `);
  const [{ total }] = await run(`SELECT count(*)::BIGINT AS total FROM ${stagingTable}`);
  const [{ kept }] = await run(`SELECT count(*)::BIGINT AS kept FROM ${stagingTable} WHERE trandate IS NOT NULL`);
  await exec(`CREATE OR REPLACE TABLE ${targetTable} AS SELECT * FROM ${stagingTable} WHERE trandate IS NOT NULL`);
  await exec(`DROP TABLE ${stagingTable}`);
  await exec(`CREATE INDEX IF NOT EXISTS idx_${targetTable}_date ON ${targetTable}(trandate)`);
  return { total: Number(total), kept: Number(kept), skipped: Number(total) - Number(kept) };
}

module.exports = { resolveColumns, DATE_EXPR, ingestCsvInto, esc, TABLE_SCHEMA_SQL, CANONICAL_COLUMNS };
