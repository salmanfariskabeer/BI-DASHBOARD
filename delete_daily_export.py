"""
delete_daily_export.py
-----------------------
Runs on the HO SERVER at 23:30 (registered by SETUP_HO_SERVER.bat) so that
C:\\iTrade\\SALESALLBRANCHES doesn't fill up with a new ~1.8GB file every day.

SAFETY: it only deletes exports that are definitely no longer needed:
  - the exact file upload_daily.py recorded as successfully uploaded
    (same name, size and timestamp, from upload_state.json), and
  - any dated export OLDER than that one (each export is cumulative
    year-to-date, so an older file is fully covered by the newer upload).
If today's upload failed, today's file is KEPT, so tomorrow's run (or a
manual `py upload_daily.py`) still has it.

FOLDER / FILENAME_PATTERN must match upload_daily.py.
Every run is appended to delete_log.txt next to this script.
"""

import os
import sys
import glob
import json
import traceback
from datetime import datetime

# ============ CONFIG -- keep in sync with upload_daily.py ============
FOLDER = r"C:\iTrade\SALESALLBRANCHES"
FILENAME_PATTERN = "Sales_All_Branches_{date}.csv"   # {date} is YYYYMMDD
# =======================================================================

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(SCRIPT_DIR, "delete_log.txt")
STATE_PATH = os.path.join(SCRIPT_DIR, "upload_state.json")


def log(msg):
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    try:
        print(line)
    except Exception:
        pass
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def extract_date(path):
    prefix, suffix = FILENAME_PATTERN.split("{date}")
    name = os.path.basename(path)
    if not (name.startswith(prefix) and name.endswith(suffix)):
        return None
    try:
        return datetime.strptime(name[len(prefix): len(name) - len(suffix)], "%Y%m%d")
    except ValueError:
        return None


def main():
    log("--- delete_daily_export.py starting ---")
    if not os.path.isdir(FOLDER):
        log(f"ERROR: folder not found: {FOLDER}")
        return 1

    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            uploaded = json.load(f).get("last_uploaded")
    except (OSError, ValueError):
        uploaded = None
    if not uploaded:
        log("Nothing has been recorded as uploaded yet -- deleting nothing.")
        return 0

    uploaded_date = extract_date(uploaded["name"])
    deleted = kept = 0
    for path in glob.glob(os.path.join(FOLDER, FILENAME_PATTERN.format(date="*"))):
        name = os.path.basename(path)
        d = extract_date(path)
        if d is None or uploaded_date is None:
            continue
        st = os.stat(path)
        is_uploaded_file = (name == uploaded["name"] and st.st_size == uploaded["size"]
                            and int(st.st_mtime) == uploaded["mtime"])
        if d < uploaded_date or is_uploaded_file:
            try:
                os.remove(path)
                log(f"Deleted {name}")
                deleted += 1
            except OSError as e:
                log(f"ERROR deleting {name}: {e}")
        else:
            log(f"KEPT {name} (not uploaded yet)")
            kept += 1

    log(f"Done: {deleted} deleted, {kept} kept.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        log("FATAL: unhandled exception:\n" + traceback.format_exc())
        sys.exit(1)
