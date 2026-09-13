# Daily WOP / Deck List automation

Google Apps Script behind the **SOD** and **EOD** menus on the tracking
spreadsheet.

| File | What's in it |
| --- | --- |
| `Config.gs` | Sheet names, column positions, colours. The only file to edit if the layout changes. |
| `Common.gs` | Shared plumbing: buffered sheet access, parsing, the action log, the report dialog. |
| `Sod.gs` | **SOD → Pinks Printed** |
| `Eod.gs` | **EOD → Colored Sheets Batch Process** |
| `Setup.gs` | **Tools → Check setup**: which column every setting points at, next to the header actually sitting there. |
| `Radius.gs` | **Radius** menu — imports values from radius.mathnasium.com. Unfinished; see below. |
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

421 assertions covering the parsing rules and both scripts end to end,
including the recovery paths that are awkward to rehearse by hand in a live
spreadsheet.

---

## Radius import

Highlight the students in **column A** of Daily WOP, then **Radius → Import for
highlighted rows**. The import fetches everything first and shows you what it
found before writing anything:

- one block per student, listing the value destined for each column
- a **checkbox each**, ticked by default — untick anyone to leave them out
- **Confirm changes for all**, or **Apply only the ticked ones**
- Cancel, which changes nothing

Where a target cell already holds something, the preview says so, shows what is
in it, and asks what to do about it — **append**, **overwrite**, or **leave
alone** (fill only the empty cells). That block only appears when there is
actually a clash. Column K is exempt from the choice; its letters are always
folded together.

The plan is parked in the cache between the two phases, one entry per student,
because notes can run to a thousand characters and a whole selection in one
entry would risk the hundred-kilobyte ceiling.

It **also runs as the first step of the EOD batch**, without the dialog — a
modal part way through a batch would be a nuisance, and EOD's own report says
what happened. That is what makes column K work: the import writes the
instruction and the rest of EOD acts on it in the same pass, so the two cannot
be run the wrong way round. Because nobody is asked, EOD defaults to the
harmless option for cells that already hold something —
`CONFIG.RADIUS.EOD_CONFLICT_MODE` is `'skip'`, so it fills the empties and
leaves everything else be.

Set `CONFIG.RADIUS.RUN_ON_EOD` to `false` to keep it to its own menu item. If
it is on but the cookie or the roster settings are missing, EOD still runs its
own work and says in the report why the import did not.

Asks Radius for the **Instruction Manager roster**
(`POST /AnswerKey/GetStudentDataSource`, with `CONFIG.RADIUS.CENTER_ID` as the
centre), matches those names against column A of the highlighted Daily WOP
rows, and reads each student's own DWP page.

The Instruction Manager **page** is deliberately not what gets fetched. Its
student grid is assembled in the browser out of `localStorage`, so the HTML
that arrives over the wire carries the column definitions and not one student
— there is nothing on it to scrape, however many students are checked in. The
endpoint above is where that grid gets its data, and it hands over the four
ids (`studentId`, `attendanceId`, `centerId`, `dwpEntryId`) that the DWP link
is built from, rather than a rendered link. That is the same way the page
itself builds the link, so no id is ever guessed.

The DWP page is server-rendered ASP.NET — values appear as real `value="..."`
attributes in the raw HTML — so `UrlFetchApp` can read it without a browser.

### What is extracted, and where it lands

| Column | Field | Written as |
| --- | --- | --- |
| F | Problem of the Week | `Y`, or blank |
| G | Mastery / assessment | `PK3918(100), PK3902(0), Pre completed` |
| H | Pages completed | the number |
| J | Finalized | `Y`, or blank |
| K | Deck update | `P`, folded into the existing cell |
| L | Signed in | `10:48 AM`, or blank |
| M | Signed out | `11:48 AM`, or blank |
| O | Session summary | the note text |
| P | Internal notes | the note text, plus timing notes, plus `MLS (3)` |

Yes/no answers write a bare **`Y`**, matching how the sheet is filled in by
hand; a No writes nothing rather than the word "No". Times are plain times,
blank until they happen. Rearranging is a `column:` change in
`CONFIG.RADIUS.FIELDS`.

An empty field returns empty — that is a real answer. A **missing** element
throws instead, because it means the page changed shape, and a wrong value is
worse than a loud failure.

### Session timing

Sessions are booked on the hour, so a normal one runs about an hour and a
double about two. `CONFIG.RADIUS.TIMING` sets the bands:

| Length | Result |
| --- | --- |
| 53–67 min | normal — nothing said |
| 106–134 min | normal double — `2 hour session` noted in P |
| anything else | **sign-in and sign-out shaded orange** |

A session shorter than 53 minutes is then looked at more closely, because
there are two ordinary reasons for one and they are worth telling apart:

- signed in **10 or more minutes past the hour** → `signed in 12 minutes late`
- signed out **10 or more minutes before the hour** → `left 20 minutes early`

Either earns a note in column P; both earn both. The notes are appended to
whatever internal note Radius already held, separated by `|`:

```
she doesnt shut up big L | signed in 12 minutes late | left 20 minutes early
```

Some details that fall out of this:

- The shading is about **length alone**. A 52-minute session where the student
  was punctual and left only 8 minutes early is shaded with nothing to
  explain it — which is the point: it's asking for a human look.
