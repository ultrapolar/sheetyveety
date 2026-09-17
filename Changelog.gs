/**
 * The Deck Changelog, in three stages.
 *
 * One row is one assessment, and it is filled in over days rather than at
 * once: created when the assessment is set, graded when it comes back, and
 * finished when the learning plan is made. Each stage is its own menu entry,
 * writes only its own columns, and leaves the rest alone.
 *
 * The stages read what the people before them wrote, so nothing here invents a
 * value it was not given. Where an input genuinely is not available -- the
 * question count for an assessment, what a learning plan contains -- the cell
 * is left for a person and the report says which, rather than filled with
 * something plausible.
 */

/** The changelog sheet, wherever it has been put. */
function changelogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.CHANGELOG.SHEET_NAME);
  if (!sheet) {
    throw new Error('No sheet named "' + CONFIG.CHANGELOG.SHEET_NAME + '". ' +
      'Create it, or set CONFIG.CHANGELOG.SHEET_NAME to whatever it is called.');
  }
  return sheet;
}

/**
 * A percentage as a number out of a hundred.
 *
 * Sheets stores 85% as 0.85 but a typed "85" stays 85, and both turn up in the
 * same column. Anything at or below 1 is read as a fraction -- a real grade of
 * one percent does not happen, and reading 0.85 as under a percent would.
 */
function percentValue_(raw) {
  const text = String(raw == null ? '' : raw).trim().replace(/%$/, '').trim();
  if (!text) return null;
  const value = Number(text);
  if (isNaN(value)) return null;
  return value <= 1 && value >= 0 ? value * 100 : value;
}

/** Stars are half the questions answered right, so halves are the real unit. */
function starsFor_(percent, questions) {
  if (percent === null || !questions) return null;
  return Math.round((percent / 100) * questions / 2 * 2) / 2;
}

/**
 * The calendars to look in, in order.
 *
 * Nothing set means the account's own calendar. Ids pasted in through
 * Tools -> Calendar: set the calendar win over CONFIG.CHANGELOG.CALENDAR_IDS,
 * so the centre's booking calendar can be pointed at without editing the code.
 */
function sessionCalendars_() {
  const stored = PropertiesService.getScriptProperties()
    .getProperty(CONFIG.CHANGELOG.CALENDAR_PROPERTY);
  const ids = String(stored || '').trim()
    ? splitList_(stored)
    : (CONFIG.CHANGELOG.CALENDAR_IDS || []).slice();

  if (!ids.length) {
    const own = CalendarApp.getDefaultCalendar();
    return own ? [own] : [];
  }

  const found = [];
  ids.forEach(function (id) {
    const calendar = CalendarApp.getCalendarById(id);
    if (calendar) found.push(calendar);
  });
  if (!found.length) {
    throw new Error('None of the calendars could be opened: ' + ids.join(', ') +
      '. Check them with Tools → Calendar: set the calendar, and that this ' +
      'account has been given access to them.');
  }
  return found;
}

/**
 * Whether a piece of calendar text names a student.
 *
 * An event is called all sorts of things -- "Amalie Laz", "Amalie Laz -
 * Session", "4:00 Amalie" -- so the student's name is looked for inside the
 * text rather than the text being expected to equal it. The ranking is the one
 * the seating chart uses, so "Amalie L" on a calendar means the same student
 * it means on the chart, with the same rules about what counts as a match.
 */
function calendarNames_(text, name) {
  const words = normalizeStudentName_(text).split(' ').filter(Boolean);
  const wanted = normalizeStudentName_(name).split(' ').filter(Boolean);
  if (!words.length || !wanted.length) return 0;

  let best = 0;
  // Every run of words the length of the name, so a name buried in a longer
  // title is found without a bare first name matching the wrong child.
  for (let i = 0; i + wanted.length <= words.length; i++) {
    const run = words.slice(i, i + wanted.length).join(' ');
    best = Math.max(best, seatingMatchRank_(run, name));
    if (best === 2) return 2;
  }
  return best;
}

/** Everything an event might carry a name in: its title, and its guests. */
function eventNameFields_(event) {
  const fields = [event.getTitle()];
  let guests = [];
  try {
    guests = event.getGuestList() || [];
  } catch (err) {
    guests = [];   // some calendars refuse the guest list; the title still works
  }
  guests.forEach(function (guest) {
    fields.push(guest.getName());
    fields.push(String(guest.getEmail() || '').split('@')[0].replace(/[._]+/g, ' '));
  });
  return fields.filter(Boolean);
}

