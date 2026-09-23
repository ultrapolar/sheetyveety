r"""
Batch PDF printer with watermarking, driven by a Google Sheet.

Sheet has two columns: a student NAME ("First Last") and a comma-separated LIST
of items. Only the FIRST item is printed. The first item decides everything:

  * SD<number>  (SD3, SD12, ...) -> slide deck.
        folder    : \\newcloud\Public\NEW Current Students\+First Last\Upcoming Decks
        watermark : the SD# itself
        match     : exactly one dated file, else set aside for a human
  * TEMP                          -> temporary deck (special case).
        folder    : ...\+First Last\Upcoming Decks
        watermark : none by default (see TEMP_WATERMARK)
        match     : the MOST RECENT dated file wins (never ambiguous)
        pages     : only the first TEMP_PAGES pages are printed
  * anything else                 -> assessment.
        folder    : ...\+First Last\Assessments
        watermark : none
        match     : exactly one dated file, else set aside for a human

Filenames are "First Last <item> YYYYMMDD.pdf". The date is always present but
unknown to us, so we glob "First Last <item> *.pdf" and let it float.

  Dependencies:  pip install pypdf reportlab
  Printing:      SumatraPDF (free, portable .exe) -- sumatrapdfreader.org

Settings (the sheet URL, column names, printers, watermarks, pacing, ...) live
in config.json next to this file, not in this file. Run this script with
--settings (or use the "Batch Print Settings" shortcut) to edit them without
touching code -- see settings_gui.py / config_store.py.
"""

import csv
import glob
import io
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime

from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.lib.colors import Color

from config_store import load_config, flatten

# ============================== CONFIG =======================================
# All of the below comes from config.json (see config_store.py for the schema
# and defaults, and settings_gui.py for the editor). Re-run with --settings to
# change any of it -- these names are just how the rest of this file refers to
# it, so they're the same regardless of where the value came from.
_CFG = flatten(load_config())

SHEET_CSV_URL = _CFG["SHEET_CSV_URL"]
COL_NAME      = _CFG["COL_NAME"]
COL_ITEMS     = _CFG["COL_ITEMS"]

# Path layout. Note the literal "+" on the student folder.
BASE          = _CFG["BASE"]
DECK_SUBDIR   = _CFG["DECK_SUBDIR"]
ASSESS_SUBDIR = _CFG["ASSESS_SUBDIR"]

# Item-name conventions are fixed domain rules, not per-site settings.
SD_RE   = re.compile(r"^SD\d+$", re.IGNORECASE)  # slide-deck item (a "deck")
TEMP_RE = re.compile(r"^TEMP$",  re.IGNORECASE)  # temporary-deck item
# LP items ("LP 1 of 3") sit in the same folder as SD but use a DIFFERENT filename
# convention: "First Last_LP 1 of 3_YYYY-MM-DD.pdf" (underscores, hyphenated date).
LP_RE   = re.compile(r"^LP\s*\d+\s*of\s*\d+$", re.IGNORECASE)

# TEMP specifics
TEMP_WATERMARK = _CFG["TEMP_WATERMARK"]  # "" = no watermark on TEMP
TEMP_PAGES     = _CFG["TEMP_PAGES"]      # print only this many leading pages

# SUPP companion: printed automatically alongside an "LP 1 of #" (the FIRST lesson
# plan only). Paired by DATE -- the SUPP must carry the same date as that LP.
SUPP_WATERMARK = _CFG["SUPP_WATERMARK"]
SUPP_PAGES     = _CFG["SUPP_PAGES"]
SUPP_LABEL     = _CFG["SUPP_LABEL"]   # the token as it appears in the filename

# --- Printing ---  (which physical printer handles each kind, and its protocol)
PRINTERS        = _CFG["PRINTERS"]           # kind -> printer name
DUPLEX_PRINTERS = _CFG["DUPLEX_PRINTERS"]    # printer names that always duplex (long edge)

