# Daily WOP / Deck List automation

Google Apps Script behind the **SOD** and **EOD** menus on the tracking
spreadsheet.

| File | What's in it |
| --- | --- |
| `Config.gs` | Sheet names, column positions, colours. The only file to edit if the layout changes. |
| `Common.gs` | Shared plumbing: buffered sheet access, parsing, the action log, the report dialog. |
| `Sod.gs` | **SOD → Pinks Printed** |
| `Seating.gs` | **SOD → Organise rows from the seating chart**, and **EOD → Seating chart for highlighted rows**. |
| `Eod.gs` | **EOD → Colored Sheets Batch Process** |
| `Setup.gs` | **Tools → Check setup**: every column the script reads or writes, next to the heading actually sitting there. |
| `Radius.gs` | **EOD → Bring in Radius sessions**, and the Radius sign-in under **Tools** — reads radius.mathnasium.com. |
| `Attendance.gs` | **EOD → Who signed in and out**: Radius's attendance report checked against column A. Reads only. |
| `Day.gs` | **SOD → Jump to today / Start a new day**. |
| `Schedule.gs` | **SOD → Paste the calendar**. |
| `Changelog.gs` | The **Changelog** menu, and **Tools → Calendar: set the calendar**. |
| `Progress.gs` | **Changelog → Draft a progress report**. |
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

1153 assertions covering the parsing rules and every menu entry end to end,
including the recovery paths that are awkward to rehearse by hand in a live
spreadsheet.

---

### The menus

Grouped by what an entry does to the sheet, not by which feature it came from.

| Menu | Entries |
| --- | --- |
| **SOD** | Jump to today · Start a new day · Paste the calendar (today / tomorrow / pick a day) · Pinks Printed |
| **EOD** | Colored Sheets Batch Process · Bring in Radius sessions · Bring in seating · Who signed in and out (today / pick a day) |
| **Changelog** | 1. Create · 2. Grade · 3. Learning plan · Draft a progress report |
| **Tools** | Check setup · Radius: sign in · Radius: test connection |

SOD and EOD are the day's work — every entry there reads the sheet or fills it
in. **Tools is everything else**: the checks and the Radius sign-in, set up
once and then forgotten, none of which writes a student's data. A test enforces
the split, so a sign-in box can't drift into the middle of somebody's
end-of-day run.

## Radius import

Highlight the students in **column A** of Daily WOP, then **EOD → Radius import
for highlighted rows**. Nothing runs on its own — the colored-sheets batch and
the import are two deliberate clicks, in whichever order suits you. Running the
import first puts its `Y` in column K for the batch to act on. The import fetches everything first and shows you what it
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

## Who signed in and out

**EOD → Who signed in and out — today** (or **— pick a day**). Asks Radius who
signed in on the day, checks that against **column A** of the day's block on
the Daily WOP, and shows what it found. Flagged in red:

- **Signed in more than once.** A double is one sign-in of two hours, so two
  sign-ins is somebody who left and came back, or was signed in twice by
  mistake. Both times are listed.
- **Signed in, not in column A.** On Radius's report, nowhere in the day's
  block, or written there under a different name.
- **In column A, no sign-in.** In the day's block, the hour on their row has
  started, and Radius has no sign-in for them. The row number is given.
- **Marked not coming, but signed in.** The row says `LM cancel` or `no show`
  (`CONFIG.RADIUS.SKIP_MARKERS`) and Radius has them in anyway.

And for information:

- **Still signed in**: an arrival with no departure. For a day gone by the
  heading reads **Never signed out**.
- **In column A, later today**: not in yet, and not due yet either, so a 4:00
  student is not called a no-show at noon.