/**
 * When the student is next in, after the day given.
 *
 * Strictly after: an assessment done today is followed up next time they are
 * here, not this afternoon. The search runs forward
 * CONFIG.CHANGELOG.LOOKAHEAD_DAYS and takes the earliest event that names
 * them.
 *
 * Returns { date, title } or null. Null means the calendar does not say, which
 * is not the same as the student never coming back, and the columns are filled
 * with question marks rather than with a guess.
 */
function nextSessionFor_(calendars, name, after) {
  const from = new Date(after.getFullYear(), after.getMonth(), after.getDate() + 1);
  const to = new Date(from.getFullYear(), from.getMonth(),
    from.getDate() + (CONFIG.CHANGELOG.LOOKAHEAD_DAYS || 28));

  let exact = null;
  const loose = [];

  calendars.forEach(function (calendar) {
    calendar.getEvents(from, to).forEach(function (event) {
      let rank = 0;
      eventNameFields_(event).forEach(function (field) {
        rank = Math.max(rank, calendarNames_(field, name));
      });
      if (!rank) return;

      const hit = { date: event.getStartTime(), title: event.getTitle(), rank: rank };
      if (rank === 2) {
        if (!exact || hit.date < exact.date) exact = hit;
      } else {
        loose.push(hit);
      }
    });
  });

  if (exact) return exact;
  if (!loose.length) return null;

  // Nothing named them outright. An abbreviation will do, but only when every
  // event that matched is plainly the same person -- two different children
  // behind one shorthand is not something to pick between.
  const names = [];
  loose.forEach(function (hit) {
    const key = normalizeStudentName_(hit.title);
    if (names.indexOf(key) === -1) names.push(key);
  });
  if (names.length > 1) return null;

  return loose.sort(function (a, b) { return a.date - b.date; })[0];
}

function dayLabel_(date) {
  return CONFIG.CHANGELOG.DAY_LABELS[date.getDay()] || '';
}

function monthDay_(date) {
  return (date.getMonth() + 1) + '/' +
    (date.getDate() < 10 ? '0' : '') + date.getDate();
}

/**
 * A m/dd cell as a sortable month-and-day number, or null if it is not one.
 *
 * The column carries no year, so this is only ever good enough to say that two
 * rows look out of order. It is never good enough to date anything by, and
 * nothing here uses it for that.
 */
function monthDayValue_(raw) {
  if (raw instanceof Date) return raw.getMonth() * 100 + raw.getDate();
  const parts = String(raw == null ? '' : raw).trim()
    .match(/^(\d{1,2})\s*\/\s*(\d{1,2})$/);
  if (!parts) return null;
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return (month - 1) * 100 + day;
}

/**
 * The most recent earlier row for the same student and the same assessment.
 *
 * Same assessment means the same name: a Checkup 6 is comparable with a
 * Checkup 6 and with nothing else. Rows below the one being graded are not
 * considered, so grading an older row does not compare it against its own
 * future.
 */
function previousAssessment_(rows, forRow) {
  const col = CONFIG.CHANGELOG.COL;
  const student = normalizeStudentName_(forRow.values[col.STUDENT - 1]);
  const assessment = String(forRow.values[col.ASSESSMENT - 1] || '')
    .trim().toLowerCase();
  if (!student || !assessment) return null;

  let best = null;
  rows.forEach(function (row) {
    if (row.index >= forRow.index) return;
    if (normalizeStudentName_(row.values[col.STUDENT - 1]) !== student) return;
    if (String(row.values[col.ASSESSMENT - 1] || '').trim().toLowerCase() !== assessment) {
      return;
    }
    if (percentValue_(row.values[col.PERCENT - 1]) === null) return;
    best = row;   // rows arrive in sheet order, so the last match is the latest
  });
  return best;
}

/** Reads the changelog into rows the three stages can work over. */
function changelogRows_(sheet) {
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let r = CONFIG.CHANGELOG.HEADER_ROWS; r < values.length; r++) {
    rows.push({ index: r, sheetRow: r + 1, values: values[r] });
  }
  return rows;
}

/**
 * The rows a stage should act on: the highlighted ones, or every row with a
 * student on it when nothing is highlighted.
 */
