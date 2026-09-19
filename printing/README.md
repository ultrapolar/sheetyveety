# Batch Print — bundle contents

Everything needed to run, install, or continue developing the tool.

| File | What it's for |
|---|---|
| `batch_print.py` | The program. Reads its settings from `config.json` at startup. |
| `config_store.py` | The settings schema: defaults, load/save, and validation. No GUI or PDF libraries -- both `batch_print.py` and `settings_gui.py` depend on it. |
| `settings_gui.py` | "Batch Print Settings" -- a small window for editing `config.json` without touching code: the Sheet URL, printers and their protocol (duplex, pacing), which job kind routes to which printer, watermarks, page caps. |
| `config.json` | The settings this install actually uses. Ships with placeholder values (see `sheet.csv_url`) -- open Batch Print Settings and fill in the real ones before the first run. |
| `CLAUDE.md` | Project context — read automatically by Claude Code each session. |
| `test_batch_print.py` | 26 tests for the matching/routing/printing logic. No printer or share needed. |
| `test_config_store.py` | 26 tests for the settings schema (load, save, validate, merge). |
| `install.bat` | One-click install on the print PC; also sets up the Settings shortcut. |
| `build_exe.bat` | Builds standalone `batch_print.exe` and `batch_print_settings.exe` (no Python needed on target PCs). |
| `INSTALL.txt` | Plain-English setup guide for non-technical users. |
| `sample_sheet.csv` | Example of every row shape the script handles. |

## Settings, not source

Every site-specific value -- the Sheet URL, the printer names, which kind of
job goes to which printer, duplex/pacing, watermark text and page caps --
lives in `config.json`, not in `batch_print.py`. Change it through
**Batch Print Settings** (`settings_gui.py`, or the desktop shortcut
`install.bat` creates) rather than hand-editing the file or the script:
the editor won't let you save a config that routes a job to a printer that
doesn't exist, leaves the Sheet URL as the placeholder, or has an empty
column header. See `config_store.py` for the exact schema and validation
rules if you're changing what settings exist, not just their values.

## Continuing development in Claude Code

```
cd %LOCALAPPDATA%\BatchPrint      (or wherever you unzip this)
git init && git add -A && git commit -m "working version"
claude
```

`CLAUDE.md` is picked up automatically, so the session starts with the domain
rules already in hand.

## Running the tests

```
py -m pip install pypdf reportlab
py test_batch_print.py
py test_config_store.py
```

Expect `26/26 passed` for each. Run these after any change to file matching,
the decision tree, watermarking, or the settings schema -- that's where the
subtle bugs live. `test_config_store.py` needs neither pypdf/reportlab nor a
display; `settings_gui.py` isn't covered by an automated test (it needs
Tkinter and a display), so a change there is worth exercising by hand.

## Not included

`SumatraPDF.exe` — download the 64-bit **portable** build from
sumatrapdfreader.org, rename it to `SumatraPDF.exe`, and put it in this folder.
The script expects it right beside itself.
