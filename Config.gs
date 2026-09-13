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
      { key: 'sessionSummary',       column: 15, label: 'Session summary' },     // O
      { key: 'internalNotes',        column: 16, label: 'Internal notes' }       // P
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
    EOD_CONFLICT_MODE: 'skip',

    // Run the import automatically as the first step of the EOD batch, so the
    // instruction it writes into column K is in place before EOD reads it.
    // Set false to keep the import to its own menu item.
    RUN_ON_EOD: true,

    // Pause between page fetches, in milliseconds. Radius is someone else's
    // server; there is no reason to hammer it.
    FETCH_DELAY_MS: 300,

    // Stop and report rather than being killed by the 6-minute ceiling.
    MAX_RUNTIME_MS: 4.5 * 60 * 1000
  }
};
