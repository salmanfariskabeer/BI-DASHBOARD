"""
upload_daily.py
----------------
Runs on the HO SERVER via Windows Task Scheduler (registered by
SETUP_HO_SERVER.bat). Finds the day's iTrade export and pushes it to the
Railway dashboard backend, which ingests it into DuckDB.

iTrade writes a new cumulative (year-to-date) file every day, e.g.:
    C:\\iTrade\\SALESALLBRANCHES\\Sales_All_Branches_20260925.csv

HOW THE SCHEDULE WORKS
  The task fires at 05:00 and then again every hour until 23:00. This script
  is safe to run any number of times:
    - today's file already uploaded      -> logs one line, exits, does nothing
    - today's file not there yet         -> exits, next hourly run tries again
    - file still being written by iTrade -> waits for it to finish first
    - network / Railway hiccup           -> retries 3x in-process, and the
                                            next hourly run tries again
  So one missed/failed attempt no longer means a missed day.

What's been uploaded is recorded in upload_state.json next to this script.
delete_daily_export.py reads that file so it only ever deletes an export
that has definitely reached the server.

Every run is appended to upload_log.txt next to this script -- a scheduled
run shows nothing on screen, so that log is where to look.

MANUAL USE
    py upload_daily.py            normal run (same as the scheduler)
    py upload_daily.py --force    re-upload the newest file even if already done

This script never modifies the export file -- it only reads it.
"""

import sys
import os
import glob
import gzip
import json
import time
import shutil
import tempfile
import traceback
from datetime import datetime

# ============ CONFIG ============
FOLDER = r"C:\iTrade\SALESALLBRANCHES"
FILENAME_PATTERN = "Sales_All_Branches_{date}.csv"   # {date} = YYYYMMDD

# SERVER_URL / API_KEY live in upload_config.py (same folder, never committed).
try:
    from upload_config import SERVER_URL, API_KEY
except ImportError:
    SERVER_URL = None
    API_KEY = None
# =================================

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(SCRIPT_DIR, "upload_log.txt")
STATE_PATH = os.path.join(SCRIPT_DIR, "upload_state.json")
LOCK_PATH = os.path.join(SCRIPT_DIR, "upload.lock")

UPLOAD_TIMEOUT_SECONDS = 1800        # 1GB+ over the office link can take minutes
MAX_ATTEMPTS = 3
RETRY_DELAY_SECONDS = [30, 120]      # before attempt 2, before attempt 3
STABLE_CHECK_SECONDS = 60            # file size must not change for this long
STABLE_MAX_WAIT_SECONDS = 45 * 60    # give up waiting (next hourly run retries)
LOCK_STALE_SECONDS = 3 * 60 * 60     # a lock older than this is from a dead run
LOG_MAX_BYTES = 2 * 1024 * 1024


def log(msg):
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    try:
        print(line)
    except Exception:
        pass  # no console under Task Scheduler is fine
    try:
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > LOG_MAX_BYTES:
            os.replace(LOG_PATH, LOG_PATH + ".old")
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass  # logging must never be the reason the upload fails


def load_state():
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state):
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_PATH)


def file_signature(path):
    st = os.stat(path)
    return {"name": os.path.basename(path), "size": st.st_size, "mtime": int(st.st_mtime)}


def extract_date(path):
    """YYYYMMDD from the filename, or None if it isn't a dated daily export."""
    prefix, suffix = FILENAME_PATTERN.split("{date}")
    name = os.path.basename(path)
    if not (name.startswith(prefix) and name.endswith(suffix)):
        return None
    try:
        return datetime.strptime(name[len(prefix): len(name) - len(suffix)], "%Y%m%d")
    except ValueError:
        return None


def newest_export():
    """Today's file if present, otherwise the newest validly-dated one."""
    today_path = os.path.join(FOLDER, FILENAME_PATTERN.format(date=datetime.now().strftime("%Y%m%d")))
    if os.path.isfile(today_path):
        return today_path
    candidates = [(p, extract_date(p)) for p in glob.glob(os.path.join(FOLDER, FILENAME_PATTERN.format(date="*")))]
    candidates = [(p, d) for p, d in candidates if d is not None]
    if not candidates:
        return None
    return max(candidates, key=lambda pd: pd[1])[0]


def wait_until_stable(path):
    """Returns True once the file has stopped growing (iTrade finished writing
    it), False if it's still changing after STABLE_MAX_WAIT_SECONDS."""
    deadline = time.time() + STABLE_MAX_WAIT_SECONDS
    last = file_signature(path)
    announced = False
    while True:
        time.sleep(STABLE_CHECK_SECONDS)
        if not os.path.isfile(path):
            return False
        cur = file_signature(path)
        if cur == last and time.time() - cur["mtime"] >= STABLE_CHECK_SECONDS:
            return True
        if not announced:
            log("  File is still being written by iTrade -- waiting for it to finish...")
            announced = True
        if time.time() > deadline:
            return False
        last = cur