function changelogSelection_(sheet, rows) {
  const range = sheet.getActiveRange();
  const col = CONFIG.CHANGELOG.COL;
  if (!range || range.getNumRows() >= rows.length) {
    return rows.filter(function (row) {
      return String(row.values[col.STUDENT - 1] || '').trim() !== '';
    });
  }
  const first = range.getRow();
  const last = first + range.getNumRows() - 1;
  return rows.filter(function (row) {
    return row.sheetRow >= first && row.sheetRow <= last;
  });
}

// ------------------------------------------------------------------
// Stage one: creation
// ------------------------------------------------------------------

/**
 * Menu entry: date the assessment, and say when the student is next in.
 *
 * You put the name in column B; this fills the date it was set and the next
 * session either side of the weekend. It will not touch a row that already has
 * a date -- re-running is for rows nobody has got to yet.
 */
function changelogCreate() {
  const log = ActionLog_();
  const stats = { created: 0, already: 0, noName: 0, noSession: 0 };

  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    showError_('Another run is in progress. Try again in a moment.');
    return;
  }

  try {
    const sheet = changelogSheet_();
    const col = CONFIG.CHANGELOG.COL;
    const rows = changelogRows_(sheet);
    const picked = changelogSelection_(sheet, rows);
    const today = new Date();

    // One read of the calendar for the whole run, not one per student.
    let calendars = [];
    let calendarProblem = '';
    try {
      calendars = sessionCalendars_();
    } catch (err) {
      calendarProblem = err.message;
    }

    picked.forEach(function (row) {
      const name = String(row.values[col.STUDENT - 1] || '').trim();
      if (!name) { stats.noName++; return; }

      if (String(row.values[col.DATE_DONE - 1] || '').trim()) {
        stats.already++;
        return;
      }

      let next = null;
      let why = calendarProblem;
      if (!why) {
        try {
          next = nextSessionFor_(calendars, name, today);
        } catch (err) {
          why = 'the calendar could not be read: ' + err.message;
        }
      }

      sheet.getRange(row.sheetRow, col.DATE_DONE).setValue(monthDay_(today));
      sheet.getRange(row.sheetRow, col.DAY_OF_WEEK)
        .setValue(next ? dayLabel_(next.date) : CONFIG.CHANGELOG.UNKNOWN_DAY);
      sheet.getRange(row.sheetRow, col.NEXT_DATE)
        .setValue(next ? monthDay_(next.date) : CONFIG.CHANGELOG.UNKNOWN_DATE);
      stats.created++;

      if (next) {
        log.ok(name, monthDay_(today) + ' — next in ' + dayLabel_(next.date) +
          ' ' + monthDay_(next.date) + ', from "' + next.title + '".');
      } else {
        stats.noSession++;
        // A question mark is the honest answer and the person can fill it in.
        // A plausible date nobody checked is the one that gets acted on.
        log.warn(name, why || 'is not on the calendar in the next ' +
          (CONFIG.CHANGELOG.LOOKAHEAD_DAYS || 28) + ' days, so columns ' +
          columnLetter_(col.DAY_OF_WEEK) + ' and ' +
          columnLetter_(col.NEXT_DATE) + ' are left as question marks.');
      }
    });

    showReport_('Deck Changelog', 'Assessments dated', [
      { label: 'Rows created', value: stats.created },
      { label: 'Already dated', value: stats.already },
      { label: 'No student name', value: stats.noName, alert: stats.noName > 0 },
      { label: 'No next session found', value: stats.noSession,
        alert: stats.noSession > 0 }
    ], log);
  } catch (err) {
    showError_(err.message);
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------------
// Stage two: grading
// ------------------------------------------------------------------

/**
 * Menu entry: work out the change against the last time, and the stars.
 *
 * Stars are half the questions answered right. Where the student has sat this
 * assessment before, what counts is what they got right *this* time that they
 * did not before -- so the change in percentage drives the stars, not the
 * whole grade, and a second sitting does not earn stars twice over.
 */
function changelogGrade() {
  const log = ActionLog_();
  const stats = { graded: 0, firstSitting: 0, noQuestions: 0, noPercent: 0,
                  finished: 0 };

  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    showError_('Another run is in progress. Try again in a moment.');
    return;
  }

  try {
    const sheet = changelogSheet_();
    const col = CONFIG.CHANGELOG.COL;
    const rows = changelogRows_(sheet);
    const picked = changelogSelection_(sheet, rows);
    const counts = CONFIG.CHANGELOG.QUESTION_COUNTS || {};

    picked.forEach(function (row) {
      const name = String(row.values[col.STUDENT - 1] || '').trim();
      if (!name) return;

      // Grading is the one stage somebody may have finished by hand, and the
      // done column is where they say so. Re-running must not quietly write
      // over their figures; clearing that cell is how you ask for a re-grade.
      if (String(row.values[col.DONE - 1] || '').trim()) {
        stats.finished++;
        return;
      }

      const percent = percentValue_(row.values[col.PERCENT - 1]);
      if (percent === null) {
        stats.noPercent++;
        log.warn(name, 'has no grade in column ' + columnLetter_(col.PERCENT) +
          ' yet, so there is nothing to work from.');
        return;
      }

      const assessment = String(row.values[col.ASSESSMENT - 1] || '').trim();
      const previous = previousAssessment_(rows, row);

      // The change first, because it decides what the stars are counted on.
      let basis = percent;
      if (previous) {
        const before = percentValue_(previous.values[col.PERCENT - 1]);
        const change = percent - before;
        basis = change;
        sheet.getRange(row.sheetRow, col.CHANGE)
          .setValue((change > 0 ? '+' : '') + Math.round(change * 10) / 10 + '%');

        // "Last time" means the row above, because the sheet is written down
        // the page as the days go by. If the dates say otherwise, the
        // comparison may be the wrong way round, and that is worth hearing.
        const mine = monthDayValue_(row.values[col.DATE_DONE - 1]);
        const beforeDate = monthDayValue_(previous.values[col.DATE_DONE - 1]);
        if (mine !== null && beforeDate !== null && beforeDate > mine) {
          log.warn(name, 'was compared against row ' + previous.sheetRow +
            ', which sits above it but is dated later (' +
            String(previous.values[col.DATE_DONE - 1]).trim() + ' against ' +
            String(row.values[col.DATE_DONE - 1]).trim() + '). ' +
            'The rows look out of order, so check the change is the right way ' +
            'round before trusting it.');
        }
      } else {
        stats.firstSitting++;
        sheet.getRange(row.sheetRow, col.CHANGE)
          .setValue(CONFIG.CHANGELOG.NO_COMPARISON);
      }

      const questions = counts[assessment];
      if (!questions) {
        stats.noQuestions++;
        log.warn(name, assessment
          ? '"' + assessment + '" is not in CONFIG.CHANGELOG.QUESTION_COUNTS, ' +
            'so the stars are left for you to put in.'
          : 'has no assessment named in column ' + columnLetter_(col.ASSESSMENT) +
            ', so the stars cannot be worked out.');
        return;
      }

      const stars = starsFor_(basis, questions);
      sheet.getRange(row.sheetRow, col.STARS).setValue(stars);
      stats.graded++;

      if (stars < 0) {
        log.warn(name, 'scored lower than last time, so the stars come out at ' +
          stars + '. Left as calculated rather than rounded up to nothing.');
      } else {
        log.ok(name, (previous ? 'up on ' + assessment + ': ' : assessment + ': ') +
          stars + ' star(s).');
      }
    });

    showReport_('Deck Changelog', 'Grading', [
      { label: 'Stars worked out', value: stats.graded },
      { label: 'First sitting (no comparison)', value: stats.firstSitting },
      { label: 'Question count not known', value: stats.noQuestions,
        alert: stats.noQuestions > 0 },
      { label: 'No grade entered yet', value: stats.noPercent,
        alert: stats.noPercent > 0 },
      { label: 'Already marked done', value: stats.finished }
    ], log);
  } catch (err) {
    showError_(err.message);
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------------
// Stage three: the learning plan
// ------------------------------------------------------------------

/**
 * Menu entry: date the learning plan and count what went into it.
 *
 * The initials columns are left alone for now, as is "what's next" -- that one
 * is a sentence somebody writes, not a value to be derived.
 */
function changelogLearningPlan() {
  const log = ActionLog_();
  const stats = { dated: 0, already: 0, needsBook: 0 };

  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    showError_('Another run is in progress. Try again in a moment.');
    return;
  }

  try {
    const sheet = changelogSheet_();
    const col = CONFIG.CHANGELOG.COL;
    const rows = changelogRows_(sheet);
    const picked = changelogSelection_(sheet, rows);
    const today = monthDay_(new Date());

    picked.forEach(function (row) {
      const name = String(row.values[col.STUDENT - 1] || '').trim();
      if (!name) return;

      if (String(row.values[col.LP_DATE - 1] || '').trim()) {
        stats.already++;
        return;
      }

      sheet.getRange(row.sheetRow, col.LP_DATE).setValue(today);
      stats.dated++;

      // How many learning plans this student has had made, counted from the
      // rows above rather than asked for again.
      const student = normalizeStudentName_(name);
      let made = 0;
      rows.forEach(function (other) {
        if (other.index > row.index) return;
        if (normalizeStudentName_(other.values[col.STUDENT - 1]) !== student) return;
        if (other.index === row.index ||
            String(other.values[col.LP_DATE - 1] || '').trim()) {
          made++;
        }
      });
      sheet.getRange(row.sheetRow, col.LP_COUNT).setValue(made);

      if (!String(row.values[col.WORKOUT_BOOK - 1] || '').trim()) {
        stats.needsBook++;
        log.warn(name, 'dated, and counted as learning plan ' + made +
          '. The workout book in column ' + columnLetter_(col.WORKOUT_BOOK) +
          ' is still yours to fill in — nothing the script can read says which ' +
          'book went into the plan.');
      } else {
        log.ok(name, 'dated ' + today + ', learning plan ' + made + '.');
      }
    });

    showReport_('Deck Changelog', 'Learning plans', [
      { label: 'Rows dated', value: stats.dated },
      { label: 'Already dated', value: stats.already },
      { label: 'Workout book still to add', value: stats.needsBook,
        alert: stats.needsBook > 0 }
    ], log);
  } catch (err) {
    showError_(err.message);
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------------
// Which calendar
// ------------------------------------------------------------------

/**
 * Menu entry: say which calendar the students' sessions are on.
 *
 * Checks each one on the spot and says what it found, because a calendar id
 * that this account has not been given access to comes back as nothing at all
 * -- indistinguishable from a calendar with no sessions on it until somebody
 * is staring at a column of question marks.
 */
function setSessionCalendar() {
  const ui = SpreadsheetApp.getUi();
  const stored = PropertiesService.getScriptProperties()
    .getProperty(CONFIG.CHANGELOG.CALENDAR_PROPERTY);

  const response = ui.prompt('Calendar: set the calendar',
    'Which calendar are the students\' sessions on?\n\n' +
    'In Google Calendar, open the calendar\'s Settings and copy its ' +
    '"Calendar ID" — it looks like an email address. Several can be pasted, ' +
    'separated by commas.\n\n' +
    'Leave blank and press OK to go back to this account\'s own calendar.\n\n' +
    (stored ? 'Currently: ' + stored : 'Currently: this account\'s own calendar.'),
    ui.ButtonSet.OK_CANCEL);

  if (response.getSelectedButton() !== ui.Button.OK) return;

  const typed = String(response.getResponseText()).trim();
  const props = PropertiesService.getScriptProperties();

  if (!typed) {
    props.deleteProperty(CONFIG.CHANGELOG.CALENDAR_PROPERTY);
    showError_('Back to this account\'s own calendar.');
    return;
  }

  const ids = splitList_(typed);
  const found = [];
  const missing = [];
  ids.forEach(function (id) {
    let calendar = null;
    try {
      calendar = CalendarApp.getCalendarById(id);
    } catch (err) {
      calendar = null;
    }
    if (calendar) found.push(calendar.getName() + ' (' + id + ')');
    else missing.push(id);
  });

  if (!found.length) {
    showError_('None of those could be opened: ' + missing.join(', ') +
      '\n\nNothing was saved. Most often this is sharing — the account running ' +
      'this script has to have been given access to the calendar too.');
    return;
  }

  props.setProperty(CONFIG.CHANGELOG.CALENDAR_PROPERTY, ids.join(', '));
  showError_('Saved. Looking in: ' + found.join(', ') + '.' +
    (missing.length
      ? '\n\nThese could not be opened and will be skipped: ' +
        missing.join(', ') + '. Check they are shared with this account.'
      : ''));
}