# Per-printer spacing to manage heat. A printer NOT listed here runs at full speed.
SPACING = _CFG["SPACING"]
# SumatraPDF is expected to sit next to this script (or next to the .exe if frozen),
# so the whole tool is one self-contained, portable folder.
SUMATRA = os.path.join(
    os.path.dirname(sys.executable) if getattr(sys, "frozen", False)
    else os.path.dirname(os.path.abspath(__file__)),
    "SumatraPDF.exe",
)
PRINT_SETTINGS = _CFG["PRINT_SETTINGS"]  # "noscale" keeps true scale; "fit"/"shrink" RESCALE
COPIES         = _CFG["COPIES"]
PRINT_TIMEOUT  = _CFG["PRINT_TIMEOUT"]   # max seconds to wait for ONE print. SumatraPDF can print
                                          # a page then hang on exit during back-to-back jobs; this
                                          # keeps one stuck job from freezing the whole batch.

# --- Behaviour ---
RETAIN_WATERMARKED  = _CFG["RETAIN_WATERMARKED"]   # True = keep temp PDFs for inspection
LOG_PATH            = _CFG["LOG_PATH"]

# --- Watermark style ---
WM_FONT     = _CFG["WM_FONT"]        # a reportlab built-in (others: Helvetica-Bold, Times-Roman, Courier)
WM_SIZE     = _CFG["WM_SIZE"]        # font size in points
WM_DARKNESS = _CFG["WM_DARKNESS"]    # e.g. 0.15 -> black at 15% opacity
# =============================================================================


def load_jobs():
    """Pull rows from the published-CSV sheet. Returns a list of dicts."""
    with urllib.request.urlopen(SHEET_CSV_URL) as resp:
        text = resp.read().decode("utf-8")
    return list(csv.DictReader(io.StringIO(text)))

# --- Private-sheet upgrade: replace load_jobs() with this (pip install gspread) ---
# import gspread
# def load_jobs():
#     gc = gspread.service_account(filename="service_account.json")
#     return gc.open("Your Sheet Name").sheet1.get_all_records()


def plan_row(name, items, ask):
    """Decide which items in a row's list to print (a "deck" = an SD## or LP # of # item):

        2+ decks            -> just the first deck (drop everything else)
        1 deck, alone       -> the deck
        1 deck + 1 other    -> both
        1 deck + N others   -> the deck, then ASK how many to print
        no deck, 1 item     -> that item
        no deck, N items    -> ASK how many to print

    The deck, when present, is assumed to be listed first.
    """
    deck_idx = [i for i, x in enumerate(items) if SD_RE.match(x) or LP_RE.match(x)]
    D, T = len(deck_idx), len(items)

    if D >= 2:
        return [items[deck_idx[0]]]          # only the first deck
    if D == 1:
        if T <= 2:
            return items                     # deck alone, or deck + 1 other
        return items[:ask(name, items, T)]   # deck + several -> let the user choose
    # D == 0
    if T == 1:
        return items                         # a single non-deck item
    return items[:ask(name, items, T)]       # several items, no deck -> let the user choose


def ask_count(name, items, default):
    """Ask how many of a row's items to print. Returns an int in 1..len(items)."""
    print(f"\n  {name} -- choose how many to print:")
    for i, x in enumerate(items, 1):
        print(f"     {i}. {x}")
    while True:
        resp = input(f"  How many (1-{len(items)}, Enter = all {default})? ").strip()
        if resp == "":
            return default
        if resp.isdigit() and 1 <= int(resp) <= len(items):
            return int(resp)
        print("  Please enter a number in that range.")


def _squash(s):
    """Lowercase with all whitespace removed -- so 'LP 1 of 3' == 'LP 1 of3'."""
    return re.sub(r"\s+", "", s).lower()