def acquire_lock():
    """Stops a manual run and a scheduled run from uploading at the same time."""
    try:
        if os.path.exists(LOCK_PATH) and time.time() - os.path.getmtime(LOCK_PATH) > LOCK_STALE_SECONDS:
            os.remove(LOCK_PATH)
        fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return True
    except FileExistsError:
        return False


def release_lock():
    try:
        os.remove(LOCK_PATH)
    except OSError:
        pass


def upload(file_path, requests, MultipartEncoder):
    """Compresses + uploads. Returns the server's JSON on success, else None."""
    endpoint = SERVER_URL.rstrip("/") + "/api/upload"
    size_mb = os.path.getsize(file_path) / (1024 * 1024)

    # CSV gzips ~15x and the server's DuckDB reader decompresses it directly.
    gz_path = os.path.join(tempfile.gettempdir(), os.path.basename(file_path) + ".gz")
    log("Compressing...")
    with open(file_path, "rb") as src, gzip.open(gz_path, "wb", compresslevel=6) as dst:
        shutil.copyfileobj(src, dst, length=16 * 1024 * 1024)
    log(f"  {size_mb:.1f} MB -> {os.path.getsize(gz_path) / (1024 * 1024):.1f} MB gzipped")

    try:
        for attempt in range(1, MAX_ATTEMPTS + 1):
            if attempt > 1:
                delay = RETRY_DELAY_SECONDS[attempt - 2]
                log(f"Retrying in {delay}s (attempt {attempt}/{MAX_ATTEMPTS})...")
                time.sleep(delay)
            log(f"Uploading to {endpoint} ...")
            try:
                with open(gz_path, "rb") as f:
                    # Streams from disk instead of loading the whole body into RAM.
                    encoder = MultipartEncoder(fields={"file": (os.path.basename(gz_path), f, "application/gzip")})
                    headers = {"X-API-Key": API_KEY, "Content-Type": encoder.content_type}
                    resp = requests.post(endpoint, data=encoder, headers=headers, timeout=UPLOAD_TIMEOUT_SECONDS)
            except requests.exceptions.RequestException as e:
                log(f"WARNING: could not reach server: {e}")
                continue
            if resp.status_code == 200:
                return resp.json()
            log(f"WARNING: server responded {resp.status_code}: {resp.text[:500]}")
            if 400 <= resp.status_code < 500:
                return None  # bad key / bad file -- retrying won't help
        return None
    finally:
        try:
            os.unlink(gz_path)
        except OSError:
            pass


def main():
    force = "--force" in sys.argv

    if not SERVER_URL or not API_KEY:
        log("ERROR: SERVER_URL/API_KEY not configured -- create upload_config.py next to this script.")
        return 1
    try:
        import requests
        from requests_toolbelt import MultipartEncoder
    except ImportError:
        log(f"ERROR: missing packages. Run:  \"{sys.executable}\" -m pip install requests requests-toolbelt")
        return 1
    if not os.path.isdir(FOLDER):
        log(f"ERROR: folder not found: {FOLDER}")
        return 1

    file_path = newest_export()
    if not file_path:
        log(f"No export matching {FILENAME_PATTERN} in {FOLDER} yet -- will try again next run.")
        return 0

    state = load_state()
    sig = file_signature(file_path)
    if not force and state.get("last_uploaded") == sig:
        # Already done today; stay quiet so the log isn't flooded by hourly runs.
        return 0

    today_name = FILENAME_PATTERN.format(date=datetime.now().strftime("%Y%m%d"))
    log(f"--- upload starting: {sig['name']} ---")
    if sig["name"] != today_name:
        log(f"  Note: today's file ({today_name}) isn't there yet -- uploading the newest one available.")

    if not wait_until_stable(file_path):
        log("  File still changing (or vanished) -- skipping; next hourly run will retry.")
        return 1
    sig = file_signature(file_path)  # final size after writing finished

    result = upload(file_path, requests, MultipartEncoder)
    if result is None:
        log("ERROR: upload failed -- the next hourly run will try again automatically.")
        return 1

    rows = result.get("rows")
    rows_txt = f"{rows:,}" if isinstance(rows, int) else "?"
    log(f"Upload succeeded: {rows_txt} rows ingested in {result.get('ingestMs', 0) / 1000:.1f}s (server-side)")
    if result.get("skipped"):
        log(f"  Note: {result['skipped']:,} row(s) skipped -- no readable date in 'trandate'.")

    state["last_uploaded"] = sig
    state["last_uploaded_at"] = datetime.now().isoformat(timespec="seconds")
    state["last_rows"] = rows
    save_state(state)
    return 0


if __name__ == "__main__":
    if not acquire_lock():
        log("Another upload is already running -- exiting.")
        sys.exit(0)
    try:
        code = main()
    except Exception:
        log("FATAL: unhandled exception:\n" + traceback.format_exc())
        code = 1
    finally:
        release_lock()
    sys.exit(code)
