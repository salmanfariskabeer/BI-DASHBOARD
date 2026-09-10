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
file in the folder and logs a warning so that's visible — it never uploads
silently-wrong data without saying so.

Every run (success, warning, or failure — including a crash) is appended to
upload_log.txt next to this script, in addition to printing to the console.
This matters specifically because Task Scheduler runs show nothing on screen
at all — the log file is the only way to see what happened on a scheduled run.

CSV is what makes 1M+ row / ~1GB uploads ingest in seconds server-side (via
DuckDB's native CSV reader). Keep pointing this at the .csv export, not an
.xlsx, for the daily job.

SETUP (one-time, on the HO server):
  1. Install Python 3 if it isn't already there: https://www.python.org/downloads/
     (tick "Add Python to PATH" during install)
  2. Open Command Prompt and run:
         pip install requests requests-toolbelt
  3. Copy upload_config.example.py to upload_config.py (same folder) and edit
     the values inside it — SERVER_URL and API_KEY. upload_config.py is
     gitignored on purpose: it holds a real secret and must never end up
     committed to the repo. FOLDER/FILENAME_PATTERN live below and normally
     don't need changing.
  4. Test it manually once:
         python upload_daily.py
     You should see "Upload succeeded" printed, with the row count and how
     long the server took to ingest it.
  5. Schedule it (see create_scheduled_task.bat / README.md) to run a few
     minutes AFTER the iTrade export job finishes for the day. IMPORTANT:
     the scheduled task must launch this via the "py" launcher, not bare
     "python" — see the comment in create_scheduled_task.bat for why a
     scheduled run can silently fail even when running it yourself works.

This script does NOT touch or modify the export file — it only reads and
uploads a copy of it.
"""

import sys
import os
import glob
import gzip
import shutil
import tempfile
import traceback
import time
from datetime import datetime

# ============ CONFIG ============
# FOLDER / FILENAME_PATTERN describe where iTrade writes its daily export —
# these normally don't need to change.
FOLDER = r"C:\iTrade\SALESALLBRANCHES"
FILENAME_PATTERN = "Sales_All_Branches_{date}.csv"   # {date} is replaced with today's date as YYYYMMDD

# SERVER_URL / API_KEY are secrets and live in upload_config.py (gitignored,
# NOT committed) instead of here — copy upload_config.example.py to
# upload_config.py and fill in the real values there.
try:
    from upload_config import SERVER_URL, API_KEY
except ImportError:
    SERVER_URL = None
    API_KEY = None
# =================================

LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "upload_log.txt")
# A 1GB+ file over the office link can genuinely take minutes.
UPLOAD_TIMEOUT_SECONDS = 1800

CONTENT_TYPES = {
    ".csv": "text/csv",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
}


def log(msg):
    """Prints AND appends to upload_log.txt — Task Scheduler shows nothing on
    screen for a scheduled run, so the file is the only way to see what
    happened without this."""
    line = f"[{datetime.now()}] {msg}"
    print(line)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass  # logging must never be the reason the upload itself fails


def _extract_date(path):
    """Parses the {date} portion of a filename as YYYYMMDD. Returns a datetime,
    or None if it doesn't match that exact 8-digit shape — this keeps
    non-daily files (e.g. a historical dump like Sales_All_Branches_2025.csv)
    from ever being mistaken for a dated daily export."""
    prefix, suffix = FILENAME_PATTERN.split("{date}")
    name = os.path.basename(path)
    if not (name.startswith(prefix) and name.endswith(suffix)):
        return None
    date_str = name[len(prefix): len(name) - len(suffix)]
    try:
        return datetime.strptime(date_str, "%Y%m%d")
    except ValueError:
        return None


def find_todays_file():
    """Returns (path, is_fallback). Prefers today's exact filename; if that's
    not there yet, falls back to the most recent validly-dated file matching
    the pattern, so a late/early scheduler run still finds something."""
    today_name = FILENAME_PATTERN.format(date=datetime.now().strftime("%Y%m%d"))
    today_path = os.path.join(FOLDER, today_name)
    if os.path.isfile(today_path):
        return today_path, False

    glob_pattern = os.path.join(FOLDER, FILENAME_PATTERN.format(date="*"))
    candidates = [(p, _extract_date(p)) for p in glob.glob(glob_pattern)]
    candidates = [(p, d) for p, d in candidates if d is not None]
    if not candidates:
        return None, False
    newest = max(candidates, key=lambda pd: pd[1])[0]
    return newest, True


def main():
    log("--- upload_daily.py starting ---")

    if not SERVER_URL or not API_KEY:
        log("ERROR: SERVER_URL/API_KEY not configured. Copy upload_config.example.py "
            "to upload_config.py and fill in the real values.")
        sys.exit(1)
    upload_endpoint = SERVER_URL.rstrip("/") + "/api/upload"

    try:
        import requests
        from requests_toolbelt import MultipartEncoder
    except ImportError:
        log("ERROR: the 'requests' and/or 'requests-toolbelt' package isn't installed.")
        log("Run:  pip install requests requests-toolbelt")
        sys.exit(1)

    if not os.path.isdir(FOLDER):
        log(f"ERROR: folder not found: {FOLDER}")
        log("Check FOLDER at the top of this script.")
        sys.exit(1)

    file_path, is_fallback = find_todays_file()
    if not file_path:
        log(f"ERROR: no file matching '{FILENAME_PATTERN}' found in {FOLDER}")
        sys.exit(1)
    if is_fallback:
        log(f"WARNING: today's expected file wasn't found — falling back to "
            f"the newest matching file instead: {os.path.basename(file_path)}")
        log("  (Check that the iTrade export actually ran today.)")

    ext = os.path.splitext(file_path)[1].lower()
    if ext not in CONTENT_TYPES:
        log(f"ERROR: unsupported file type '{ext}' — use .csv, .xlsx or .xls")
        sys.exit(1)

    size_mb = os.path.getsize(file_path) / (1024 * 1024)

    # CSV compresses very well (typically 5-10x) and the server's DuckDB
    # reader decompresses gzip directly — sending .csv.gz instead of raw CSV
    # cuts transfer time by the same factor, which matters on slower office
    # links where an uncompressed 1-2GB file can take long enough to hit an
    # upstream request timeout before it fully arrives.
    gz_path = None
    if ext == ".csv":
        gz_path = os.path.join(tempfile.gettempdir(), os.path.basename(file_path) + ".gz")
        log("Compressing before upload...")
        with open(file_path, "rb") as src, gzip.open(gz_path, "wb") as dst:
            shutil.copyfileobj(src, dst, length=16 * 1024 * 1024)
        upload_path = gz_path
        upload_name = os.path.basename(file_path) + ".gz"
        content_type = "application/gzip"
        gz_size_mb = os.path.getsize(gz_path) / (1024 * 1024)
        log(f"  {size_mb:.1f} MB -> {gz_size_mb:.1f} MB gzipped")
    else:
        upload_path = file_path
        upload_name = os.path.basename(file_path)
        content_type = CONTENT_TYPES[ext]

    log(f"Uploading {upload_path} -> {upload_endpoint}")

    # A 5am run can hit a genuinely transient problem -- the office link
    # blipping, Railway mid-redeploy, a momentary DNS hiccup -- that has
    # nothing to do with the file or the script and would succeed a minute
    # later. Retrying here (fast, in-process) catches that without relying
    # on Task Scheduler's own restart-on-failure (which also exists, see
    # create_scheduled_task.ps1, as a second, slower layer of the same idea).
    MAX_ATTEMPTS = 3
    RETRY_DELAY_SECONDS = [20, 60]  # wait before attempt 2, then before attempt 3

    try:
        resp = None
        last_error = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            if attempt > 1:
                delay = RETRY_DELAY_SECONDS[attempt - 2]
                log(f"Retrying in {delay}s (attempt {attempt}/{MAX_ATTEMPTS})...")
                time.sleep(delay)
            try:
                with open(upload_path, "rb") as f:
                    # Streams the file straight from disk instead of
                    # buffering the whole multipart body in memory --
                    # requests' default files= encoding loads the entire
                    # file into RAM first, which can exhaust memory well
                    # before the 2GB server-side cap. Re-opened fresh each
                    # attempt since a failed send leaves the handle at EOF.
                    encoder = MultipartEncoder(fields={"file": (upload_name, f, content_type)})
                    headers = {"X-API-Key": API_KEY, "Content-Type": encoder.content_type}
                    resp = requests.post(upload_endpoint, data=encoder, headers=headers, timeout=UPLOAD_TIMEOUT_SECONDS)
                if resp.status_code == 200 or (400 <= resp.status_code < 500):
                    # Success, or an error retrying won't fix (bad file,
                    # wrong API key, etc.) -- stop here either way.
                    break
                last_error = f"server responded {resp.status_code}: {resp.text}"
                log(f"WARNING: {last_error}")
            except requests.exceptions.RequestException as e:
                last_error = str(e)
                log(f"WARNING: could not reach server: {e}")
                resp = None
        if resp is None:
            log(f"ERROR: could not reach server after {MAX_ATTEMPTS} attempts: {last_error}")
            sys.exit(1)
    finally:
        if gz_path:
            os.unlink(gz_path)

    if resp.status_code == 200:
        result = resp.json()
        log(f"Upload succeeded: {result.get('rows', '?'):,} rows ingested in "
            f"{result.get('ingestMs', 0) / 1000:.1f}s (server-side)")
        if result.get("skipped"):
            log(f"  Note: {result['skipped']:,} row(s) skipped — no readable date in 'trandate'.")
    else:
        log(f"ERROR: server responded {resp.status_code}: {resp.text}")
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        # Catches anything not already handled above (e.g. a permissions
        # error, disk full while compressing) so a scheduled run that crashes
        # still leaves a trace instead of vanishing without a sign of why.
        log("FATAL: unhandled exception:\n" + traceback.format_exc())
        sys.exit(1)
