# Batch Print

Prints student PDFs from a list in a Google Sheet. Runs on the Windows PC wired to
the printers and to `\\newcloud`. Three files: `batch_print.py` (the program),
`config_store.py` (settings schema), `settings_gui.py` (settings editor).

Flow: read sheet -> resolve each row to real files -> show a manifest -> ask to
confirm -> watermark/slice into temp copies -> print via SumatraPDF -> log.

## Ground truth

- **Sheet**: two columns, a student `Name` ("First Last") and `Print`, a
  comma-separated list of items. Read as a published CSV over the web (not Apps
  Script -- Google's sandbox can't reach the share or the printers).
- **Files** live under `\\newcloud\Public\NEW Current Students\+First Last\`, in
  either `Upcoming Decks\` or `Assessments\`. Note the literal `+` on the folder.
- **Dates are never in the sheet** -- only in filenames. So paths are globbed with
  the date wildcarded, never constructed.

## Settings live in config.json, not in code

Everything that differs by install -- the Sheet URL, column headers, the base
path, printer names and their protocol (duplex, pacing), which job kind routes
to which printer, watermark text/pages, print scaling, timeouts -- is in
`config.json`, loaded once at import time by `batch_print.py` via
`config_store.flatten(config_store.load_config())` and exposed as the same
flat module-level names the code always used (`SHEET_CSV_URL`, `PRINTERS`,
`SPACING`, ...). This was a deliberate refactor from an earlier version where
those were hardcoded constants at the top of `batch_print.py`; the flat names
were kept exactly so the rest of the file, and every existing test, didn't
have to change shape.

- **`config_store.py`** owns the schema: `DEFAULTS`, `load_config`/`save_config`
  (atomic write via temp file + `os.replace`), `validate` (returns a list of
  human-readable problems, `[]` = safe to save/run), and `flatten` (nested
  config -> the flat names `batch_print.py` uses).
- **`printers`** is a registry (name -> `{duplex, paced, gap, batch,
  batch_pause}`), not a fixed-shape section. `_merge` special-cases it:
  everything else in the schema drops unknown keys from a hand-edited or
  stale `config.json` (so garbage can't leak into the flat config), but a
  user-added printer name is exactly the kind of "unknown key" that must
  survive, or adding a printer through the GUI, saving, and reopening would
  silently lose it. If you touch `_merge`, keep `_merge_printers` separate --
  this already broke once (round-tripped fine through the GUI's own
  validate/save, then vanished on the next `load_config()`) and there's a
  regression test for it (`test_merge_keeps_a_user_added_printer`,
  `test_save_then_load_keeps_a_new_printer`).
- **`routing`** (job kind -> printer name) IS fixed-shape (the five
  `JOB_KINDS`), so it merges normally.
- **Changing which printer handles a job** happens in `settings_gui.py`
  three ways, each with different intent: **add** a printer and route a job
  kind to it; **remove** one, which deliberately leaves anything still
  routed to it broken until the user picks a replacement (`validate()`
  names the orphaned kind and the missing printer); **rename** one in
  place, which is treated as the same physical printer under a new label,
  so `PrinterRow`'s name-change trace (`_name_changed` ->
  `SettingsApp._printer_renamed`) rewrites every routing entry pointing at
  the old name to the new one automatically. Don't collapse rename into
  remove-and-add, or every routed job on that printer silently breaks the
  moment someone corrects a typo in its name.
- **`settings_gui.py`** is the only supported way to edit `config.json` for a
  non-technical user. It mirrors `config_store.validate()`'s rules at parse
  time in `_collect()` (e.g. an unpaced printer's `batch` field has no
  minimum, since it's inert) -- if you add a validation rule in one place,
  check whether the other needs it too, or the GUI can either reject a
  config `validate()` would accept, or accept one it will reject on save.
  It has no automated test (needs Tkinter + a display); exercise it by hand,
  or headlessly via Xvfb if you need to script a check.

**Two filename conventions, and this trips people up:**
- SD / TEMP / assessments: `First Last SD12 20240115.pdf` — spaces, `YYYYMMDD`
- LP / SUPP: `Amalie Laz_LP 1 of 3_2026-07-30.pdf` — underscores, `YYYY-MM-DD`

`_date_of()` handles both. LP matching deliberately ignores whitespace (`LP 1 of3`
still matches) because that typo is real in the wild and would otherwise silently
cause an *older* file to print.

**SUPP** is never requested in the sheet. It's pulled in automatically alongside an
`LP 1 of N` (first lesson plan only), matched by **exact same date** as that LP. No
same-date SUPP -> warn loudly, still print the LP. Never blocks.

## Which items in a row get printed

A "deck" = `SD##` or `LP # of #`. In `plan_row()`:

- 2+ decks -> **only the first deck**, everything else dropped
- 1 deck alone, or 1 deck + 1 other -> print them
- 1 deck + several others -> **ask the user** how many
- no deck, 1 item -> print it
- no deck, several -> **ask the user** how many

Prompts happen before the manifest. `TEMP` counts as an ordinary item here, not a
deck — so `TEMP, SD1` prints both.

## Printing

SumatraPDF, silent, called per file; it lives next to the script (or the frozen
.exe). Watermark and page-slicing are written to a temp copy — **originals are
never modified**.

- Whether a printer duplexes, and whether it's paced (gap between prints, a
  longer rest every N), is per-printer, set in `config.json` under
  `printers.<name>` and edited via Settings, not hardcoded per printer name.
  The shipped defaults: **SMALLFATBEAR** duplex, unpaced (short jobs, runs
  hot); **ProvisionalBear** single-sided, paced 30s/gap, 60s rest every 4
  (40+ page decks -- don't shorten this without a reason, it exists because
  back-to-back jobs were choking it).
- `PRINT_TIMEOUT` (default 120s, in `config.json` under `print.timeout`)
  exists because SumatraPDF can print a page and then hang on exit. On
  timeout: warn, move on. One stuck job must not freeze the batch.
- `print_log.csv` records what printed, so a crash mid-batch doesn't double-print.

## House rules

- **Errors defer, they don't guess.** Missing file, ambiguous match, blank name ->
  it lands in "NEEDS A HUMAN" on the manifest with a reason, and nothing prints.
  The only soft failure is a missing SUPP, which warns.
- **Nothing prints without the confirm prompt.**
- `noscale` is deliberate (the default `print.settings`). These are dimensioned
  drawings; "fit" would rescale them.
- Watermark is Helvetica 72pt at 15% black by default, diagonal, centred --
  all four of those (font, size, darkness, and per-item text) are settings,
  not constants. Verified by rasterizing: 15% over white = pixel value 217.
- Windows-only in practice (UNC paths, SumatraPDF, printer names).

## Testing

```
py -m pip install pypdf reportlab
py test_batch_print.py      # matching / routing / printing logic, 26 tests
py test_config_store.py     # settings schema, 26 tests, no pypdf/reportlab needed
```

Both must pass after any change to matching, the decision tree, watermarking,
or the settings schema -- that's where the subtle bugs live. `settings_gui.py`
has no automated coverage; verify a UI change by running it (or scripting it
headlessly against Xvfb, importing `settings_gui` and driving the widgets
directly, which is how the printer-registry merge bug above was actually
caught).

Unlike the environment this was originally written in, you can see the actual share
and printers. Prefer checking real filenames over assuming.

## Open / unresolved

- Sheet must be published as CSV per install (`sheet.csv_url` in
  `config.json`, set via Settings); anyone with the link can then read it.
  `gspread` + a service account is the private upgrade (stub in
  `batch_print.py`, above `load_jobs()`).
- SUPP filename shape was never confirmed — matching is loose (name + `SUPP`
  anywhere + right date). Tighten once the real convention is known.
- Only `LP 1 of N` pulls a SUPP. Unconfirmed whether later LPs should too.
- LP has no page cap. TEMP caps at 20, SUPP at 15 (both settings).
- Duplex is long-edge only (`duplexlong`); a landscape assessment routed to a
  duplex printer would want `duplexshort` -- not yet exposed as a setting.
- This tool is intended to eventually run as part of the same Google Sheet
  the `.gs` scripts in the parent `sheetyveety` repo drive, rather than as a
  separate desktop app the sheet merely publishes CSV for. For now it's a
  self-contained subsection of that repo (`printing/`); see that repo's root
  `README.md` for how the two relate.