def classify(item):
    """(kind, subfolder, watermark, max_pages, match_policy) for one item."""
    if SD_RE.match(item):
        return ("deck",       DECK_SUBDIR,   item,           None,       "single")
    if LP_RE.match(item):
        return ("lp",         DECK_SUBDIR,   "",             None,       "newest")
    if TEMP_RE.match(item):
        return ("temp",       DECK_SUBDIR,   TEMP_WATERMARK, TEMP_PAGES, "newest")
    return     ("assessment", ASSESS_SUBDIR, "",             None,       "single")


def find_matches(folder, name, item):
    """Files for this student+item. LP uses 'First Last_LP 1 of 3_YYYY-MM-DD.pdf'."""
    if LP_RE.match(item):
        # Match LP tolerantly: spacing typos in the wild ("LP 1 of3") still count,
        # so a mistyped newest file can't be silently skipped in favour of an older one.
        want = _squash(f"{name}_{item}_")
        try:
            entries = os.listdir(folder)
        except OSError:
            return []
        return sorted(os.path.join(folder, e) for e in entries
                      if e.lower().endswith(".pdf") and _squash(e).startswith(want))
    pattern = os.path.join(glob.escape(folder), glob.escape(f"{name} {item} ") + "*.pdf")
    return sorted(glob.glob(pattern))


def _date_of(path):
    """Newest-first sort key. Handles both YYYYMMDD and YYYY-MM-DD filenames."""
    base = os.path.basename(path)
    hyph = re.findall(r"\d{4}-\d{2}-\d{2}", base)
    if hyph:
        return hyph[-1].replace("-", "")
    runs = re.findall(r"\d{8}", base)
    return runs[-1] if runs else ""        # YYYYMMDD sorts chronologically


def is_first_lp(item):
    """True for 'LP 1 of N' -- the lesson plan that carries a SUPP companion."""
    m = re.match(r"^LP\s*(\d+)\s*of\s*\d+$", item, re.IGNORECASE)
    return bool(m) and int(m.group(1)) == 1


def find_supp(folder, name, date):
    """The student's SUPP file carrying this exact date, or None.

    Matched tolerantly (case and whitespace ignored) so it survives the same kind
    of spacing typos seen in LP names. Both YYYY-MM-DD and YYYYMMDD dates count.
    """
    try:
        entries = os.listdir(folder)
    except OSError:
        return None
    who, tag = _squash(name), _squash(SUPP_LABEL)
    hits = []
    for e in entries:
        if not e.lower().endswith(".pdf"):
            continue
        sq = _squash(e)
        if sq.startswith(who) and tag in sq and _date_of(e) == date:
            hits.append(os.path.join(folder, e))
    return sorted(hits)[0] if hits else None


def resolve_one(name, item):
    """Resolve a single (name, item) into print jobs.

    Returns ('ready', [job, ...], [warning, ...]) or ('defer', reason, []).
    An 'LP 1 of N' also pulls in its date-matched SUPP companion; a missing SUPP
    warns but never blocks the lesson plan from printing.
    """
    kind, sub, wm, max_pages, policy = classify(item)
    folder  = os.path.join(BASE, f"+{name}", sub)
    matches = find_matches(folder, name, item)

    if not matches:
        return ("defer", f"no file found in {sub}", [])
    if len(matches) > 1 and policy == "single":
        names = ", ".join(os.path.basename(m) for m in matches)
        return ("defer", f"ambiguous, {len(matches)} match: {names}", [])

    path = max(matches, key=_date_of) if policy == "newest" else matches[0]
    jobs = [{
        "key": os.path.normcase(path), "name": name, "item": item, "path": path,
        "watermark": wm, "max_pages": max_pages, "kind": kind,
        "printer": PRINTERS.get(kind),
    }]
    warnings = []

    if is_first_lp(item):
        date = _date_of(path)
        supp = find_supp(folder, name, date)
        if supp:
            jobs.append({
                "key": os.path.normcase(supp), "name": name, "item": SUPP_LABEL,
                "path": supp, "watermark": SUPP_WATERMARK, "max_pages": SUPP_PAGES,
                "kind": "supp", "printer": PRINTERS.get("supp"),
            })
        else:
            pretty = f"{date[:4]}-{date[4:6]}-{date[6:]}" if len(date) == 8 else date
            warnings.append(f"{name}: no {SUPP_LABEL} dated {pretty} to go with {item} "
                            f"-- printing the lesson plan without it")
    return ("ready", jobs, warnings)


