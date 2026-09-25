# Salem Mall BI — Daily Auto-Loading Dashboard on Railway

## The big picture

At 1M+ rows / ~1GB a day, the old "browser downloads and parses the whole
file" design doesn't work — a browser tab can't hold that much data and stay
fast. This version moves the heavy lifting to the server:

```
HO server (C:\iTrade\SALESALLBRANCHES)     Railway (cloud)
┌─────────────────────────────┐            ┌──────────────────────────────────┐
│ iTrade writes a new dated    │            │  Node/Express + DuckDB backend    │
│ CSV daily, e.g.              │            │   - POST /api/upload  (ingest)    │
│ Sales_All_Branches_          │  HTTPS     │   - GET  /api/status              │
│ 20260725.csv                 │  upload    │   - POST /api/distinct            │
│         │                    │ ─────────► │   - POST /api/aggregate           │
│         ▼                    │            │                                    │
│ upload_daily.py               │            │  public/index.html                │
│ (Windows Task Scheduler on   │            │  (your dashboard — every KPI,     │
│  the HO server runs this,    │            │   chart, pivot cell and report    │
│  finds today's dated file,   │            │   row is one small query, not     │
│  uploads it)                 │            │   a full-table download)          │
└─────────────────────────────┘            │             │                      │
                                              │             ▼                      │
                                              │  Anyone with the URL sees the     │
                                              │  dashboard load in milliseconds,  │
                                              │  filters/drill-downs stay instant │
                                              └──────────────────────────────────┘
```

**Why DuckDB, and why the frontend had to change:** the original dashboard
held every row in the browser and filtered a JS array in memory — fine at a
few thousand rows, unworkable at 1M+. Now the server parses the file **once**
per upload straight into a DuckDB file on disk, and the browser never holds
more than the current screen's numbers. Changing a filter or expanding a
pivot row sends one small request and gets back a handful of aggregated
numbers — typically under 100–250ms even on the full 1M-row table, verified
locally before this was handed over.

**CSV vs XLSX:** CSV is ingested directly by DuckDB's native reader — a few
seconds even at 1M+ rows. XLSX is parsed in JavaScript first (via SheetJS)
then handed to DuckDB the same way, which is noticeably slower at large
sizes. iTrade already exports CSV (`Sales_All_Branches_YYYYMMDD.csv`), which
is exactly what makes this fast.

**Note on where this runs:** the daily push runs on the **HO server** —
the same machine iTrade writes its export to — not on your own PC. Each
day's export gets a new filename with the date baked in
(`Sales_All_Branches_20260725.csv`), so `upload_daily.py` doesn't point at
one fixed path; it builds today's expected filename and looks for it, with a
fallback (logged clearly) to the newest matching file if today's isn't there
yet.

---

## What's in this folder

| File | Purpose |
|---|---|
| `server.js` | Backend: serves the dashboard, the password gate, and every query API |
| `ingest.js` | Shared CSV-ingestion logic used by both `server.js` and `load_history.js` |
| `load_history.js` | One-time loader for historical data (e.g. all of 2025) into `sales_history` |
| `package.json` | Node dependencies (Express, Multer, DuckDB, SheetJS) |
| `public/index.html` | Your dashboard — KPIs/charts/pivot/reports now query the server instead of an in-browser array |
| `upload_daily.py` | Runs on the HO server from 05:00 (retrying hourly until 23:00), uploads the day's export once, safe to re-run any number of times |
| `delete_daily_export.py` | Runs on the HO server at 23:30, deletes only exports already confirmed uploaded |
| `SETUP_HO_SERVER.bat` + `setup_ho_server.ps1` | **Double-click once on the HO server** — finds Python, installs packages, registers both tasks, test-runs the upload |
| `public/manifest.webmanifest` | PWA manifest — what makes the browser offer "Install app" |
| `public/sw.js` | Service worker (required for installability) — caches the app shell only, never `/api/*` |
| `public/icons/` | App icons for the install prompt, home screen, and taskbar |
| `data/` | Local only, gitignored — the DuckDB file lives here; on Railway this should be a mounted Volume (see below) |

### Installing the dashboard as an app

The dashboard is a PWA (Progressive Web App) — once it's on Railway (HTTPS
is required for this), open the URL and:

- **Desktop Chrome/Edge**: an install icon (⊕ or a small monitor icon)
  appears in the address bar — click it, or use the browser menu → "Install
  Salem Mall BI…". It opens afterward in its own window, no browser
  tabs/address bar, with a taskbar/dock icon.
