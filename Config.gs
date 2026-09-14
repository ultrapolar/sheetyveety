/**
 * Central configuration.
 *
 * Every sheet name, column position and colour the scripts rely on lives here.
 * If the spreadsheet layout changes, this should be the only file you edit.
 */
const CONFIG = {

  SHEETS: {
    WOP: 'Daily WOP',
    DECK: 'Deck List'
  },

  // Column numbers on the Daily WOP sheet (A = 1).
  WOP_COL: {
    NAME: 1,    // A - "10:30 AM Jane Doe"
    STATUS: 11  // K - "Y", "YY", "YP", ...
  },

  // Column numbers on the Deck List sheet (A = 1).
  DECK_COL: {
    NAME: 1,     // A - student name
    CURRENT: 2,  // B - task the student is working on right now
    PINK: 3,     // C - "pink" flag, set at EOD, consumed at SOD
    LOADED: 5,   // E - tasks printed and ready to hand out
    QUEUE: 6,    // F - upcoming tasks, waiting to be printed
    ARCHIVE: 13  // M - running history of completed tasks
  },

  COLOR: {
    DONE: '#00ff00',    // paperwork finished, row is skipped on future runs
    WARN: '#ffff00',    // needs a human before it can finish
    ERROR: '#ffcccc',   // could not be processed at all
    TIMING: '#ff9900'   // session ran an odd length - see CONFIG.RADIUS.TIMING
  },

  // Backgrounds that count as "already done". Add any other greens your team
  // uses here; anything not listed will be treated as unprocessed and re-run.
  DONE_COLORS: ['#00ff00'],

  PINK_VALUE: 'pink',
  ARCHIVE_SEPARATOR: ' | ',
  DATE_FORMAT: 'MM/dd',

  // How long a pending SOD dialog stays valid, in seconds.
  // The centre runs mornings or afternoons, never small hours, so a bare hour
  // at or below this is read as afternoon: 4:00 comes after 12:00, not eight
  // hours before 9:00, and a row headed "1:00" means the early afternoon.
  AFTERNOON_AT_OR_BELOW: 7,

  CACHE_TTL_SECONDS: 3600,

  // How long to wait for another user's run to finish, in milliseconds.
  LOCK_TIMEOUT_MS: 30000,

  // ------------------------------------------------------------------
  // Radius import (experimental)
  // ------------------------------------------------------------------
  RADIUS: {
    BASE_URL: 'https://radius.mathnasium.com',
    // Your centre number, as Radius writes it. A virtual centre is prefixed
    // with v, and more than one can be listed: '2514,v972'.
    CENTER_ID: '2514',

    // Script Property holding a session cookie copied from a logged-in
    // browser. Set it via Radius -> Set session cookie; never hard-code it
    // here, or it ends up in the repo.
    COOKIE_PROPERTY: 'RADIUS_COOKIE',

    // Where the Instruction Manager gets its student list, and the ids each
    // DWP 2.0 link is built from. This is not the page you visit: that page
    // builds its grid in the browser, so it arrives here with no students on
    // it at all. This endpoint answers with the roster itself.
    ROSTER_URL: 'https://radius.mathnasium.com/AnswerKey/GetStudentDataSource',

    // Any normal Radius page. It is read once per run for the antiforgery
    // token that ASP.NET expects alongside its cookie on a POST.
    TOKEN_PAGE_URL: 'https://radius.mathnasium.com/AnswerKey/AnswerkeyCheckin',

    // Which values to pull out of each DWP page, and which Daily WOP column
    // each one lands in. Add entries here as more values are identified --
    // every one needs a matching extractor in RADIUS_EXTRACTORS.
    FIELDS: [
      { key: 'problemOfTheWeekFlag', column: 6,  label: 'Problem of the Week' }, // F
      { key: 'masteryAndAssessment', column: 7,  label: 'Mastery / assessment' },// G
      { key: 'pagesCompleted',       column: 8,  label: 'Pages completed' },     // H
      { key: 'finalizedFlag',        column: 10, label: 'Finalized' },           // J
      // Column K is the EOD script's Y/P status column, and a deck update is
      // the same thing as a P there. merge: 'statusLetters' folds the P into
      // whatever the cell already holds instead of replacing it, skips rows
      // EOD has already finished, and leaves EOD's markers untouched.
      { key: 'deckNeedsUpdateFlag',  column: 11, label: 'Deck update (Y)',
        merge: 'statusLetters' },                                               // K
      { key: 'signedIn',             column: 12, label: 'Signed in' },           // L
      { key: 'signedOut',            column: 13, label: 'Signed out' },          // M
      { key: 'sessionSummary',       column: 15, label: 'Session summary',
        prefix: true },                                                         // O
      { key: 'internalNotes',        column: 16, label: 'Internal notes',
        prefix: true }                                                          // P
    ],

    // How long a session is expected to run, and what to say when it does not.
    //
    // A session that lands in neither band gets its sign-in and sign-out cells
    // shaded, because the length itself is the thing worth looking at. A short
    // one is examined further: signing in well after the hour starts, or
    // leaving well before it ends, each earn a note.
    TIMING: {
      SINGLE_MIN: 53,
      SINGLE_MAX: 67,
      DOUBLE_MIN: 106,
      DOUBLE_MAX: 134,

      // Minutes past the hour before a sign-in counts as late, and minutes
      // short of the hour before a sign-out counts as early.
      LATE_AFTER: 10,
      EARLY_BEFORE: 10,

      // Field keys this works from and writes to. All four must name real
      // entries in FIELDS above -- a test asserts it, because a typo here
      // fails silently: the review just sees no times and does nothing.
      SIGN_IN_FIELD: 'signedIn',
      SIGN_OUT_FIELD: 'signedOut',
      SHADE_FIELDS: ['signedIn', 'signedOut'],
      NOTE_FIELD: 'internalNotes'
    },

    // What EOD does when a cell already holds something. It runs without a
    // dialog, so it defaults to the harmless option: fill the empties, leave
    // everything else be. 'append' or 'overwrite' if you would rather.
    // Stamped on the front of every field marked prefix above, so a person
    // reading those columns can tell at a glance what they did not type.
    BOT_PREFIX: 'ALB: ',

    // A session with both times filled in is finished. If its DWP was never
    // finalised, say so rather than leaving the column looking untouched.
    // The roster hands back a student's most recent session whether or not it
    // is today's, so the page is asked what day it belongs to and a row from
    // another day is refused. Turn this off only to backfill a past day, and
    // remember to turn it back on.
    REQUIRE_SESSION_TODAY: true,

    // Written into the sign-in and sign-out columns for a student who has no
    // session today, so the row reads as asked-and-answered rather than as one
    // nobody got to.
    ABSENT_MARK: '?',

    // If any of these appears anywhere in a row, the student is known not to be
    // coming and Radius is not asked about them at all. Matched without regard
    // to case, anywhere in the row, because whoever takes the call writes it
    // wherever they happen to be looking.
    SKIP_MARKERS: ['LM cancel', 'no show'],

    UNFINALIZED_FIELD: 'finalizedFlag',
    UNFINALIZED_VALUE: 'N',

    // Pause between page fetches, in milliseconds. Radius is someone else's
    // server; there is no reason to hammer it.
    FETCH_DELAY_MS: 300,

    // Stop and report rather than being killed by the 6-minute ceiling.
    MAX_RUNTIME_MS: 4.5 * 60 * 1000
  },

  // The seating chart: a grid of tables drawn one block per hour, with the
  // students written into the seat cells by hand.
  SEATING: {
    // Blank means a tab in this same spreadsheet. To read a separate document,
    // paste the id out of its URL: .../spreadsheets/d/<this part>/edit
    SPREADSHEET_ID: '',
    SHEET_NAME: 'Seating Chart',

    // Where the result lands on the Daily WOP.
    TARGET_COLUMN: 14,   // N

    // "1C | IN3", or "1C, 2A | IN3 IN1" for a student who moved during the day.
    SEPARATOR: ' | ',
    SEAT_JOIN: ', ',
    INSTRUCTOR_JOIN: ' ',

    // Shorthand written on the chart that cannot be worked out from the Daily
    // WOP name on its own -- two students who share a first name and an
    // initial, a nickname, a spelling nobody agrees on. Chart side on the
    // left, exactly as it is written there; the Daily WOP's spelling on the
    // right. Used by the seating import and the SOD organiser alike.
    ALIASES: {
      // 'Amalie L2': 'Amalie Lazeration',
      // 'Alex the younger': 'Alexander Roe'
    },

    // --- the start-of-day organiser ---------------------------------------

    // Which tables make up each pod. Pods are listed in this order.
    PODS: [[1, 2], [3, 4], [5, 6], [7, 8]],

    // One background per pod, so a glance says who is sitting together.
    POD_FILLS: ['#efefef', '#cfe2f3', '#9fc5e8', '#6d9eeb'],

    // The initials alternate colour so neighbouring pods stay apart.
    POD_FONTS: ['#0000ff', '#ff0000'],

    // Alternating hours get a shaded name cell, so each hour reads as a block.
    HOUR_SHADES: ['#ffffff', '#d9d9d9'],

    // Between the instructors of one pod: "AA/BB".
    INSTRUCTOR_SEPARATOR: '/',

    // Where the organised list starts, and where the instructors go.
    ORGANIZE_START_ROW: 1,
    INSTRUCTOR_COLUMN: 2,   // B

  }
};
