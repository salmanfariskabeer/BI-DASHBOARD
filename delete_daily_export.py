"""
delete_daily_export.py
-----------------------
Runs on the HO SERVER at 18:00 (via create_delete_task.bat), well after
upload_daily.py has already pushed the day's file to Railway at 05:00.
By the time this runs, the CSV has done its job and is safe to remove — this
keeps C:\\iTrade\\SALESALLBRANCHES from filling up with a new ~1GB dated file
every day forever.

It deletes every file matching FILENAME_PATTERN whose date is today or
earlier (never a future date, which shouldn't exist anyway) — not just
today's file — so if a previous day's cleanup ever failed to run, this
self-heals instead of leaving old exports piling up.

Every run is appended to delete_log.txt next to this script, in addition to
printing to the console — Task Scheduler shows nothing on screen for a
scheduled run, so the log file is the only way to see what happened.

FOLDER / FILENAME_PATTERN here must match the same values in
upload_daily.py — if you change the export's location or naming, update
both scripts.
"""

import os
import sys
import glob
import traceback
from datetime import datetime

# ============ CONFIG — keep in sync with upload_daily.py ============
FOLDER = r"C:\iTrade\SALESALLBRANCHES"
FILENAME_PATTERN = "Sales_All_Branches_{date}.csv"   # {date} is YYYYMMDD
# =======================================================================

DATE_FORMAT = "%Y%m%d"
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "delete_log.txt")


def log(msg):
    line = f"[{datetime.now()}] {msg}"
    print(line)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def extract_date(path, pattern):
    """Pulls the {date} portion out of a filename matched against pattern.
    Returns a datetime, or None if it doesn't parse (left alone, just in case
    it's not actually one of ours)."""
    prefix, suffix = pattern.split("{date}")
    name = os.path.basename(path)
    if not (name.startswith(prefix) and name.endswith(suffix)):
        return None
    date_str = name[len(prefix): len(name) - len(suffix)]
    try:
        return datetime.strptime(date_str, DATE_FORMAT)
    except ValueError:
        return None


def main():
    log("--- delete_daily_export.py starting ---")

    if not os.path.isdir(FOLDER):
        log(f"ERROR: folder not found: {FOLDER}")
        sys.exit(1)

    glob_pattern = os.path.join(FOLDER, FILENAME_PATTERN.format(date="*"))
    candidates = glob.glob(glob_pattern)
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)

    deleted, skipped = 0, 0
    for path in candidates:
        file_date = extract_date(path, FILENAME_PATTERN)
        if file_date is None:
            log(f"SKIP (couldn't parse date): {os.path.basename(path)}")
            skipped += 1
            continue
        if file_date > today:
            log(f"SKIP (future-dated, unexpected): {os.path.basename(path)}")
            skipped += 1
            continue
        try:
            os.remove(path)
            log(f"Deleted {os.path.basename(path)}")
            deleted += 1
        except OSError as e:
            log(f"ERROR deleting {os.path.basename(path)}: {e}")

    log(f"Done: {deleted} deleted, {skipped} skipped, {len(candidates)} total matched.")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        log("FATAL: unhandled exception:\n" + traceback.format_exc())
        sys.exit(1)