- **Android Chrome**: menu → "Add to Home Screen" / "Install app" (may also
  prompt automatically after a couple of visits).
- **iOS Safari**: Share button → "Add to Home Screen".

It'll still ask for the dashboard password (`DASHBOARD_PASSWORD`) on first
launch each time the browser's cached credentials expire — that's normal
for a Basic-Auth-protected app and isn't something the install itself
changes. The service worker only caches the static page shell, never
`/api/*` — so the installed app never risks showing stale sales numbers,
only (at most, and only if offline) a slightly stale *page*.

### The two-table data model

```
sales_history   — loaded once via load_history.js (e.g. all of 2025)
                  never touched by the daily upload
sales_current   — replaced wholesale by every /api/upload (2026 onward,
                  since the iTrade feed only contains 2026-01-01+ now)
sales  (VIEW)   = sales_history UNION ALL sales_current
                  every query in server.js reads from this — history and
                  the daily feed are combined transparently, never overlap
```

This exists because the iTrade export changed to only cover 2026 onward,
but the dashboard should still show 2025 for comparisons/MTD-YTD-style
reports. `load_history.js` is a separate, one-time script (not on any
schedule) specifically because historical files can be much bigger than a
single day's export — the 2025 file was ~3GB / 12.77M rows, well past what
you'd want going over HTTP through `/api/upload`.

---

## Part 1 — Deploy the backend + dashboard to Railway

