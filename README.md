# Daily WOP / Deck List automation

Google Apps Script behind the **SOD** and **EOD** menus on the tracking
spreadsheet.

| File | What's in it |
| --- | --- |
| `Config.gs` | Sheet names, column positions, colours. The only file to edit if the layout changes. |
| `Common.gs` | Shared plumbing: buffered sheet access, parsing, the action log, the report dialog. |
| `Sod.gs` | **SOD → Pinks Printed** |
| `Eod.gs` | **EOD → Colored Sheets Batch Process** |
| `Menu.gs` | Menu construction. |
| `tests/` | A fake Sheets API so the logic runs outside Google. |

## Installing

In the Apps Script editor, create one script file per `.gs` above and paste the
contents in. Order does not matter. If you would rather keep a single file,
concatenating them in any order works too.

## Running the tests

Needs Node, nothing else:

```
node tests/run.js
```

121 assertions covering the parsing rules and both scripts end to end,
including the recovery paths that are awkward to rehearse by hand in a live
spreadsheet.

---

## How Column K is read

Column K on the Daily WOP sheet is an instruction, not a record of what
happened. Each `Y` means *advance this student one task*; a `P` means *mark
them pink*. The script always leaves behind **the work still outstanding**:

| Column K after a run | Colour | Meaning |
| --- | --- | --- |
| `YYP` | green | Done. Skipped by every later run. |
| `YYP - B empty?` | yellow | Nothing was applied. Fill in Column B and run again. |
| `Y (2 of 3 done, ran out)` | yellow | Two advanced, one still owed. Top up Column B or E and run again. |
| unchanged | red | Could not be processed at all — see the report. |

Because the leftover letters are the remaining instruction, re-running a
flagged row does exactly the work that is still missing. Anything the script
appended (`- B empty?`, `(… ran out)`) is stripped before the letters are read,
and the old `Y - B empty?` wording from the previous version is still
understood.

## Changes in behaviour from the previous version

These are deliberate. The first three are bug fixes where the old behaviour
lost or duplicated work.

1. **An empty Column B no longer destroys the instruction.** The old script
   overwrote Column K with the literal text `Y - B empty?`, so `YYP` came back
   as a single `Y` with the P gone. A recovery run then advanced the student
   once instead of twice. The letters are now preserved.

2. **Running out of tasks records what is left, not what was done.** The old
   script wrote back the number of Y's it *completed*, so re-running after a
   top-up advanced the student that many times **again**. It now writes the
   remainder.

3. **A blocked row is all-or-nothing.** When Column B is empty, the pink is
   deferred along with the Y's rather than being applied on its own. This is
   what makes point 1 safe: the recovery run applies the whole cell, and no
   pink can be set twice. Previously the pink went in immediately while the
   Y's did not.

4. **SOD writes nothing until you confirm.** Errors used to be painted onto the
   sheet during the scan, before the dialog appeared, so closing the dialog
   left red cells and no explanation. The run is now a single confirmed step:
   cancel and the spreadsheet is untouched.

5. **The item count in the SOD dialog is enforced on the server.** The `min`
   and `max` on the number box never actually ran — the button bypasses form
   validation — so entering `0` cleared the pink flag while moving nothing.
   The count is now clamped to the queue length at both ends.

6. **A duplicated name on the Deck List is refused.** It used to silently pick
   whichever row came first.

7. **Multiple P's in one cell** apply a single pink and say so in the report.

8. **Students matched but not pink** are counted in the SOD summary instead of
   vanishing without a trace.

## The rest of what changed

- **Speed.** Reads and writes are batched. A 40-student EOD run went from ~364
  spreadsheet round trips to 15, and that figure no longer depends on whether
  the students sit next to each other on the roster. Bulk writes check the
  affected span for formulas first and fall back to per-cell writes if it finds
  any, so a formula in a column the script touches is never flattened into its
  own result.
- **Concurrency.** Both scripts take a document lock, so two people running a
  batch at the same time queue up instead of interleaving their writes.
- **Stale rows.** SOD re-reads the Deck List when you confirm and checks that
  the name, the pink flag, the Column E state and the Column F queue are all
  still what the dialog was built from. If a row moved or changed while the
  dialog sat open, that student is skipped with an explanation instead of being
  written over.
- **Escaping.** Names and task text are HTML-escaped in every dialog. A name
  containing `<` or `&` used to break the layout.
- **Failures are visible.** The dialog has a failure handler, so a server-side
  error shows up as a message instead of a button stuck on "Processing…".
  Partial work is saved and the report says where the run stopped.
- **Times.** Names like `10:30am-11:00am Jane Doe` and `9 - 10 Jane Doe` now
  parse. The old pattern only stripped a single leading time and left the rest
  of a range glued to the name, which then failed the Deck List lookup.
- **Whole-column selections** are clamped to rows that hold data.
- **Green detection** tolerates `#00FF00` and `#0f0`. If your team uses other
  greens, add them to `CONFIG.DONE_COLORS` — anything not listed is treated as
  unprocessed and will be run again.
- **Reports** list problems before successes, and count "needs attention"
  rather than lumping warnings and errors together as "issues".
