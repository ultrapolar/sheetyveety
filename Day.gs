/**
 * Getting to the right row on the Daily WOP.
 *
 * The sheet is one long log: each day opens with a row reading
 * "9/17/2026 Thursday" in column A, and the day's students are written under
 * it. After a year that is a thousand rows, and finding today means scrolling.
 *
 * Two entries, and neither of them touches a student's data. **Jump to today**
 * finds the row and puts the cursor on it. **Start a new day** adds today's row
 * at the bottom and jumps there.
 *
 * A header is read by parsing the date out of it rather than by matching the
 * text, so 9/17/2026 and 09/17/2026 are the same day, and the day name on the
 * end is decoration -- it is written for a person to read, and nothing here
 * depends on it being right.
 */

/**
 * The date a Daily WOP cell opens a day with, or null if it does not.
 *
 * A real date is required, not merely something shaped like one: 2/31/2026 is
 * a typo, and taking it for the last day of February would put the cursor on
 * the wrong row and say nothing.
 */
function parseDayHeader_(value) {
  const parts = String(value == null ? '' : value).trim()
    .match(/^(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})(?:\s|$)/);
  if (!parts) return null;

  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const year = Number(parts[3]);
  const date = new Date(year, month - 1, day);
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

/** How a day header is written, for a person to read. */
function dayHeaderText_(date) {
  return (date.getMonth() + 1) + '/' + date.getDate() + '/' + date.getFullYear() +
    ' ' + CONFIG.DAY_HEADER.DAY_NAMES[date.getDay()];
}

function sameDayAs_(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

/** Every day-header row on the sheet, top to bottom. */
function dayHeaderRows_(sheet) {
  const last = sheet.getLastRow();
  if (last < 1) return [];
  const values = sheet.getRange(1, CONFIG.WOP_COL.NAME, last, 1).getValues();
  const found = [];
  for (let r = 0; r < values.length; r++) {
    const date = parseDayHeader_(values[r][0]);
    if (date) found.push({ row: r + 1, date: date });
  }
  return found;
}

/** The Daily WOP, from wherever you happen to be looking. */
function wopSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(CONFIG.SHEETS.WOP);
  if (!sheet) {
    throw new Error('This spreadsheet has no tab named "' + CONFIG.SHEETS.WOP +
      '", spelled exactly that way.');
  }
  return sheet;
}

/** Puts the cursor on a row, switching tabs if you were looking elsewhere. */
function jumpToRow_(sheet, row) {
  SpreadsheetApp.setActiveSheet(sheet);
  sheet.setActiveRange(sheet.getRange(row, 1));
}

/**
 * Menu entry: put the cursor on today's row.
 *
 * Says nothing when it works. The cursor moving is the answer, and a dialog
 * every time would be one more click on something meant to save clicks.
 */
function jumpToToday() {
  let sheet;
  try {
    sheet = wopSheet_();
  } catch (err) {
    showError_(err.message);
    return;
  }

  const today = new Date();
  const mine = dayHeaderRows_(sheet).filter(function (header) {
    return sameDayAs_(header.date, today);
  });

  if (!mine.length) {
    showError_('There is no row for ' + dayHeaderText_(today) + ' yet.\n\n' +
      'SOD → Start a new day adds one at the bottom and takes you to it.');
    return;
  }

  jumpToRow_(sheet, mine[0].row);

  if (mine.length > 1) {
    // Two headers for one day means it got started twice, and the day's rows
    // are split between them. Worth hearing about, after the cursor has moved.
    showError_('Taken you to row ' + mine[0].row + ', but today is opened ' +
      mine.length + ' times on this sheet — rows ' +
      mine.map(function (h) { return h.row; }).join(', ') + '. The day\'s ' +
      'students are split between them, which the end-of-day run will not ' +
      'notice. Worth merging them.');
  }
}

/**
 * Menu entry: open today at the bottom of the sheet, and go there.
 *
 * Two things it will not do, both for the same reason -- a day log that is out
 * of order or opened twice is quietly wrong, and nothing downstream checks:
 *
 *   - Add a second row for a day that is already open. It goes to the existing
 *     one instead and says so.
 *   - Add today underneath a day that has not happened yet. Somebody has
 *     started tomorrow already, and where today belongs is a judgement.
 */
function startNewDay() {
  let sheet;
  try {
    sheet = wopSheet_();
  } catch (err) {
    showError_(err.message);
    return;
  }

  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    showError_('Another run is in progress. Try again in a moment.');
    return;
  }

  try {
    const today = new Date();
    const headers = dayHeaderRows_(sheet);

    const already = headers.filter(function (header) {
      return sameDayAs_(header.date, today);
    });
    if (already.length) {
      jumpToRow_(sheet, already[0].row);
      showError_('Today is already open at row ' + already[0].row +
        '. Nothing was added — you are on it now.');
      return;
    }

    const ahead = headers.filter(function (header) { return header.date > today; });
    if (ahead.length) {
      jumpToRow_(sheet, ahead[0].row);
      showError_('Row ' + ahead[0].row + ' is already ' +
        dayHeaderText_(ahead[0].date) + ', which is after today. Adding today ' +
        'below it would put the sheet out of order, so nothing was added. ' +
        'Move that block down first, or add today\'s row by hand where it ' +
        'belongs.');
      return;
    }

    const target = sheet.getLastRow() + 1;
    if (target > sheet.getMaxRows()) {
      sheet.insertRowsAfter(sheet.getMaxRows(), CONFIG.DAY_HEADER.ROWS_TO_ADD);
    }

    // Take the look of the day before, so a new day is not the one row on the
    // sheet that is a different colour.
    const previous = headers.length ? headers[headers.length - 1] : null;
    if (previous) {
      sheet.getRange(previous.row, 1, 1, sheet.getMaxColumns())
        .copyTo(sheet.getRange(target, 1, 1, sheet.getMaxColumns()),
          { formatOnly: true });
    }

    sheet.getRange(target, CONFIG.WOP_COL.NAME).setValue(dayHeaderText_(today));
    jumpToRow_(sheet, target);

    if (!previous) {
      showError_('Opened ' + dayHeaderText_(today) + ' at row ' + target +
        '. There was no earlier day to copy the formatting from, so the row is ' +
        'plain — colour it however the others are and the next one will match.');
    }
  } catch (err) {
    showError_(err.message);
  } finally {
    lock.releaseLock();
  }
}