The code is already on GitHub at
[`salmanfariskabeer/BI-DASHBOARD`](https://github.com/salmanfariskabeer/BI-DASHBOARD)
(`main` branch) — you don't need to push it yourself.

1. In Railway: **New Project → Deploy from GitHub repo** → pick `BI-DASHBOARD`.
   (Or `railway up` from inside this folder if you'd rather deploy from a
   local copy — either works, they're the same code.)
2. Railway auto-detects Node from `package.json` and runs `npm start`. No
   extra build config needed. DuckDB's native binding compiles/installs
   automatically as part of `npm install` — no extra buildpack steps.
3. In your Railway project → **Variables**, add:
   - `API_KEY` = a long random string you make up, e.g. `openssl rand -hex 24`
     (this is the password the HO server uses to push data — keep it secret)
   - `DASHBOARD_PASSWORD` = the password anyone opening the dashboard URL
     needs to type in. Defaults to `13661366` if you don't set this — set it
     explicitly if you want a different one, since the default is now public
     (it's in this README).
4. Under **Settings → Networking**, generate a public domain. You'll get a
   URL like `https://salem-mall-bi-production.up.railway.app` — **this is
   the URL you share with your team**, alongside the password.
5. **Add a Volume** (Settings → Volumes) mounted at, say, `/data`, and set an
   env var `DATA_DIR=/data`. This is more important here than it would be for
   a plain file store — the DuckDB database (both `sales_history` and
   `sales_current`) lives on this volume, and without it a redeploy wipes
   everything, including the 2025 history, until it's reloaded.

Test it: visit the URL. It'll prompt for the password (browser's native
login box) — enter `DASHBOARD_PASSWORD`. After that you should see the empty
state (it checks `/api/status`, finds nothing yet) — expected until history
is loaded (below) and Part 2 starts pushing daily data.

### Loading 2025 history onto Railway

`load_history.js` needs direct access to the same DuckDB file the server
uses, and DuckDB only allows one process to hold that file open at a time —
so this can't run as a normal HTTP upload. Easiest path:

1. Stop the Railway service (or scale it to 0) so nothing else has the
   volume's database file open.
2. Use `railway run node load_history.js "<path>"` with the 2025 CSV
   accessible to that command (e.g. via a Railway shell/SFTP into the volume,
   or temporarily via `railway volume` tooling) — or, if that's awkward,
   run `load_history.js` locally against a copy of the Railway volume's
   `warehouse.duckdb`, then upload the resulting file back to the volume.
3. Restart the service. `/api/status` should now show ~12.77M rows and a
   2025-01-01 to 2025-12-31 date range even before any daily upload happens.

This is a one-time step — once `sales_history` is populated on the volume,
it survives redeploys (as long as the Volume itself isn't deleted) and
`upload_daily.py` never touches it.

---

## Part 2 — Set it up on the HO server

RDP into the HO server (the one iTrade exports to) and do this there, not on
your own PC:

### Installing Python on the HO server

Easiest is `winget install Python.Python.3.12` in an elevated Command Prompt
(built into Windows 10/11, no browser needed) — close and reopen the
terminal afterward so it picks up the updated PATH. Otherwise, download the
installer from [python.org/downloads](https://www.python.org/downloads/) and
run it, ticking **"Add python.exe to PATH"** on the first screen (easy to
miss).

Afterward, verify with `py --version` or `python --version`.

### Setting up the HO server (one time)

1. Copy `upload_daily.py`, `delete_daily_export.py`, `upload_config.py`,
   `SETUP_HO_SERVER.bat` and `setup_ho_server.ps1` into one folder on the
   HO server (e.g. `D:\sftp pushing for bi dashboard\`). `upload_config.py`
   holds `SERVER_URL` and `API_KEY` (copy it from `upload_config.example.py`
   if you're starting fresh). It is gitignored and never committed.
2. **Double-click `SETUP_HO_SERVER.bat`** and click Yes on the admin prompt.
   It:
   - finds the real `python.exe` and bakes its **full path** into the task
     (the old task ran bare `python`, which Task Scheduler couldn't find, so
     it never fired and the upload had to be opened by hand every day)
   - installs `requests` / `requests-toolbelt` for that exact Python
   - removes the old tasks and registers `SalemMallBIUpload` (05:00, then
     hourly until 23:00) and `SalemMallBIDeleteExport` (23:30). Both run
     **whether or not anyone is logged in**, catch up if the server was off,
     and run hidden
   - test-runs the upload through Task Scheduler itself and prints the result
3. If it ends with a green **SUCCESS**, you're done. Re-run it any time, for
   example after moving the folder.

How the upload stays reliable: each run checks `upload_state.json`. If
today's file was already uploaded, it exits silently. If the file isn't there
yet, or iTrade is still writing it, or the network fails (3 in-process
retries), the next hourly run simply tries again. The cleanup only deletes a
file recorded as uploaded, or one older than it (each export is cumulative
YTD), so a failed upload never loses the file.

Manual run on the HO server: `py upload_daily.py` (add `--force` to
re-upload even if today's file was already sent).

---

## Day-to-day after setup

```
04:00  iTrade writes Sales_All_Branches_YYYYMMDD.csv
05:00  upload_daily.py (HO server) pushes it to Railway; DuckDB ingests it
       server-side (~15s). Re-tries hourly until 23:00 if anything failed
~07:00 Anyone who opens the Railway URL sees the dashboard auto-load that
       data in milliseconds — no manual file drop needed
23:30  delete_daily_export.py (HO server) deletes the CSV, but only if it
       was confirmed uploaded
```

Manual drag-and-drop/file-picker upload on the dashboard still works too
(e.g. for ad-hoc testing), and there's a **⟳ Refresh from server** button to
re-check without a full page reload.

## Monthly targets: Settings import + Target vs Actual (day-wise) report

**Settings → Monthly Targets**: import the monthly target workbook (e.g.
`targets-all-outlets-2026-09.xlsx`: one sheet per outlet, title
`Sales Target Report – <OUTLET> – YYYY-MM`, columns Class Name / Staff Name /
Supervisor / Sales Target / Profit Target). The import replaces that month's
targets for every outlet in the file. Rows with zero targets and the
TOTAL/ASSIGNED rows are skipped. Class names are mapped to the sales data's
spelling (e.g. `FISH & SEA FOOD` → `FISH`, `FOOTWEAR` → `FOOT WEAR`; see
`CLASS_ALIASES` in `server.js`), and any outlet or class it can't match is
listed after the import. Values can also be edited by hand per month, outlet
and class.

**Reports → Target vs Actual**: pick the month, and "Actual sales till"
defaults to **yesterday** (capped at the last date loaded on the server).
- Daily target = monthly target ÷ days in the month; target till date =
  daily target × days elapsed.
- KPI cards: month target, target till date, actual till date, achievement %,
  variance, balance for the month, required per day for the remaining days,
  run-rate forecast, and profit (GP) vs profit target.
- Outlet → class table (with staff and supervisor), a day-wise table
  (choose outlet/class) with daily and cumulative achievement, and an
  outlet × day grid.
- Outlet actuals count only classes that have a target. Sales in other classes
  (e.g. shop consumption) are shown separately and not counted.
- Excel export gives three sheets: Outlet & Class, Day-wise, Outlet x Day.
- Only the top-bar Outlet filter applies; the date, category, class and
  supplier filters don't.

## Outlet filter: tick which ones to include

The Outlet filter (top filter bar) is a checkbox dropdown, not a
single-select — tick/untick any combination of outlets, with **All**/**None**
shortcuts. Unticking everything shows zero rows (not a silent fallback to
"all") — that's the one state a tick-list has to represent honestly, so
"the dashboard looks empty" there means exactly what it looks like.
Category/Class/Supplier filters remain single-select.

## Things worth knowing

- **Troubleshooting a missed day**: check `upload_log.txt` next to the
  script first (what the script saw and did), then the task's own history:
  ```powershell
  Get-ScheduledTaskInfo -TaskName "SalemMallBIUpload"
  ```
  `LastTaskResult` of `0` means it ran and exited cleanly. A `LastRunTime`
  that isn't from today means the task itself didn't fire, so re-run
  `SETUP_HO_SERVER.bat`.
- **What changed vs. the first version you got**: that version stored the
  raw file and let the browser parse it — fine at small scale, not viable at
  1M+ rows. This version ingests into DuckDB server-side and the dashboard's
  KPI cards, charts, pivot explorer (including drill-down and column
  compare), and every report now ask the server for aggregated numbers
  instead of holding rows in the browser. Calculated fields, saved layouts,
  and CSV/Excel export of whatever's on screen all work exactly as before —
  those only ever operated on small aggregated results, not raw rows.
- **History vs. daily snapshot**: `sales_current` holds one snapshot (the
  latest daily file, 2026 onward) — `sales_history` is what carries 2025 and
  isn't touched by daily uploads. MTD/YTD and custom-date-variance reports
  re-query the combined `sales` view with different date ranges, so they
  work across the 2025/2026 boundary without any extra work. If you ever
  want day-by-day historical retention *within* 2026 too (e.g. "what did
  today's file say last Tuesday"), that's a bigger step — the daily job
  would need to accumulate instead of replace `sales_current`.
- **Security**: the dashboard and all read APIs require the
  `DASHBOARD_PASSWORD` (HTTP Basic Auth — browsers show their native login
  prompt). `/api/upload` is separately protected by its own `API_KEY` header
  and is deliberately *not* behind the password gate, since `upload_daily.py`
  on the HO server is a script, not someone typing a password. This is a
  password lock, not full user accounts — anyone with the one password sees
  everything; there's no per-user access control.
- **2025 data quality flag**: the loaded 2025 history shows total cost
  running at ~2.5x total sales (a -147% gross margin for the year), driven
  almost entirely by the SUPERMARKET and FRESH FOOD categories. This was
  verified against the raw file (row counts match exactly, sample rows are
  internally consistent with the file's own `Profit` column) — it's what's
  actually in the export, not an ingestion bug. Worth confirming with
  whoever owns the iTrade export whether `TotalCost` includes something
  beyond COGS for those categories before trusting margin numbers from 2025
  in front of anyone.
- **File size**: Multer is capped at 2GB per upload here — comfortably above
  a ~1GB daily export. Raise `upload`'s `limits.fileSize` in `server.js` if
  you ever need more.
- **Required columns**: the server expects at minimum `trandate` and
  `SalesTotal` in the uploaded file (matching your source columns —
  `comp_ID`, `Branch`, `supplier`, `MainGroupName`, `SubGroup`, `Subgroup2`,
  `groupname`, `brand`, `itembarcode`, `Description`, `Unit`, `TotalQty`,
  `TotalCost` are all read too, matched by name case-insensitively). If a
  required column is missing, the upload fails with a clear error listing
  what columns it actually found — check that message first if an upload
  ever fails.
- **GP/Margin**: computed server-side as `SalesTotal - TotalCost`, the same
  way the original dashboard computed it in the browser. The `Profit`/
  `Margin` columns in the source file itself are not used, so numbers stay
  consistent with every past export from this dashboard.
- **Keep the two scripts in sync**: `upload_daily.py` and
  `delete_daily_export.py` each have their own `FOLDER`/`FILENAME_PATTERN` at
  the top. If the export ever moves or gets renamed, update both — the
  cleanup script only recognizes and deletes files matching that pattern, so
  a mismatch just means it quietly deletes nothing (fails safe), not that it
  deletes the wrong thing.
