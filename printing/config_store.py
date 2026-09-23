"""Load, validate, and save Batch Print's settings.

Settings live in ``config.json`` next to this file (or next to the frozen
.exe). This module is kept free of pypdf/reportlab/tkinter so both
``batch_print.py`` and ``settings_gui.py`` can import it cheaply, and so it
can be unit tested without a display or the PDF libraries installed.

A printer is a named physical device with its own protocol: whether it
duplexes, and whether jobs sent to it are paced (a gap between prints, with
a longer rest every so many). "Routing" says which printer handles each
kind of print job -- decks, lesson plans, TEMP, SUPP, and everything else.
"""

import copy
import json
import os
import sys

JOB_KINDS = ("deck", "lp", "temp", "supp", "assessment")


def _app_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


CONFIG_PATH = os.path.join(_app_dir(), "config.json")

DEFAULTS = {
    "sheet": {
        "csv_url": "https://docs.google.com/spreadsheets/d/XXXX/pub?gid=0&single=true&output=csv",
        "col_name": "Name",
        "col_items": "Print",
    },
    "paths": {
        "base": r"\\newcloud\Public\NEW Current Students",
        "deck_subdir": "Upcoming Decks",
        "assess_subdir": "Assessments",
    },
    # Printer registry: name -> protocol (duplex, and pacing to manage heat).
    "printers": {
        "ProvisionalBear": {"duplex": False, "paced": True, "gap": 30, "batch": 4, "batch_pause": 60},
        "SMALLFATBEAR": {"duplex": True, "paced": False, "gap": 0, "batch": 0, "batch_pause": 0},
    },
    # Which printer handles each kind of job.
    "routing": {
        "deck": "ProvisionalBear",
        "lp": "ProvisionalBear",
        "temp": "ProvisionalBear",
        "supp": "ProvisionalBear",
        "assessment": "SMALLFATBEAR",
    },
    "temp": {"watermark": "", "pages": 20},
    "supp": {"watermark": "WOB", "pages": 15, "label": "SUPP"},
    "print": {"settings": "noscale", "copies": 1, "timeout": 120},
    "behavior": {"retain_watermarked": False, "log_path": "print_log.csv"},
    "watermark_style": {"font": "Helvetica", "size": 72, "darkness": 0.15},
}


def default_config():
    return copy.deepcopy(DEFAULTS)


# Per-printer protocol fields. Used to backfill an individual printer entry,
# not to limit which printer NAMES are allowed -- "printers" is a registry a
# user grows, unlike every other section, which has a fixed set of keys.
_PRINTER_DEFAULTS = {"duplex": False, "paced": False, "gap": 0, "batch": 0, "batch_pause": 0}


def _merge_printers(saved):
    if not isinstance(saved, dict):
        return copy.deepcopy(DEFAULTS["printers"])
    return {
        name: _merge(_PRINTER_DEFAULTS, protocol)
        for name, protocol in saved.items()
        if isinstance(name, str) and name.strip()
    }


def _merge(defaults, overrides):
    """Deep-merge overrides onto a copy of defaults. Unknown keys are dropped
    so a stale or hand-edited config.json can't inject something batch_print
    doesn't expect -- except under "printers", where the keys ARE the point
    (each one a printer name the user added) and must never be filtered
    against a fixed default set."""
    out = copy.deepcopy(defaults)
    if not isinstance(overrides, dict):
        return out
    for key, val in overrides.items():
        if key == "printers" and "printers" in out:
            out["printers"] = _merge_printers(val)
            continue
        if key not in out:
            continue
        if isinstance(out[key], dict) and isinstance(val, dict):
            out[key] = _merge(out[key], val)
        else:
            out[key] = val
    return out


def load_config(path=None):
    """The saved config merged onto the defaults, or just the defaults if
    the file is missing, unreadable, or not valid JSON."""
    path = path or CONFIG_PATH
    if not os.path.exists(path):
        return default_config()
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return default_config()
    return _merge(DEFAULTS, raw)


def save_config(config, path=None):
    """Write atomically so a crash mid-save can't leave a half-written,
    unparsable config.json behind."""
    path = path or CONFIG_PATH
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, sort_keys=True)
    os.replace(tmp, path)