- Signing out exactly on the hour is not leaving early.
- A **long** session is never examined for lateness; that rule is for short
  ones only.
- A student still in the centre has no sign-out time, so nothing is judged and
  nothing is shaded.

The field keys `TIMING` works from are asserted to resolve against the real
field list, because a typo there fails silently — the review simply sees no
times and does nothing.

### What column P ends up holding

The internal note from Radius, then anything the run worked out, joined by `|`:

```
she doesnt shut up big L | signed in 12 minutes late | left 20 minutes early | MLS (3)
```

The Mathlete score is last and only appears when Radius carries one.

### Column K is shared with the EOD script

Column K is `CONFIG.WOP_COL.STATUS` — the Y/P column EOD reads and writes.
A deck update belongs there, because **a deck update and a P are the same
thing**: EOD writes pink into Deck List column C, and SOD then moves that
student's queue into column E. That is what Radius calls a deck update.

So the import writes **`P`**, never `Y`. A `Y` there would read as *finish a
task* and make EOD advance the student's Deck List row.

Because the column is shared, that one field writes differently from the rest
(`merge: 'statusLetters'` in the field config):

- The P is **folded into** whatever the cell already holds rather than
  replacing it, so a hand-typed `Y` plus a deck update becomes `YP`.
- A cell that already carries a P is left alone rather than doubled.
- A row EOD has already finished — green — is **skipped entirely**, text and
  colour untouched, and the report says why.
- A cell holding one of EOD's markers (`YYP - B empty?`,
  `Y (2 of 3 done, ran out)`) is **refused**, because those record outstanding
  work and flattening one back to bare letters would lose it. The report names
  the row so it can be sorted out by hand.

**Run the import before EOD.** The import fills in the instruction; EOD
executes it. Running EOD first is safe — those rows go green and the import
then skips them — but the deck update won't have been picked up that day.

A test asserts this is the only merge field, and that nothing ever targets
column A.

### The mastery column

Column U lists every assignment that was **finished**, in learning-plan order:

```
PK3918(100), PK3902(0), PK3901(0), PK3900(100), PK3910(100), PK3916(0)
```

`100` is Completed & Mastered, `0` is Completed but Not Mastered. A row that
was only *worked on* — neither box ticked — is left out, so the column records
what was finished rather than what was attempted. On the completed sample all
seven topics were worked on but only six were finished, and only three of
those mastered.

The page writes `PK-3918-00`; the trailing segment is a revision number and is
dropped, giving `PK3918`. A completed row with no PK code falls back to its
topic name rather than emitting a bare `(100)`.

The page's own script stops both boxes being ticked at once. If one ever slips
through, mastered wins.

### Also available, not yet wired up

Extractable and tested, but not written to any column. Add an entry to
`CONFIG.RADIUS.FIELDS` to start writing one:

| Extractor | Meaning |
| --- | --- |
| `topicsWorkedOn` | LP rows with Worked-On ticked, as topic names *(was in column U)* |
| `completedMastered` | Completed & Mastered, as topic names |
| `completedNotMastered` | Completed but Not Mastered, as topic names |
| `mathleteScore` | Cool Down → Mathlete Score (1–3) |
| `assessmentStatus` | e.g. "Pre completed", read from the radio's label |

### Guard against a mislinked row

Every DWP page names its own student in the `<title>`. After fetching, that
name is compared against the Daily WOP row; a mismatch is reported and nothing
is written. A wrong roster link therefore cannot quietly fill in another
student's data.

### Authentication

`UrlFetchApp` has no browser session, so requests need a credential or Radius
just returns the sign-in page — with a perfectly normal `200`, which is why
`looksLikeLoginPage_` exists rather than trusting the status code.

**Radius → Set session cookie** stores a cookie copied from a logged-in
browser in Script Properties. It is not in the spreadsheet and is not visible
to people the sheet is shared with, and no password is stored anywhere. The
trade-off is that it expires; when it does, the import says so plainly.
**Radius → Test connection** checks the cookie *and* the roster without
touching the spreadsheet.

### How names are matched

Roster names and Daily WOP names are typed by different people, so matching
ignores case and spacing and treats `Doe, Jane` as `Jane Doe`. The Daily WOP
side reuses `extractName_`, so a leading appointment time is stripped first.

A name that doesn't match is reported as *spelled differently, or the wrong
centre* — kept distinct from a student who is on the roster but **has not
checked in**, and from one who has checked in but **has no DWP 2.0 yet**.

Two students whose names normalise to the same thing are refused rather than
guessed at. A Daily WOP row cannot say which of them it means, and the
student-name guard below would confirm either one, so neither is safe.

### Notes

- The roster is fetched once per run, then one page per matched student.
- `CONFIG.RADIUS.CENTER_ID` is your centre number as Radius writes it. A
  virtual centre is prefixed with `v`, and more than one can be listed:
  `'2514,v972'`.
- Nothing is written until every row has been attempted.
- There is a `FETCH_DELAY_MS` pause between fetches. Radius is someone else's
  server.
- The run stops itself before the 6-minute Apps Script ceiling, saves what it
  has, and tells you to highlight the rest and run again.


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

9. **The history column moved.** It was `13` (M); it is `14` (N) until the
   migration above is finished, then `13` again.

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