- **Marked not coming**: rows that already say so, left out of the no-shows.
- **Everybody who signed in**: name, the column A row(s) they are on, in, out,
  minutes, In-Center or At Home, in sign-in order. A flagged sign-in is shaded
  red; an odd session length (the Radius import's timing review) amber.

**It writes nothing.** This is the first use of this part of Radius. A wrong
report costs a second look; a wrong column costs a day's records. Filling in
columns L and M from here, in place of the one-page-per-student read the
Radius import does now, is the natural next step once it has proved itself.

### Which rows of column A are students

The day's block is the rows under its dated heading ("9/26/2026 Saturday"),
down to the next day's. A block laid out by **Paste the calendar** opens with
the instructors and anything else on the calendar, then its **@HOME** and
**In-Center** headings, so a student is any row **under one of those
headings**. The instructors and the staff meeting above them are not.

A block with neither heading was typed by hand. There, a student is any row
that starts with a time and is not an instructor's shift, and the report says
it read the block that way.

A student written on two rows (a double, as two hours) is one student with
two rows. The hour on the row decides "later today", read the way the centre
runs: a bare 4:00 is the afternoon.

No row for the day on the Daily WOP, or nothing under it yet: the sign-ins are
still shown, with a note saying why, and **nobody is called a no-show or an
extra**. Without column A there is no knowing who was expected.

### Where it comes from

Radius → **Student Attendance Report**, Detail View. The page builds its table
in the browser, from one request:

`POST /StudentAttendanceReport/StudentAttendanceReport_Read`

That is a form post, not JSON, and it is sent **field for field as the page
sends it**, copied from the browser's own request: start and end the same day
(`9/26/2026 12:00:00 AM`), `centerId` from `CONFIG.RADIUS.ATTENDANCE.CENTER_ID`,
the page's own grouping and paging, and the antiforgery token in the body.
Some of those fields do nothing for us, but a server is only known to answer
the request it has been seen answering.

What comes back is grouped by student and then by enrollment, and **every
group carries its rows twice**, under `Items` and again under `Subgroups`.
Only one is followed; reading both would count everybody twice, and a test pins
it.

The times used are the ones Radius has already written out
(`ArrivalTimeString`, `DepartureTimeString`), not the timestamps beside them.
Those are UTC, and the day itself is stamped at UTC midnight, which in New
York is the evening before. The text is what the page shows, so the text is
what counts. A blank departure is somebody still signed in.

The page asks for 100 rows at a time, and so does this. A page that comes back
full means there may be more, so the next is asked for, until one comes back
short (`PAGE_SIZE`, with `MAX_PAGES` as a backstop that the report mentions if
it is ever hit). A row dated another day is left out and mentioned.

### Matching column A to a sign-in

Names are compared the way the Radius import compares them: case and spacing
ignored, "Last, First" read as "First Last". Radius also keeps notes inside a
name ("Jane Doe (IC)") that column A will not have, so a name with its
brackets taken off is tried **only when nothing matches exactly**; an exact
match always wins.

When a column A name fits two students Radius has signed in, **neither is
chosen**. It is listed as one that could not be told apart.

## The Deck Changelog

One row is one assessment, and it is filled in over days rather than at once.
That is why it is three menu entries rather than one button: **Changelog →
1. Create**, **2. Grade**, **3. Learning plan**. Each stage writes only its own
columns and leaves every other cell exactly as it found it.

Run a stage with rows highlighted to act on just those; run it with nothing
highlighted and it acts on every row that has a student name.

### 1. Create — date it and find the next session

You put the name in **B**. The stage fills **A** with today, then looks the
student up in Google Calendar and fills **C** with the day they are next in
(`M`, `T`, `W`, `Th`, `F`, `S`) and **D** with that date as `m/dd`.

**Next means strictly after today.** An assessment done this morning is
followed up next time they are in, not this afternoon, so today's own session
is never the answer. Of several sessions ahead, the soonest wins.

A row that already has a date in A is left alone. Re-running is for the rows
nobody has got to yet, not a way to re-stamp finished work.

#### Which calendar

**Tools → Calendar: set the calendar** lists the calendars this account can
already see. Tick the ones the sessions are on; tick none to use the account's
own calendar. Each is checked on the spot and named back to you, because a
calendar this account has not been given access to comes back as nothing at
all — indistinguishable from a calendar with no sessions on it, until somebody
is staring at a column of question marks.

The box underneath is for a calendar that is not on the list, and takes
**whatever Google Calendar actually hands you**:

| What you copied | Looks like |
| --- | --- |
| Calendar ID | `c_9a8b@group.calendar.google.com` |
| Secret or public iCal address | `…/calendar/ical/<id>/private-3f2a9/basic.ics` |
| Embed code | `<iframe src="…/embed?src=<id>&ctz=…">` — paste the whole tag |
| Share link | `…/calendar/u/0?cid=<id base64'd>` |

The first version asked for the Calendar ID, which is the one string in those
settings nobody copies first — everything else there is a link. Handing a link
to Google as an id gets back "no such calendar", which reads like a sharing
problem and is not one.

A link that is not a calendar comes back refused and **nothing is saved**,
rather than being passed through and reported as a calendar that does not
exist. That includes a URL with an address buried in its path, which is shaped
exactly like a calendar id.

If the script has never been given calendar permission, the dialog says so and
tells you to run it once more and accept — rather than showing an empty list,
which looks like an account with no calendars.

`CONFIG.CHANGELOG.CALENDAR_IDS` is the same setting in the code, and
`LOOKAHEAD_DAYS` (28) is how far ahead it looks.

#### How a session is matched to a student

The event's **title** and its **guests** are both read, so `Amalie Laz`,
`4:00 Amalie Laz — session` and a session called `Tutoring` with Amalie as a
guest all count. The name is looked for *inside* the text rather than the text
having to equal it, and the matching is the same ranking the seating chart
uses — so shorthand means the same thing in both places.

Two things it will not do:

- **Take a session that merely starts the same way.** `Amalie Bourne` is not
  `Amalie Laz`.
- **Choose between two children behind one shorthand.** A calendar saying
  `Amalie L` is taken when only one person on it could be; when both
  `Amalie Laz` and `Amalie Lee` are there, it refuses.

A calendar that will not hand over its guest list — some do not — still has its
titles read, rather than the whole event being lost.

#### When the calendar does not say

**C gets `?` and D gets `?/?`**, the row is still dated today, and the report
says why: not on the calendar within the lookahead, the calendar could not be
opened, shorthand that could be two people. A question mark says nobody knows
yet. A plausible date nobody checked is the one that gets acted on.

### 2. Grade — the change since last time, and the stars

You put the percentage in **H**. The stage fills **J** with the change and
**I** with the stars.

- **The change** is measured against the last earlier row for *the same student
  and the same assessment* — a Checkup 6 against a Checkup 6, never against a
  Checkup 7. If there is no such row, J says `NA` rather than sitting empty,
  because an empty cell would have to stand for both "no previous sitting" and
  "nobody has got to this yet".
- **The stars** are half the questions answered right. On a first sitting that
  comes off the whole grade. **On a repeat it comes off the change**, so a
  student who sat the same assessment twice is not paid twice for the ground
  they already had. A score that went down produces negative stars, written as
  calculated rather than rounded up to nothing.
- **A drop in grade is shown as a drop.** The report says so too.

Two things it will not do:

- **Guess a question count.** Nothing on the DWP page says how many questions
  an assessment carries, so it is listed in
  `CONFIG.CHANGELOG.QUESTION_COUNTS`. An assessment missing from that list has
  its change written as usual and its **stars left blank**, and the report names
  the assessment so you know which line to add.
- **Overwrite work somebody marked done.** Anything in **L** means the row is
  finished by hand; grading skips it. Clear that cell to ask for a re-grade.

The comparison assumes the sheet runs down the page in date order, because that
is how it is written. If the row it compared against is dated *later* than the
row being graded, the change is still worked out but the report says the rows
look out of order — a wrong answer that announces itself beats a wrong answer
that does not.

### 3. Learning plan — date it and count it

Fills **O** with today and **S** with how many learning plans that student has
had, counted from the rows above rather than asked for again. A row that
already has a date in O is left alone.

**R (the workout book) and T (what's next) stay empty**, and the report asks
for R by name. Nothing the script can read says which book went into a plan or
what should come next; those are judgements, and inventing a plausible one is
worse than leaving the cell blank.

### Who fills what

| # | Column | Filled by |
| --- | --- | --- |
| 1 | Date assessment done | **stage 1** |
| 2 | Student | a person |
| 3–4 | Day of week · Next attendance date | **stage 1** |
| 5–8 | Most recent assessment · Date graded · Initials · Grade % | a person |
| 9–10 | Stars · Change if previously done | **stage 2** |
| 11–12 | Good/bad/fine · Done | a person |
| 13 | Progress report submitted | left blank |
| 14 | Progress report initials | a person |
| 15 | LP creation date | **stage 3** |
| 16 | LP created by | a person |
| 17 | *(spacer)* | — |
| 18 | Topic repeated | a person |
| 19 | How many LPs made | **stage 3** |
| 20 | What's next | a person |

**Eleven of the twenty are somebody's judgement written down**, initials
included, and no stage touches one of them. That is not a promise in prose: a
test runs all three stages over a row and asserts the columns that changed are
exactly the ones `CONFIG` marks as the script's. A stage that later starts
writing an initials column fails that test rather than quietly taking the
column over.

### Still open

Columns 1, 3, 4 and 5 were once expected to come from Radius. Column 1 is
today's date, and 3 and 4 now come from Google Calendar, so none of those needs
Radius at all. Column 5 is still typed by a person, and would need something I
have not seen:

- **Most recent assessment** — the DWP page has an assessment status behind
  `AssessmentStatusId`, but nothing naming or dating one. A page for a student
  who has just had an assessment graded would settle it.

## Writing a progress report

**Changelog → Draft a progress report.** Highlight the student's name, run it,
and a draft appears on screen ready to copy out. It **writes nothing to any
sheet** — the drafting is the whole job.

Highlight from wherever you happen to be. The name is looked for in whichever
column that sheet keeps it in: column A on the Daily WOP (the time in front of
it is stripped), column A on the Deck List, column B on the changelog. One
student highlighted on two hourly rows is one report, not two. Highlight
several names and you get several drafts in the one box, separated.

A report wants two lists of four, and they come from different places.

### Working on next — real today

The deck queue **is** the list of what they are about to work on, so this half
needs nothing new: column B (what they are on now), then E (printed and
waiting), then F (queued behind that), in the order the student will meet them.
`CONFIG.PROGRESS.UPCOMING_COLUMNS` is that list if it ever needs changing.

A task sitting in both B and E is **one** topic the student will work on, not
two, and is listed once.

### Mastered at 100% — needs a page I have not seen

This is the per-topic breakdown of an assessment, and it lives on a Radius page
nobody has sent me yet. Two things are missing, both named in the code:

1. **Which page it is.** `CONFIG.PROGRESS.ASSESSMENT_URL`, empty for now, with
   `{{studentId}}` and `{{centerId}}` standing in for the ids.
2. **How to read it.** `PROGRESS_EXTRACTORS.masteredTopics` in `Progress.gs`,
   deliberately kept apart from everything around it so that it is the only
   function that has to be written when a copy of the page turns up. It returns
   a list of `{ name, percent }`, one per topic, or throws saying what it could
   not find.

**Send me an assessment page for a student who has just been graded** and this
becomes a few lines. Everything either side of it — finding the student, the
roster lookup, the fetch, the 100% filter, the draft — is written and tested
already.

Until then it **does not fall back to the deck history**. A task the student
finished is not a topic they scored full marks on, and a progress report that
quietly says otherwise is worse than one with a hole in it.

### A list that comes up short

Whichever half falls short, the shortfall goes **into the draft text itself**:

```
Mastered — scored full marks on:
  - [4 more mastered topic(s) — add by hand]

Working on next:
  - Fractions 3
  - Fractions 4
  - [2 more upcoming topic(s) — add by hand]
```

The report also says how short and why — no deck row, nothing in the queue, the
assessment page not mapped. But the marker in the text is the part that
matters: a draft three topics deep where four were asked for must not be
possible to paste out without somebody seeing the gap. **This is the whole
reason the mastered half is present-and-marked rather than left out.**

`CONFIG.PROGRESS` holds the wording — the template, the bullet, the marker, how
many topics of each kind, and what counts as mastered. Change the shape of the
draft there rather than in the code.

## The day log

The Daily WOP is one long log. Each day opens with a row reading
`9/17/2026 Thursday` in column A, and that day's students are written under it.
After a year that is a thousand rows, and finding today means scrolling.

**SOD → Jump to today** puts the cursor on today's row. **SOD → Start a new
day** adds today's row at the bottom and takes you to it. Neither touches a
student's data, and both work from any tab — they switch you over.

A header is read by **parsing the date out of it**, not by matching the text,
so `9/17/2026` and `09/17/2026` are the same day and the day name on the end is
decoration. A date that does not exist (`2/31/2026`) is a typo, not a day —
taking it for the last of February would put the cursor on the wrong row and
say nothing.

**Jump to today says nothing when it works.** The cursor moving is the answer,
and a dialog every time is one more click on a thing meant to save clicks. It
speaks only when today is not there yet, or when the day has been **opened
twice** — two headers means the day's students are split between two blocks and
nothing downstream would notice, so it names both rows.

**Start a new day refuses twice**, both times because a log that is out of
order or opened twice is quietly wrong:

- **A day already open** gets no second row. You are taken to the existing one.
- **A day further ahead already started** — somebody made tomorrow's block —
  means where today belongs is a judgement. It says which row is ahead and
  changes nothing.

The new row takes the **formatting of the day before**, so it is not the one
row on the sheet that is a different colour. On a sheet with no earlier day it
is written plain and says so.

## Laying the day out from the calendar

**SOD → Paste the calendar — today / tomorrow / pick a day.** Click the cell
the day should start in, run one of them, and the whole block is built from the
top down:

```
8:45am - 1:15pm IC (Amanda)  AL         the shifts, as they stand
9 - 11am IC (Bo)  BK
12 - 12:30pm Fire drill                 anything else, as it stands
@HOME                                   the section header
10:00 Bubba Blue                        ...its students
In-Center | Issue | … | IAAT | Hist     the section header
9:00 Student One      8:45am - 1:15pm IC (Amanda)  AL
9:00 Student Two      9 - 11am IC (Bo)  BK
11:00 Student Three   8:45am - 1:15pm IC (Amanda)  AL
```

### Each hour in grade order

The column A colours come from a **conditional formatting rule** on each
student's grade, and a script cannot see conditional formatting — it only ever
gets the plain cell. So rather than read the colour, it reads the **grade the
colour is worked out from**, and puts each hour in grade order. Students the
colours group together end up sitting together, from the moment the day is
pasted, before anybody has styled anything.

Point `CONFIG.SCHEDULE.GRADES` at the tab: `SHEET_NAME`, and which columns hold
the name and the grade. Left blank, nothing changes and each hour stays in the
order the calendar gave.

- **Hours stay in time order**; grade only decides the order *within* an hour.
  Youngest first, unless `YOUNGEST_FIRST` says otherwise. A tie goes by name,
  so it comes out the same every time.
- **Names are matched the way the seating chart matches them**, so the
  calendar's `Amalie Laz` finds `Amalie Lazeration` on the tab — and shorthand
  that could be two children is not settled by guessing.
- **Grades are read as** `K`, `Pre-K`, `5`, `5th`, `Grade 5`, `G5`. Anything
  else — `Algebra 1`, `HS` — is not guessed at: a course name with a number in
  it is not a grade, and sorting it as one would seat a high-schooler with the
  first-graders.
- **A student whose grade cannot be found or read goes to the end of their
  hour** and is named in the report, along with the value it could not read. A
  guessed grade is how somebody ends up with the wrong instructor, which is the
  thing the colours are there to stop.
- **The seating chart's S and T get the same order.**
- A tab that is not there does not stop the paste: the day goes in, in
  calendar order, and the report names the tab it looked for.

### One hour, one shade

Each hour of students takes the next colour from
`CONFIG.SCHEDULE.HOUR_SHADES`, so an hour reads as a block rather than a run of
rows. **@HOME and In-Center each start again at the first**, since they are
read as two lists rather than one.

Only a student's own row is painted. A row can be empty and still be
formatted — a day log has its banding laid down ahead of the work — so the
shifts, the leftovers and the section headers keep whatever colour they were
given.

### The section headers keep the day before's look

`@HOME` and `In-Center` are more than their words — they are bold, they are
coloured, they have links in them. So rather than typing the word and losing
all of that, **the nearest earlier day's row is copied whole**. That is also
the only way the links come along, since nothing here knows what they point at.

The nearest one, not the first: yesterday's styling, not a fortnight ago's.

With no earlier day there is nothing to copy, so the words are typed out plain
and the report says the styling is yours to do once — the next day will match
it. A copied header needs its **whole row** clear, not just column A, and
brings its own cells with it, so the columns only it would have needed are
never written at all.

### The In-Center list goes over to the seating chart

The In-Center students are also written to the **seating chart**, split in two:
the time into **column S**, the name into **column T**, one to a row. That is
the list the chart gets filled in against.

**The name is shortened on the way** — `Amalie Laz` goes over as `Amalie L`.
First name whole, last name down to its letter. A middle name is kept, since it
may be the only thing telling two children apart, and a one-word name has
nothing to shorten. The Daily WOP itself keeps the name in full; only the chart
is shortened.

**Only In-Center.** The chart is the room, and a student at home is not in it.
Which sections go is `roster` in `CONFIG.SCHEDULE.SECTIONS`.

**Which tab is the day's**, the same way reading the chart is — `Saturdays` on
a Saturday, `Weekdays` otherwise.

Both columns are **cleared first, the whole way down**, not just as far as
today's list reaches. Yesterday was a longer day often enough, and the names
left below would read as though those students were coming. If nobody is in
centre, the columns are cleared and left empty, and the report says so rather
than leaving yesterday showing.

Two things the report tells you:

- **The chart could not be opened.** The day still went into the sheet — that
  part is done and is not lost — and the failure is named.
- **The chart now holds a day that is not today.** Thursday and Friday share a
  chart, so setting Friday up on Thursday evening takes Thursday's list off
  it. Fine once everyone has gone home, not while the room is still full — so
  it says which day is on there now, and running the today button puts it back.

### The columns beside a student

Each student row also gets the sheet's own lookups — **column C** the link,
**column D** the Deck List summary — written as formulas pointing at that row.
They live in `CONFIG.SCHEDULE.FORMULAS`, with `{{row}}` standing in for the row
they land on, so changing one is an edit in a known place rather than a hunt.

Then, **once those have settled**, what column D worked out is copied into
**column I as plain text**. The text, not the formula: column I is a record of
what the lookup said on the day, and a second copy of the formula would quietly
change every time the Deck List did. The copy waits on a flush, because reading
straight after writing gets you the old value or nothing at all.

Only **student rows** get any of this — a section header or a shift line is not
a student. And a result that happens to start with `=` is written as text
rather than becoming a formula of its own.

### Three kinds of calendar item

| Kind | How it is told apart | Where it goes |
| --- | --- | --- |
| **A session** | its title has a bracket: `Amalie Laz - (IN-CENTER) 1 hour session - Appointy` | `9:00 Amalie Laz`, under the section the bracket names |
| **A shift** | it is on the **Instructor Availability** calendar, **or** its line reads like one: `IC (Amanda)  AL`, `@H (Bo)  BK` | the top of the block, as it stands — and beside each hour it covers |
| **A notice** | `AHOD` in its title **or** its description (`CONFIG.SCHEDULE.NOTICE_MARKER`) | directly under the instructors, in bold |
| **Anything else** | everything left | under the notices, as it stands |

**All the instructors end up together**, whichever calendar they came from.
Two ways of knowing one, because either alone lets somebody slip through:

- it is on a calendar in `CONFIG.SCHEDULE.SHIFT_CALENDARS` (**Instructor
  Availability**), so a shift titled any old way still lands right; **or**
- its line reads the way an instructor's line reads — a marker from
  `CONFIG.SCHEDULE.SHIFT_MARKERS` (`IC`, `@H`), then the name and initials — so
  a shift put on the wrong calendar lands right too.

The marker has to be a word of its own: `ICU open day` is not a shift.

**`CONFIG.SCHEDULE.SHIFT_EXCLUDE` names instructors who are never listed** —
Ashley and Trevor. They are on the availability calendar for reasons of their
own and are not who anybody is looking for when they read the hour. They are
left off the group **and** off the hours beside the students, not quietly moved
into the leftovers, and the report says they were left off on purpose so it
does not read as something having gone missing.

A **notice** — anything with `AHOD` in it — is pulled up to sit directly under
the instructors and set in **bold**, rather than sitting somewhere in the
middle of the leftovers where nobody reads it. It is looked for in the title
*and* the description, because whoever writes one puts it wherever it reads
best. It is hoisted out even when it is on the instructors' own calendar —
*under* them is where it was asked for.

**A booking is a booking first.** A word in the body of a session does not take
a student off the list they are expected on.

Everything that is neither a shift, a notice nor a session follows underneath
in calendar order, still ahead of the two student sections.

### Reading a booking title

`Amalie Laz - (IN-CENTER) 1 hour session - Appointy : Updated` is a name, a
bracket saying where they are, and then the booking system talking to itself.
Only the first two are kept. `CONFIG.SCHEDULE.SECTIONS` says what a bracket has
to contain for each section — `@HOME` or `VIRTUAL` for the first, `IN-CENTER`
for the second.

**A bracket nobody has taught it about is not filed by guess.** The item is
pasted as it stands with the rest, and the report names it, so nothing is lost
and nothing is put in a section it may not belong to.

### The instructors beside each hour

At the row an hour opens on, the shifts covering that hour are listed down
column G, one to a row. **A shift that ends on the hour is not working it** —
nine to eleven covers the nine and the ten, and the eleven belongs to whoever
comes next.

### Times, written the way a calendar writes them

Because these lines go in as they stand and are read by somebody used to seeing
them that way: whole hours drop their minutes, and a range inside one half of
the day says `am` or `pm` once at the end.

```
8:45 → 13:15    8:45am - 1:15pm
9:00 → 13:00    9am - 1pm
9:00 → 11:00    9 - 11am
18:00 → 19:00   6 - 7pm
```

### The rest of it

**Tomorrow means the next day the centre opens.** On a Saturday that is Monday,
because a Sunday nobody works would paste a page of nothing.
`CONFIG.SCHEDULE.CLOSED_DAYS` is which days those are.

**Which day is whichever entry you ran** — today, tomorrow, or one you type
(`9/18/2026`, or `9/18` for this year; a date that does not exist is a typo and
is refused). The report names the day it used.

The dated row above the cursor is still read, but only to **say so when the two
disagree**. Setting tomorrow up under today's heading is the ordinary thing to
be doing the evening before; pasting today under last Tuesday's is not, and it
gets a word in the report rather than a refusal — it is one Ctrl+Z either way. The same booking reached through two calendars is one item; a
student in **twice in a day** is two. **Nothing is ever written over** — one
occupied cell stops the whole paste and is named along with what is in it.

## Start of day: organising the rows

> **Parked.** The menu entry is commented out in `Menu.gs`. The code and its
> tests are untouched — putting that one line back turns it on again. The
> test that catches orphaned functions knows it is parked on purpose, and
> still catches anything underneath it that falls out of use.

**SOD → Organise rows from the seating chart** rewrites columns **A and B** of
the Daily WOP into the order the room is actually arranged in:

```
A                        B        (B shaded per pod, initials alternating colour)
12:00 Student 1          AA/BB
12:00 Student 2          AA/BB
...
12:00 Student 7          CC/DD
...
1:00 Student 3           AA/FF     (column A shaded on alternate hours)
```

- **Hours** run in the order the day does. An hour of 7 or less is read as an
  afternoon one, so `4:00` sorts after `12:00` rather than eight hours before
  `9:00` (`CONFIG.SEATING.AFTERNOON_AT_OR_BELOW`).
- **Pods** run 1 to 4. A pod is a pair of tables — 1 and 2, 3 and 4, and so on,
  set by `CONFIG.SEATING.PODS`. Empty pods are simply absent.
- **Students** run alphabetically within their pod.
- **Column B** holds the pod's instructors, joined: `AA/BB`. Its fill says which
  pod, and the initials alternate colour so neighbouring pods stay apart.
- **Column A** is shaded on alternate hours, so each hour reads as a block.

Names keep the spelling the Daily WOP already uses, not the shorthand the chart
was filled in with — the chart's `Student  7` becomes the sheet's `Student 7`.
A chart name with nobody to match is still placed, spelled as the chart spells
it, and named in the report rather than dropped.

### A chart that seats somebody twice in one hour

Nobody sits in two seats at once, so the student is listed **once**, at the
first of the two seats, and both are named in the report. Left as two rows it
would put a phantom session on the sheet — and the Radius import would then
find two rows at the same hour with one session between them and be unable to
say which it belonged to, so a slip on the chart would cost the import too.

The same student at two *different* hours is ordinary and stays two rows.

An hour block with no time beside it keeps its students, sorted after the hours
that do have one, and the missing label is reported rather than left to be
noticed.

### A student the chart never mentions

The list is rebuilt from the chart, so a Daily WOP name that no chart entry
claims would otherwise be deleted by the rebuild — and the one student nobody
remembered to seat is exactly the one that must not vanish. They are kept,
listed at the end with no hour and no pod, their row marked yellow, and named
in the report.

### It organises today's block, not the whole sheet

On a sheet that keeps a day per block, only **today's** block is organised —
from the row under today's header down to the row before the next day opens.
Read from row one it would shuffle every student who has ever been in, which
the pinned-data guard below would refuse, so the organiser simply would not
run. A sheet with **no** day headers is not a log, and is organised from
`CONFIG.SEATING.ORGANIZE_START_ROW` as before.

Two consequences worth knowing:

- **Today not opened yet → it refuses.** Organising would write today's
  students into yesterday's block. It says to use **Start a new day** first.
- **A day already started below today's → it will not write past the end of
  today's block.** The list is as long as the chart makes it, and writing past
  the end would overwrite tomorrow's students with today's. It stops, says how
  many rows it needs and where to insert them, and changes nothing. Where today
  is the last block there is nothing below to overwrite, and it simply grows.

Yesterday's filled-in columns are history, not this morning's pinned data, so
they do not block today.

### It refuses to run mid-day

Session data is tied to its row by position alone. Reordering column A
underneath it would hand one student's pages and times to another, silently and
irreversibly. So if anything at all sits to the right of column B, the organiser
stops and names the cell that stopped it. Column B itself is its own, so
yesterday's instructors are no reason to halt.

### Special spellings

`CONFIG.SEATING.ALIASES` maps what is written on the chart to the Daily WOP's
spelling, for the cases a first name and an initial cannot settle:

```js
ALIASES: {
  'Amalie L2': 'Amalie Lazeration',
  'Alex the younger': 'Alexander Roe'
}
```

A name written out in full always beats one that merely starts the same way, so
`Student 11` is not read as an abbreviation of `Student 1` while a Student 11 is
sitting right there. Only when nothing matches exactly does the abbreviation
rule get a say — and two candidates at that point is reported as an ambiguity
rather than guessed between. The same list is used by the EOD seating import.

## The seating chart

**EOD → Seating chart for highlighted rows** records where each highlighted
student sat, and who sat with them, in **column N**:

```
SEAT | who was at the table | who covered the hour

1C | IN3 IN2 | AL        IN3 and IN2 at the table, AL over the whole hour
1C | IN3 IN2             nobody covering that hour
1C | - | AL              nobody at the table, AL covering the hour
1C                       neither
1C, 3A | IN3 IN1 | AL    moved between hours
```

The two sets of instructors answer different questions — who sat with this
student, and who was covering the hour around them — so they get **a slot
each**. Run together into one list, somebody floating is indistinguishable from
somebody who was there the whole time.

The middle slot is kept as `-` when nobody was at the table, or the one name
left would read as having sat there. `CONFIG.SEATING.NO_INSTRUCTOR` is that
dash.

The chart is a grid of tables drawn one block per hour: a row of table numbers,
then the seat rows, with an instructor column between each pair of tables. The
pairs are the pods — `(8|Wall|7) (6|Wall|5) (4|Wall|3) (2|Wall|1)` — laid out
right to left, so pod 1 is the pair nearest the right of the sheet.

### Where the chart lives

**Tools → Seating chart: set the link.** Paste the Google Sheet's address (a
bare id works too) and it is stored in Script Properties, so the link is not
written into the code. It checks the link **there and then** and says which
tabs it can actually see — a link to the wrong document, or to one this account
cannot open, looks identical to a right one until six o'clock in the evening.
The account running the script has to be able to open that document, which
means sharing it with the same Google account you are signed in as.

`CONFIG.SEATING.SPREADSHEET_ID` is the fallback when nothing has been pasted,
and blank means "a tab in this same spreadsheet".

### Which tab: Weekdays or Saturdays

`CONFIG.SEATING.DAY_SHEETS` maps the day of the week to a tab — `Weekdays`
Monday to Friday, `Saturdays` on Saturday — and the two charts are the same
layout with different hours. The names must match the tabs exactly, capitals
included. **Sunday names no tab**, and
that is an answer rather than a gap: reading Saturday's chart on a Sunday would
seat everybody where they sat yesterday.

### How a seat is worked out

**A seat is never read from the cell it is in**, because a student's name is
written *over* the printed label. The table number comes from the header row;
the row letter is looked for in three places, in this order, because charts in
the wild carry different amounts of help:

1. **A seat still showing its label.** `1C` in the cell names its row outright,
   and one such seat names the row for every table beside it.
2. **Single-letter markers down the side**, which the older chart had.
3. **Position in the block**, against `CONFIG.SEATING.SEAT_ROW_ORDER` — `C`,
   `B`, `A` top to bottom.

Only the third is an assumption, so each seat records which of the three named
it. **The real chart uses the third**: it has no labels and no markers. If the
rows run the other way, `SEAT_ROW_ORDER` is the one line to flip — everything
else follows from it.

**By position means the rows directly under the header, and only those.** Each
block on the real chart ends in a row of its own workings — the hour repeated
in the wall columns (`=$A15`), `=TODAY()` in the table columns — and the sheet
carries on below the last block. None of that is a seat. An earlier version
took "the first three rows with anything in them" instead, which in an empty
block is the workings row: its dates came out as students and its hour as an
instructor (`6C | AL DY 6:00`), and under the last block every code below the
chart joined the list. It also dropped an instructor written beside a row
nobody was sitting in. Where the seats are is fixed by the layout; what happens
to be written near them is not.

A cell still showing its own label is an **empty seat**, not a student.

### One room, drawn four times

The room does not move between four o'clock and seven, so every header row is
the same layout drawn again — and the real chart's later headers have *lost*
the middle pod, leaving columns for tables 4 and 3 blank. Read block by block,
every student at those two tables vanishes.

So the column-to-table map is built from **every header row together**: one
complete drawing anywhere on the sheet names the columns for all of them. Two
headers naming the same column differently is the room having actually moved,
and that is **reported rather than resolved** — the last drawing is not
obviously more right than the first. A column no header ever names seats
nobody, rather than putting somebody at a guessed table.

### Instructors belong to the pod, not the row

The names down a wall column are the instructors who worked that **pod** that
**hour**, listed one to a line because there may be several of them — not one
per seat row beside them. On the real chart the two instructors of a pod sit
one line above and one line below the middle seat row, so reading them row by
row left the student in the middle with nobody at all while two people were
plainly there.

So every student in a pod gets every instructor of that pod for that hour:

```
4C | AZ HR        Neil D, table 4 seat C, with both
3B | AZ HR        Luca B, the other table of the same pod
```

The format says the same thing — `1C | IN1 IN2 IN3` is a list. A student who
sat in two pods across the day gets both sets, and somebody who worked both is
named once.

### Whoever covered a whole hour

Off to the side of the chart sit little tables, two abreast, splitting the
day's hours:

```
H:00 | CAT        H:00 | CAT
4:00 | AL         6:00 | AL
5:00 | AL         7:00 | AL
```

Whoever is written beside an hour there worked that **whole hour, across every
pod**, so their initials go to every student in it, in the third slot:

```
4C | AZ HR | AL     Neil D: AZ and HR at his table, AL over the hour
```

**Somebody in both is written in both** — `4C | AZ HR | HR` means HR sat at the
table *and* covered the hour, and dropping either would drop something that
happened.

**Found by the `H:00` heading, not by where the table sits.** It is a loose
table somebody may move, and a fixed cell reference would go on reading
whatever ended up there.

A column belongs to the table when it has a **heading of its own**, and the
table ends where the next `H:00` begins. Emptiness cannot mark the edge: the
initials live in a cell merged across two columns, which reads as the value and
then a blank — so a blank column is as likely to be the right half of a merge
as the gap between two tables. Going by headings also means a second column of
initials beside the first is picked up, while a stray note out to the right of
everything is not.

An hour with nobody beside it gets nobody, rather than reaching down the column
for the next hour's name. A blank row ends the table. The hour is read with the
same afternoon rule the chart uses, so `4:00` here is the `4:00` the blocks
mean.

`CONFIG.SEATING.HOUR_TABLE_HEADER` is the heading it looks for.

**This is column N only.** The start-of-day organiser's column B stays the
pod's own instructors — an hour-wide name on every pod would say nothing about
who sat where.

### A student who came twice

The SOD organiser heads each row with an hour and gives a student who attended
twice two rows. The import matches a row to **that hour's** seat:

```
12:00 Amalie Laz   →   N = 1C | AA
1:00 Amalie Laz    →   N = 3A | DD
```

A row with no hour on it still collects every seat of the day
(`1C, 3A | AA DD`). A row headed at an hour the student was not there gets
nothing, and the report names the hour it looked for.

### Names on the chart

The chart is filled in by hand and in a hurry, so surnames get cut short.
`Amalie L` matches `Amalie Laz`; `Amalie Roe` does not. A first name on its own
matches too.

If one chart entry could be **two** of the highlighted students — `Amalie L`
with both an Amalie Laz and an Amalie Lee selected — nothing is written for
either, and the report names both. Writing the surname out on the chart settles
it.

A student already holding a different seating in column N has it replaced, and
the replacement is named in the report. One already correct is left alone.

### What is extracted, and where it lands

| Column | Field | Written as |
| --- | --- | --- |
| F | Problem of the Week | `Y`, or blank |
| G | Mastery / assessment | `PK3918(100), PK3902(0), Pre completed` |
| H | Pages completed | the number |
| J | Finalized | `Y`; `N` once the session is over and it still is not |
| K | Deck update | **parked** — see below |
| L | Signed in | `10:48 AM`, or blank |
| M | Signed out | `11:48 AM`, or blank |
| O | Session summary | `ALB: ` then the note text |
| P | Internal notes | `ALB: ` then the note text, plus timing notes, plus `MLS (3)` |

**Column K is parked.** Radius's "Needs deck update" switch reads correctly,
but instructors do not set it in Radius reliably yet — and column K is what EOD
advances the Deck List from, so a `Y` there on the strength of an unset switch
would move a student on for no reason. The import leaves K exactly as it finds
it. The entry is commented out in `CONFIG.RADIUS.FIELDS`, and uncommenting its
two lines turns it back on: it then writes a `Y` folded into whatever the cell
already holds. The code behind it is still tested, so that works when you do.

Yes/no answers write a bare **`Y`**, matching how the sheet is filled in by
hand; a No writes nothing rather than the word "No". Times are plain times,
blank until they happen. Rearranging is a `column:` change in
`CONFIG.RADIUS.FIELDS`.

**Column J is the exception to the blank-for-no rule.** Once a student has both
signed in and signed out the session is over, so a DWP that still is not
finalized gets an `N`. Blank there would read exactly like a session still in
progress, which is the one thing it is not. A student still in the centre —
signed in, no sign-out — leaves the column alone.

The two free-text columns, **O and P**, are stamped with `ALB: ` so anyone
reading them can see at a glance what they did not type. Only those two: the
rest hold single values nobody wonders about the origin of. A cell the import
leaves empty is never stamped, and re-importing does not stack the mark.

An empty field returns empty — that is a real answer. A **missing** element
throws instead, because it means the page changed shape, and a wrong value is
worse than a loud failure.

### Only today's session

The roster lists a student's **most recent** session, not today's — so on a
quiet day a link on today's roster opens last week's page, and importing it
writes a session the student never had. Every DWP page states the day it
belongs to, from the moment it opens, so that is checked against the day the
script is run (in the spreadsheet's own timezone, not the server's).

A page from another day is refused per student, with the date it actually
found:

> *their most recent session is 8/15/2026, not today. They have not checked in
> yet, so nothing was written.*

A page that states no date at all is refused too — a date that cannot be read
must not be allowed to pass for today's. Set
`CONFIG.RADIUS.REQUIRE_SESSION_TODAY` to `false` only to backfill a past day,
and put it back afterwards.

### A student who was not in

A row whose student has no session today gets a **`?`** in the sign-in and
sign-out columns, so it reads as asked-and-answered rather than as one nobody
got to. That covers every way of not being here: not on the roster, on it but
never checked in, checked in with no DWP, or a DWP from another day.

The mark only ever fills an **empty** cell, whichever conflict mode is chosen.
A time already sitting in the sign-in column says a person was there to write
it down; appending gave `10:48 AM | ?`, a cell claiming both at once, and
replacing it asserted an absence against somebody better placed to know. The
contradiction is reported instead.

**A failure to find out is kept separate.** A dead cookie, an HTTP 500, a page
that changed shape — those are reported as problems and write nothing at all.
Marking them `?` would put a confident answer in a cell where nobody actually
knows one.

### One student, several rows

The SOD organiser writes a row per student per hour, so the same name twice in
a selection is ordinary. Radius offers only their **most recent** session, so
those rows cannot all receive it — writing it to each would give the noon row
the afternoon's pages, times and notes.

The session goes to the row whose hour sits closest to its sign-in time; the
others are left empty and named in the report. Where the rows carry no hour to
tell them apart, **nothing is written to any of them**, because a guess here
records one hour's work against another.

### A row that already says they are not coming

If any of `CONFIG.RADIUS.SKIP_MARKERS` — `LM cancel`, `no show` — appears
**anywhere in the row**, Radius is not asked about that student at all, and
nothing is written. Somebody has already answered the question; a second answer
would only disagree with the first. Matched without regard to case, and across
the whole row, because whoever takes the call writes it wherever they happen to
be looking.

Both are counted in the report and named in the preview before anything is
written.

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
- signed out **10 or more minutes before the end of the slot** →
  `left 20 minutes early`

The slot ends at the top of the hour the session *began* in. So a student who
signs in at 5:20 and leaves at 6:01 has stayed past the end of their slot and
left early by nothing at all — measuring instead to the hour after the
sign-out would have called that leaving 59 minutes early.

Either earns a note in column P; both earn both. The notes are appended to
whatever internal note Radius already held, separated by `|`:

```
ALB: she doesnt shut up big L | signed in 12 minutes late | left 20 minutes early
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

**Tools → Radius: sign in** stores a cookie copied from a logged-in browser in
Script Properties. It is not in the spreadsheet and is not visible to people
the sheet is shared with, and no password is stored anywhere. The trade-off is
that it expires; when it does, the import says so plainly. **Tools → Radius:
test connection** checks the cookie *and* the roster without touching the
spreadsheet.

#### Getting the cookie

The steps are **in the dialog itself** — that is the moment somebody needs
them, and instructions filed somewhere else are instructions nobody reads.
Repeated here so they exist in both places:

1. In a normal browser tab, sign in to **radius.mathnasium.com** as usual.
2. Press **F12** to open DevTools (or right-click → **Inspect**).
3. Click the **Network** tab. If it is not visible, click the **»** at the end
   of the tab row.
4. With DevTools open, press **F5** to reload. A list of requests fills in.
5. Click the **first row** — it is named after the page you are on.
6. Find **Request Headers**, scroll to the line starting **`Cookie:`**, and
   right-click → **Copy value**.
7. Paste it into the box. A leading `Cookie:`, surrounding quotes, or a paste
   that wrapped over several lines are all tidied up.

In Firefox, or if there is no Network tab: DevTools → **Storage** (Firefox) or
**Application** (Chrome, Edge) → **Cookies** → `https://radius.mathnasium.com`,
and copy **all** of them joined as `name=value; name=value`. Not just the one
that looks important — Radius needs the sign-in cookie and its antiforgery
partner together.

#### The one thing not to do

**Do not use the Console and `document.cookie`.** It is the first thing the
internet suggests for this and it is wrong here: the sign-in cookie is
HttpOnly, so `document.cookie` cannot see it and silently leaves it out. What
you get looks exactly like a cookie string and fails later as a sign-in page,
which is the hardest kind of wrong to diagnose.

So the save step checks for it. If none of the cookies pasted look like a
sign-in cookie, it **still saves** — Radius could rename its cookie and
refusing on a name I happen to know would lock somebody out of a tool that
would have worked — but it says plainly that this is probably a
`document.cookie` paste and points at the Network tab method. The list of
names it recognises is `AUTH_COOKIE_NAMES_` in `Radius.gs`.

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

### One student, several rows

The organiser writes a row per student per hour, so the same name appears in a
selection more than once. Each tool treats that according to what the thing it
reads actually is:

| Tool | Reads | Behaviour |
| --- | --- | --- |
| **SOD** | the pink flag — one fact about the student | **one move**, however many rows |
| **EOD** | column K — one fact about a session | **one advance per row** |
| **Radius import** | the most recent session | goes to the row whose hour it matches |
| **Seating import** | a seat per hour | each row gets its own hour's seat |

SOD used to plan a move per row: it printed the first and then reported that
the pink flag had been *"cleared while the dialog was open"* — true only in the
sense that the script had cleared it a move earlier. A red error every morning
that nobody can act on is how a report stops being read.

### A task listed twice in the queue

Printing it moves one copy into column E and leaves the other in column F, so
the student works it twice and EOD archives it twice — and neither run looks
wrong from the inside. SOD now says so when it happens. Blank entries in the
queue are dropped without comment; they are not a repeat.

### A column K nobody can read

EOD acts on `Y` and `P`. A cell holding anything else — `YU` for `YY` — is
**not** skipped in silence: the cell is marked, and the report names it. Left
quiet, the summary would say nothing in the selection needed processing, which
whoever typed it would have every reason to believe.

An empty cell is a row with nothing to do and stays quiet. EOD's own notes
(`Y (2 of 3 done, ran out)`, `YYP - B empty?`) are read back normally, as are
lower case and stray spaces.

### A history column that has run out of room

Column M grows by one entry every time a student finishes a task and is never
trimmed, and a Google Sheets cell holds fifty thousand characters. On the day
one reaches that, the write would throw — and a write that throws **partway
through a batch** is the bad case: some columns land and others do not, so the
Deck List ends up half-applied with no record of where it stopped.

So EOD checks the length before it writes. A student whose history is full is
**stopped on their own row**: nothing is applied, column K keeps the whole
instruction (the pink included, since it is part of the same instruction), the
cell is flagged, and the report says which column is full and what to do about
it. Everybody else in the selection is processed normally — one full history
must not cost the rest of the room their run.

`CONFIG.MAX_CELL_CHARS` is the cap, set a little under the real limit to leave
room for the entry being added.

### The order the Deck List is written in

Within one flush, **column M goes down before column B**. The two writes are
separate API calls, so a failure between them is possible, and the order
decides what that failure costs: archive-then-advance can only ever leave a
task recorded but not advanced off — visible, and fixable by re-running.
Advance-then-archive would lose the task from the history with nothing to say
it had ever been there. The natural left-to-right order was the second one.

### Notes

- The roster is fetched once per run, then one page per matched student.
- `CONFIG.RADIUS.CENTER_ID` is your centre number as Radius writes it. A
  virtual centre is prefixed with `v`, and more than one can be listed:
  `'2514,v972'`.
- Nothing is written until every row has been attempted.
- There is a `FETCH_DELAY_MS` pause between fetches. Radius is someone else's
  server.
- Apps Script stops a run at six minutes. A selection longer than that is
  fetched as far as it gets, and **both the preview and the report say so** —
  naming the row it stopped at and how many were never asked about. Without
  that, the report counts what was written, agrees with itself, and leaves the
  rest looking done.


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