def validate(config):
    """Human-readable problems with this config, or [] if it's safe to save
    and safe for batch_print to run with."""
    problems = []

    sheet = config.get("sheet", {})
    if not sheet.get("csv_url", "").strip():
        problems.append("Sheet CSV URL is empty.")
    elif sheet.get("csv_url", "").strip() == DEFAULTS["sheet"]["csv_url"]:
        problems.append("Sheet CSV URL is still the placeholder -- publish your sheet "
                         "(File > Share > Publish to web > CSV) and paste its link.")
    if not sheet.get("col_name", "").strip():
        problems.append("Name column header is empty.")
    if not sheet.get("col_items", "").strip():
        problems.append("Print-items column header is empty.")

    paths = config.get("paths", {})
    if not paths.get("base", "").strip():
        problems.append("The student-files base path is empty.")

    printers = config.get("printers", {})
    if not printers:
        problems.append("At least one printer must be defined.")
    for name, p in printers.items():
        if not name.strip():
            problems.append("A printer has a blank name.")
        if p.get("paced"):
            for field in ("gap", "batch_pause"):
                if not isinstance(p.get(field), int) or p[field] < 0:
                    problems.append(f"{name}: '{field}' must be a non-negative whole number of seconds.")
            if not isinstance(p.get("batch"), int) or p["batch"] < 1:
                problems.append(f"{name}: 'batch' must be at least 1 when pacing is on.")

    routing = config.get("routing", {})
    for kind in JOB_KINDS:
        target = routing.get(kind, "")
        if not target.strip():
            problems.append(f"No printer routed for '{kind}'.")
        elif target not in printers:
            problems.append(f"'{kind}' is routed to '{target}', which isn't one of the defined printers.")

    temp = config.get("temp", {})
    if not isinstance(temp.get("pages"), int) or temp["pages"] <= 0:
        problems.append("TEMP page cap must be a positive whole number.")

    supp = config.get("supp", {})
    if not isinstance(supp.get("pages"), int) or supp["pages"] <= 0:
        problems.append("SUPP page cap must be a positive whole number.")
    if not supp.get("label", "").strip():
        problems.append("SUPP label is empty.")

    printinfo = config.get("print", {})
    if not isinstance(printinfo.get("copies"), int) or printinfo["copies"] <= 0:
        problems.append("Copies must be a positive whole number.")
    if not isinstance(printinfo.get("timeout"), int) or printinfo["timeout"] <= 0:
        problems.append("Print timeout must be a positive whole number of seconds.")
    if printinfo.get("settings") not in ("noscale", "fit", "shrink"):
        problems.append("Print scaling must be one of: noscale, fit, shrink.")

    style = config.get("watermark_style", {})
    if not isinstance(style.get("size"), int) or style["size"] <= 0:
        problems.append("Watermark font size must be a positive whole number.")
    darkness = style.get("darkness")
    if not isinstance(darkness, (int, float)) or not (0 < darkness <= 1):
        problems.append("Watermark darkness must be a number greater than 0 and at most 1.")
    if not style.get("font", "").strip():
        problems.append("Watermark font is empty.")

    behavior = config.get("behavior", {})
    if not behavior.get("log_path", "").strip():
        problems.append("Log file path is empty.")

    return problems


def flatten(config):
    """Expand the nested config into the flat module-level names batch_print.py
    uses (SHEET_CSV_URL, PRINTERS, SPACING, ...). Kept as a separate step so
    batch_print's variable names -- and its tests -- don't have to change
    shape just because settings moved into a file."""
    printers = config["printers"]
    routing = config["routing"]
    return {
        "SHEET_CSV_URL": config["sheet"]["csv_url"],
        "COL_NAME": config["sheet"]["col_name"],
        "COL_ITEMS": config["sheet"]["col_items"],
        "BASE": config["paths"]["base"],
        "DECK_SUBDIR": config["paths"]["deck_subdir"],
        "ASSESS_SUBDIR": config["paths"]["assess_subdir"],
        "TEMP_WATERMARK": config["temp"]["watermark"],
        "TEMP_PAGES": config["temp"]["pages"],
        "SUPP_WATERMARK": config["supp"]["watermark"],
        "SUPP_PAGES": config["supp"]["pages"],
        "SUPP_LABEL": config["supp"]["label"],
        "PRINTERS": dict(routing),
        "DUPLEX_PRINTERS": {name for name, p in printers.items() if p.get("duplex")},
        "SPACING": {
            name: {"gap": p["gap"], "batch": p["batch"], "batch_pause": p["batch_pause"]}
            for name, p in printers.items() if p.get("paced")
        },
        "PRINT_SETTINGS": config["print"]["settings"],
        "COPIES": config["print"]["copies"],
        "PRINT_TIMEOUT": config["print"]["timeout"],
        "RETAIN_WATERMARKED": config["behavior"]["retain_watermarked"],
        "LOG_PATH": config["behavior"]["log_path"],
        "WM_FONT": config["watermark_style"]["font"],
        "WM_SIZE": config["watermark_style"]["size"],
        "WM_DARKNESS": config["watermark_style"]["darkness"],
    }