def build_queue(jobs, ask=ask_count):
    """Split rows into a print-ready queue and a deferred (needs-human) list.

    Returns (ready, deferred, warnings). One row can expand into several jobs
    (see plan_row); ask() is called for rows needing a human to choose a count.
    Deferred entries are (name, item, reason).
    """
    ready, deferred, warnings = [], [], []
    for job in jobs:
        name  = (job.get(COL_NAME) or "").strip()
        items = [x.strip() for x in (job.get(COL_ITEMS) or "").split(",") if x.strip()]

        if not name:
            deferred.append(("?", "(none)", "no name")); continue
        if not items:
            deferred.append((name, "(none)", "no item to print")); continue

        for item in plan_row(name, items, ask):
            status, payload, warns = resolve_one(name, item)
            if status == "ready":
                ready.extend(payload)
                warnings.extend(warns)
            else:
                deferred.append((name, item, payload))
    return ready, deferred, warnings


def load_done():
    done = set()
    if os.path.exists(LOG_PATH):
        with open(LOG_PATH, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                if row.get("status") == "PRINTED":
                    done.add(row["key"])
    return done


def mark(key, name, item, status):
    fresh = not os.path.exists(LOG_PATH)
    with open(LOG_PATH, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if fresh:
            w.writerow(["key", "name", "item", "status", "timestamp"])
        w.writerow([key, name, item, status, datetime.now().isoformat(timespec="seconds")])


def _overlay(width, height, text):
    """A single translucent, rotated watermark page sized to the source page."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(width, height))
    c.saveState()
    c.translate(width / 2, height / 2)
    c.rotate(45)
    c.setFont(WM_FONT, WM_SIZE)
    c.setFillColor(Color(0, 0, 0, alpha=WM_DARKNESS))
    c.drawCentredString(0, 0, text)
    c.restoreState()
    c.save()
    buf.seek(0)
    return PdfReader(buf).pages[0]


def build_temp(src, dst, text="", max_pages=None):
    """Write dst from src: optionally first max_pages pages, optionally watermarked."""
    reader, writer = PdfReader(src), PdfWriter()
    pages = reader.pages if max_pages is None else reader.pages[:max_pages]
    for page in pages:
        if text:
            page.merge_page(_overlay(float(page.mediabox.width),
                                     float(page.mediabox.height), text))
        writer.add_page(page)
    with open(dst, "wb") as f:
        writer.write(f)


def print_pdf(path, printer):
    cmd = ([SUMATRA, "-print-to", printer, "-silent"] if printer
           else [SUMATRA, "-print-to-default", "-silent"])
    settings = ([f"{COPIES}x"] if COPIES > 1 else []) + ([PRINT_SETTINGS] if PRINT_SETTINGS else [])
    if printer in DUPLEX_PRINTERS:
        settings.append("duplexlong")
    if settings:
        cmd += ["-print-settings", ",".join(settings)]
    cmd.append(path)
    try:
        subprocess.run(cmd, check=True, timeout=PRINT_TIMEOUT)
    except subprocess.TimeoutExpired:
        # SumatraPDF sometimes prints the page but then fails to exit (known issue with
        # back-to-back network prints). The job has almost certainly reached the spooler,
        # so flag it and let the batch keep moving rather than freezing on this one.
        print(f"      note: SumatraPDF didn't exit within {PRINT_TIMEOUT}s "
              f"(page likely already spooled) -- moving on")


def confirm(ready, deferred, warnings=()):
    by_printer = {}
    for j in ready:
        by_printer[j["printer"]] = by_printer.get(j["printer"], 0) + 1
    tally = "   (" + ", ".join(f"{p}: {n}" for p, n in sorted(by_printer.items())) + ")" if by_printer else ""

    print("\n" + "=" * 64)
    print(f"  READY TO PRINT: {len(ready)}{tally}")
    print("=" * 64)
    for i, j in enumerate(ready, 1):
        tag   = j["watermark"] or "no watermark"
        extra = f", first {j['max_pages']}p" if j["max_pages"] else ""
        print(f"  {i:>2}. {j['name']:20} {j['item']:8} -> {j['printer'] or 'default':16} "
              f"[{tag}{extra}]  {os.path.basename(j['path'])}")
    if warnings:
        print("\n" + "-" * 64)
        print(f"  WARNINGS: {len(warnings)}   (these WILL still print)")
        print("-" * 64)
        for w in warnings:
            print(f"   ~ {w}")
    if deferred:
        print("\n" + "-" * 64)
        print(f"  NEEDS A HUMAN: {len(deferred)}   (skipped -- not printed)")
        print("-" * 64)
        for name, item, reason in deferred:
            print(f"   ! {name:20} {item:8}  {reason}")
    print("=" * 64)
    if not ready:
        print("Nothing to print.")
        return False
    return input(f"Print these {len(ready)}? [y/N] ").strip().lower() in ("y", "yes")


def main():
    jobs = load_jobs()
    ready, deferred, warnings = build_queue(jobs)

    done = load_done()
    skipped = [j for j in ready if j["key"] in done]
    ready   = [j for j in ready if j["key"] not in done]
    if skipped:
        print(f"Skipping {len(skipped)} already printed (per {LOG_PATH}).")

    if not confirm(ready, deferred, warnings):
        print("Aborted. Nothing printed.")
        return

    tmpdir = tempfile.mkdtemp(prefix="wm_print_")
    printed = failed = 0
    since_rest = {}        # printer -> prints since its last batch rest
    for idx, j in enumerate(ready):
        printer = j["printer"]
        try:
            if j["watermark"] or j["max_pages"] is not None:
                tmp = os.path.join(tmpdir, os.path.basename(j["path"]))
                build_temp(j["path"], tmp, j["watermark"], j["max_pages"])
                print_pdf(tmp, printer)
                if not RETAIN_WATERMARKED and os.path.exists(tmp):
                    try: os.remove(tmp)
                    except OSError: pass
            else:
                print_pdf(j["path"], printer)   # assessment: straight through
            mark(j["key"], j["name"], j["item"], "PRINTED")
            printed += 1
            print(f"  printed: {j['name']} {j['item']}  ({printer})")
        except Exception as e:
            mark(j["key"], j["name"], j["item"], f"FAILED: {e}")
            failed += 1
            print(f"  FAILED : {j['name']} {j['item']}  ({e})")
            continue        # a job that never printed shouldn't trigger a cooldown

        # Space out this printer, but only if it has more work still queued.
        cfg = SPACING.get(printer)
        if cfg and any(later["printer"] == printer for later in ready[idx + 1:]):
            since_rest[printer] = since_rest.get(printer, 0) + 1
            if since_rest[printer] >= cfg["batch"]:
                pause = cfg["batch_pause"]; since_rest[printer] = 0
            else:
                pause = cfg["gap"]
            print(f"  ...resting {printer} {pause}s")
            time.sleep(pause)

    print(f"\nDone. printed={printed} failed={failed} deferred={len(deferred)}")
    if RETAIN_WATERMARKED:
        print(f"Watermarked copies kept in: {tmpdir}")


if __name__ == "__main__":
    if "--settings" in sys.argv:
        from settings_gui import main as settings_main
        settings_main()
    else:
        try:
            main()
        except Exception:
            import traceback
            print("\n" + "!" * 62)
            print("  Something went wrong. Please send the lines below to Alec:")
            print("!" * 62)
            traceback.print_exc()
        try:
            input("\nPress Enter to close this window...")
        except EOFError:
            pass
