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
| `upload_daily.py` | Runs on the HO server at 05:00, finds today's dated export and pushes it to Railway |
| `create_scheduled_task.bat` | One-click helper to register the 05:00 upload task (run on the HO server) |
| `delete_daily_export.py` | Runs on the HO server at 18:00, deletes the day's CSV(s) now that they're already in Railway |
| `create_delete_task.bat` | One-click helper to register the 18:00 cleanup task (run on the HO server) |
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

Afterward, verify with `python --version`. If that says "not recognized" but
double-clicking a `.py` file still runs it fine, try `py --version` instead
— the `py` launcher is registered separately from `python` itself and is
usually more reliable. **This mismatch matters a lot for what follows**: a
Windows Scheduled Task doesn't behave like double-clicking or typing a
command yourself (see the note in step 5 below) — the scripts in this repo
are written assuming `py` is what works, not necessarily `python`.

1. Install Python if it isn't already there (see "Installing Python on the
   HO server" below — there's a specific gotcha worth reading first), then:
   ```
   pip install requests requests-toolbelt
   ```
2. Copy this folder's `upload_daily.py`, `delete_daily_export.py`,
   `upload_config.example.py`, `create_scheduled_task.bat`, and
   `create_delete_task.bat` onto the HO server (anywhere is fine — e.g.
   `C:\iTrade\bi-upload\`).
3. Copy `upload_config.example.py` to `upload_config.py` (same folder) and
   fill in the two values inside it:
   ```python
   SERVER_URL = "https://salem-mall-bi-production.up.railway.app"
   API_KEY = "the-same-string-you-put-in-Railway's-API_KEY-variable"
   ```
   `upload_config.py` is deliberately **not** part of the repo (it's
   gitignored) — it holds a real secret, and this keeps that secret from
   ever ending up in git history. `FOLDER`/`FILENAME_PATTERN` inside
   `upload_daily.py` itself already match `C:\iTrade\SALESALLBRANCHES` and
   normally don't need touching.
4. Test it manually:
   ```
   py upload_daily.py
   ```
   You should see `Upload succeeded: N rows ingested in X.Xs`, and the same
   line appended to a new `upload_log.txt` next to the script. Refresh your
   Railway dashboard URL — your data should now load automatically. If
   today's dated file isn't there yet, it'll say so and fall back to the
   newest one it can find — don't ignore that warning, it means the iTrade
   export didn't run today.
5. Automate the upload: double-click `create_scheduled_task.bat` on the HO
   server. It registers a Windows Task Scheduler job named
   `SalemMallBIUpload` that runs `upload_daily.py` daily at **05:00** — an
   hour after iTrade's 04:00 export, so the file is always fully written by
   the time this runs, and well clear of ~7am when people start checking the
   dashboard.

   **Important — a scheduled run is not the same as running it yourself:**
   Task Scheduler launches the script's "Program" (`py`) by looking it up
   via **its own** process's PATH, which is often stale or different from an
   interactive Command Prompt session's — so `python upload_daily.py`
   working perfectly when you type it yourself does NOT guarantee the
   scheduled task can find `python` too. This exact mismatch (works
   manually, silently does nothing on schedule) is why the `.bat` files
   here launch via the full path to the **`py` launcher**
   (`%SystemRoot%\py.exe`) instead of bare `python` — `C:\Windows` is always
   on every process's PATH, launcher included, regardless of how Python
   itself was installed. After running the `.bat`, right-click the task in
   Task Scheduler → **Run** once, then check `upload_log.txt` to confirm it
   actually completed — don't just trust that registering the task worked.

   Prefer to do it by hand instead of the `.bat` file? Open **Task Scheduler
   → Create Basic Task** → Trigger: Daily at 05:00 → Action: **Start a
   program** → Program: `%SystemRoot%\py.exe`, Arguments:
   `-3 "C:\full\path\to\upload_daily.py"`.

6. Automate the cleanup: double-click `create_delete_task.bat` on the HO
   server. It registers a second job, `SalemMallBIDeleteExport`, that runs
   `delete_daily_export.py` daily at **18:00** (also via the `py` launcher,
   same reasoning as above) — well after the 05:00 upload, so the file is
   already safely in Railway before it's removed, logging to
   `delete_log.txt` next to the script. This keeps
   `C:\iTrade\SALESALLBRANCHES` from filling up with a new ~1GB file every
   day forever. It also cleans up any older leftover exports it finds, as a
   safety net if a previous day's cleanup was ever missed.

---

## Day-to-day after setup

```
04:00  iTrade writes Sales_All_Branches_YYYYMMDD.csv
05:00  upload_daily.py (HO server) pushes it to Railway; DuckDB ingests it
       server-side (roughly 30–60s at ~1M rows/1GB — nobody waits on it)
~07:00 Anyone who opens the Railway URL sees the dashboard auto-load that
       data in milliseconds — no manual file drop needed
18:00  delete_daily_export.py (HO server) deletes that day's CSV — it's
       already safely in Railway by now
```

Manual drag-and-drop/file-picker upload on the dashboard still works too
(e.g. for ad-hoc testing), and there's a **⟳ Refresh from server** button to
re-check without a full page reload.

## Things worth knowing

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
