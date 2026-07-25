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

FOLDER / FILENAME_PATTERN here must match the same values in
upload_daily.py — if you change the export's location or naming, update
both scripts.
"""

import os
import sys
import glob
from datetime import datetime

# ============ CONFIG — keep in sync with upload_daily.py ============
FOLDER = r"C:\iTrade\SALESALLBRANCHES"
FILENAME_PATTERN = "Sales_All_Branches_{date}.csv"   # {date} is YYYYMMDD
# =======================================================================

DATE_FORMAT = "%Y%m%d"


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
    if not os.path.isdir(FOLDER):
        print(f"ERROR: folder not found: {FOLDER}")
        sys.exit(1)

    glob_pattern = os.path.join(FOLDER, FILENAME_PATTERN.format(date="*"))
    candidates = glob.glob(glob_pattern)
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)

    deleted, skipped = 0, 0
    for path in candidates:
        file_date = extract_date(path, FILENAME_PATTERN)
        if file_date is None:
            print(f"SKIP (couldn't parse date): {os.path.basename(path)}")
            skipped += 1
            continue
        if file_date > today:
            print(f"SKIP (future-dated, unexpected): {os.path.basename(path)}")
            skipped += 1
            continue
        try:
            os.remove(path)
            print(f"[{datetime.now()}] Deleted {os.path.basename(path)}")
            deleted += 1
        except OSError as e:
            print(f"ERROR deleting {os.path.basename(path)}: {e}")

    print(f"Done: {deleted} deleted, {skipped} skipped, {len(candidates)} total matched.")


if __name__ == "__main__":
    main()
