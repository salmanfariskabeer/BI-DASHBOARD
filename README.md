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
| `server.js` | Backend: ingests CSV/XLSX into DuckDB, serves the dashboard, answers every query |
| `package.json` | Node dependencies (Express, Multer, DuckDB, SheetJS) |
| `public/index.html` | Your dashboard — KPIs/charts/pivot/reports now query the server instead of an in-browser array |
| `upload_daily.py` | Runs on the HO server at 05:00, finds today's dated export and pushes it to Railway |
| `create_scheduled_task.bat` | One-click helper to register the 05:00 upload task (run on the HO server) |
| `delete_daily_export.py` | Runs on the HO server at 18:00, deletes the day's CSV(s) now that they're already in Railway |
| `create_delete_task.bat` | One-click helper to register the 18:00 cleanup task (run on the HO server) |
| `data/` | Local only — the DuckDB file lives here; on Railway this should be a mounted Volume (see below) |

---

## Part 1 — Deploy the backend + dashboard to Railway

1. Push this folder to a new GitHub repo (or use the Railway CLI to deploy a
   local folder directly — `railway up` from inside this folder works too).
2. In Railway: **New Project → Deploy from GitHub repo** (or `railway up`).
3. Railway auto-detects Node from `package.json` and runs `npm start`. No
   extra build config needed. DuckDB's native binding compiles/installs
   automatically as part of `npm install` — no extra buildpack steps.
4. In your Railway project → **Variables**, add:
   - `API_KEY` = a long random string you make up, e.g. `openssl rand -hex 24`
     (this is the password the HO server uses to push data — keep it secret)
5. Under **Settings → Networking**, generate a public domain. You'll get a
   URL like `https://salem-mall-bi-production.up.railway.app` — **this is
   the URL you share with your team.**
6. **Add a Volume** (Settings → Volumes) mounted at, say, `/data`, and set an
   env var `DATA_DIR=/data`. This is more important here than it would be for
   a plain file store — the DuckDB database lives on this volume, and without
   it a redeploy wipes the ingested data until the next scheduled push.

Test it: visit the URL. You should see the empty state (it checks
`/api/status`, finds nothing yet, and waits) — expected until Part 2 pushes
real data.

---

## Part 2 — Set it up on the HO server

RDP into the HO server (the one iTrade exports to) and do this there, not on
your own PC:

1. Install Python if it isn't already there, then:
   ```
   pip install requests
   ```
2. Copy this folder's `upload_daily.py` and `create_scheduled_task.bat` onto
   the HO server (anywhere is fine — e.g. `C:\iTrade\bi-upload\`).
3. Open `upload_daily.py` and edit the values at the top:
   ```python
   FOLDER = r"C:\iTrade\SALESALLBRANCHES"
   FILENAME_PATTERN = "Sales_All_Branches_{date}.csv"   # already matches your export's naming
   SERVER_URL = "https://salem-mall-bi-production.up.railway.app"
   API_KEY = "the-same-string-you-put-in-Railway's-API_KEY-variable"
   ```
   `FOLDER` and `FILENAME_PATTERN` already match what's in
   `C:\iTrade\SALESALLBRANCHES` — only `SERVER_URL` and `API_KEY` should need
   changing, unless the export ever gets renamed.
4. Test it manually:
   ```
   python upload_daily.py
   ```
   You should see `Upload succeeded: N rows ingested in X.Xs`. Refresh your
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

   Prefer to do it by hand instead of the `.bat` file? Open **Task Scheduler
   → Create Basic Task** → Trigger: Daily at 05:00 → Action: **Start a
   program** → Program: `python`, Arguments: `"C:\full\path\to\upload_daily.py"`.

6. Automate the cleanup: double-click `create_delete_task.bat` on the HO
   server. It registers a second job, `SalemMallBIDeleteExport`, that runs
   `delete_daily_export.py` daily at **18:00** — well after the 05:00 upload,
   so the file is already safely in Railway before it's removed. This keeps
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
- **This holds one snapshot** (today's file), not day-by-day history. MTD/YTD
  and custom-date-variance reports work by re-querying that one table with
  different date ranges — no separate history store needed for those. If you
  later want "compare to a date range that's no longer in today's export"
  (e.g. true historical retention beyond what your source system keeps),
  that needs the server to accumulate uploads over time rather than replace
  the table each day — a bigger step, worth doing as a follow-up if it comes
  up.
- **Security**: `/api/upload` is protected by the `API_KEY` header. The
  dashboard itself has no login — anyone with the URL can view it. If you
  need to restrict *viewing* too, that's a separate step (real auth) from
  what's built here.
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
