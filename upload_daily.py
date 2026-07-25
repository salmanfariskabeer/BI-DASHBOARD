"""
upload_daily.py
----------------
Runs on the HO SERVER (via Windows Task Scheduler) — the same machine the
iTrade export already writes its daily CSV to. Every time it runs, it finds
today's export file and pushes it to your Railway-hosted dashboard backend,
which ingests it into DuckDB.

Your export writes a NEW file each day with the date in the name, e.g.:
    C:\\iTrade\\SALESALLBRANCHES\\Sales_All_Branches_20260725.csv
so this script builds today's expected filename from FOLDER + FILENAME_PATTERN
rather than pointing at one fixed path. If today's file isn't there yet (the
export hasn't run, or is still writing), it falls back to the newest matching
file in the folder and prints a warning so that's visible in the log — it
never uploads silently-wrong data without saying so.

CSV is what makes 1M+ row / ~1GB uploads ingest in seconds server-side (via
DuckDB's native CSV reader). Keep pointing this at the .csv export, not an
.xlsx, for the daily job.

SETUP (one-time, on the HO server):
  1. Install Python 3 if it isn't already there: https://www.python.org/downloads/
     (tick "Add Python to PATH" during install)
  2. Open Command Prompt and run:
         pip install requests
  3. Edit the values in CONFIG below:
       - FOLDER            : the folder iTrade exports into
       - FILENAME_PATTERN  : the export's filename, with {date} where the
                              date goes (see the example already filled in)
       - SERVER_URL        : your Railway app's URL
       - API_KEY           : must match the API_KEY variable you set in Railway
  4. Test it manually once:
         python upload_daily.py
     You should see "Upload succeeded" printed, with the row count and how
     long the server took to ingest it.
  5. Schedule it (see create_scheduled_task.bat / README.md) to run a few
     minutes AFTER the iTrade export job finishes for the day.

This script does NOT touch or modify the export file — it only reads and
uploads a copy of it.
"""

import sys
import os
import glob
import mimetypes
from datetime import datetime

# ============ CONFIG — edit these values ============
FOLDER = r"C:\iTrade\SALESALLBRANCHES"
FILENAME_PATTERN = "Sales_All_Branches_{date}.csv"   # {date} is replaced with today's date as YYYYMMDD
SERVER_URL = "https://your-app-name.up.railway.app"
API_KEY = "paste-the-same-long-random-string-you-set-in-railway"
# ======================================================

UPLOAD_ENDPOINT = SERVER_URL.rstrip("/") + "/api/upload"
# A 1GB+ file over the office link can genuinely take minutes.
UPLOAD_TIMEOUT_SECONDS = 1800

CONTENT_TYPES = {
    ".csv": "text/csv",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
}


def find_todays_file():
    """Returns (path, is_fallback). Prefers today's exact filename; if that's
    not there yet, falls back to the most recently modified file matching the
    pattern's shape, so a late/early scheduler run still finds something."""
    today_name = FILENAME_PATTERN.format(date=datetime.now().strftime("%Y%m%d"))
    today_path = os.path.join(FOLDER, today_name)
    if os.path.isfile(today_path):
        return today_path, False

    glob_pattern = os.path.join(FOLDER, FILENAME_PATTERN.format(date="*"))
    candidates = glob.glob(glob_pattern)
    if not candidates:
        return None, False
    newest = max(candidates, key=os.path.getmtime)
    return newest, True


def main():
    try:
        import requests
    except ImportError:
        print("ERROR: the 'requests' package isn't installed.")
        print("Run:  pip install requests")
        sys.exit(1)

    if not os.path.isdir(FOLDER):
        print(f"ERROR: folder not found: {FOLDER}")
        print("Check FOLDER at the top of this script.")
        sys.exit(1)

    file_path, is_fallback = find_todays_file()
    if not file_path:
        print(f"ERROR: no file matching '{FILENAME_PATTERN}' found in {FOLDER}")
        sys.exit(1)
    if is_fallback:
        print(f"WARNING: today's expected file wasn't found — falling back to "
              f"the newest matching file instead: {os.path.basename(file_path)}")
        print("  (Check that the iTrade export actually ran today.)")

    ext = os.path.splitext(file_path)[1].lower()
    if ext not in CONTENT_TYPES:
        print(f"ERROR: unsupported file type '{ext}' — use .csv, .xlsx or .xls")
        sys.exit(1)
    content_type = CONTENT_TYPES.get(ext, mimetypes.guess_type(file_path)[0] or "application/octet-stream")

    size_mb = os.path.getsize(file_path) / (1024 * 1024)
    print(f"[{datetime.now()}] Uploading {file_path} ({size_mb:.1f} MB) -> {UPLOAD_ENDPOINT}")

    with open(file_path, "rb") as f:
        files = {"file": (os.path.basename(file_path), f, content_type)}
        headers = {"X-API-Key": API_KEY}
        try:
            resp = requests.post(UPLOAD_ENDPOINT, files=files, headers=headers, timeout=UPLOAD_TIMEOUT_SECONDS)
        except requests.exceptions.RequestException as e:
            print(f"ERROR: could not reach server: {e}")
            sys.exit(1)

    if resp.status_code == 200:
        result = resp.json()
        print(f"Upload succeeded: {result.get('rows', '?'):,} rows ingested in "
              f"{result.get('ingestMs', 0) / 1000:.1f}s (server-side)")
        if result.get("skipped"):
            print(f"  Note: {result['skipped']:,} row(s) skipped — no readable date in 'trandate'.")
    else:
        print(f"ERROR: server responded {resp.status_code}: {resp.text}")
        sys.exit(1)


if __name__ == "__main__":
    main()
