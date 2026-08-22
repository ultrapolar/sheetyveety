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
    ARCHIVE: 14  // N - running history of completed tasks
  },

  COLOR: {
    DONE: '#00ff00',    // paperwork finished, row is skipped on future runs
    WARN: '#ffff00',    // needs a human before it can finish
    ERROR: '#ffcccc'    // could not be processed at all
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
  LOCK_TIMEOUT_MS: 30000
};
