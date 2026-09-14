/**
 * Seating chart import.
 *
 * The chart is a grid of tables drawn one block per hour. A block opens with a
 * row of table numbers, and under it sit the seat rows -- C, B and A -- with an
 * instructor column between each pair of tables.
 *
 * The seat cells are labelled "1C", "2A" and so on until somebody writes a
 * student into one, at which point the label is gone. So a seat is never read
 * from the cell: it is worked out from where the cell is. The table number
 * comes from the block's header row directly above, and the row letter from
 * the markers running down the side of that row. That way the chart can be
 * filled in, cleared and refilled all day and the seat names still come out.
 */

/** True for a cell that is just a table number: 8, or 8.0 as Sheets stores it. */
function isTableNumber_(value) {
  const text = String(value == null ? '' : value).trim();
  return text !== '' && /^\d+(?:\.0+)?$/.test(text);
}

function tableNumberText_(value) {
  return String(value).trim().replace(/\.0+$/, '');
}

function cellText_(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * The letter naming a seat row, read from the markers beside it.
 *
 * Two sightings are required: the markers repeat once per pair of tables, so a
 * real row letter is never alone, and a student who happens to be recorded as a
 * single initial should not be mistaken for one.
 */
function rowLetterOf_(row, seatColumns) {
  const counts = {};
  for (let c = 0; c < row.length; c++) {
    if (seatColumns.indexOf(c) !== -1) continue;
    const text = cellText_(row[c]);
    if (text.length === 1 && /[A-Za-z]/.test(text)) {
      const key = text.toUpperCase();
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  let best = '';
  let bestCount = 0;
  Object.keys(counts).forEach(function (key) {
    if (counts[key] > bestCount) { best = key; bestCount = counts[key]; }
  });
  return bestCount >= 2 ? best : '';
}

/** The value in whichever of `columns` sits closest to `column`. */
function nearestValue_(row, columns, column) {
  let best = '';
  let bestDistance = Infinity;
  columns.forEach(function (c) {
    const distance = Math.abs(c - column);
    if (distance < bestDistance) { bestDistance = distance; best = cellText_(row[c]); }
  });
  return best;
}

/**
 * Reads the chart into a flat list of occupied seats.
 *
 * Returns { seat, occupant, instructor } for every seat with a name in it,
 * across every hour block on the sheet.
 */
function parseSeatingChart_(values) {
  const headers = [];
  for (let r = 0; r < values.length; r++) {
    const columns = [];
    for (let c = 0; c < values[r].length; c++) {
      if (isTableNumber_(values[r][c])) columns.push(c);
    }
    // One stray number is a note; a row of them is a block header naming tables.
    if (columns.length >= 2) headers.push({ row: r, columns: columns });
  }

  const seats = [];
  headers.forEach(function (header, n) {
    const stop = n + 1 < headers.length ? headers[n + 1].row : values.length;

    for (let r = header.row + 1; r < stop; r++) {
      const row = values[r];
      const letter = rowLetterOf_(row, header.columns);
      if (!letter) continue;   // a spacer or a footer, not a row of seats

      // Whatever else carries text on a seat row is an instructor slot: the
      // seats are accounted for, and the row letters are single characters.
      const instructorColumns = [];
      for (let c = 0; c < row.length; c++) {
        if (header.columns.indexOf(c) !== -1) continue;
        const text = cellText_(row[c]);
        if (text.length > 1) instructorColumns.push(c);
      }

      header.columns.forEach(function (c) {
        const occupant = cellText_(row[c]);
        if (!occupant) return;
        seats.push({
          seat: tableNumberText_(values[header.row][c]) + letter,
          occupant: occupant,
          instructor: nearestValue_(row, instructorColumns, c)
        });
      });
    }
  });

  return seats;
}

/**
 * Whether a name written on the chart is the student named on the Daily WOP.
 *
 * The chart is filled in by hand and in a hurry, so surnames get cut short --
 * "Amalie L" for "Amalie Laz". A shortened surname counts, a different one does
 * not, and a first name on its own counts only as far as the ambiguity check
 * below lets it.
 */
function seatingNameMatches_(chartName, wopName) {
  const a = normalizeStudentName_(chartName).split(' ').filter(Boolean);
  const b = normalizeStudentName_(wopName).split(' ').filter(Boolean);
  if (!a.length || !b.length) return false;
  if (a.join(' ') === b.join(' ')) return true;
  if (a[0] !== b[0]) return false;
  if (a.length === 1 || b.length === 1) return true;

  const lastA = a[a.length - 1];
  const lastB = b[b.length - 1];
  return lastA.indexOf(lastB) === 0 || lastB.indexOf(lastA) === 0;
}

/** "1C | IN3", or "1C, 2A | IN3 IN1" for a student who moved. */
function formatSeating_(matches) {
  const config = CONFIG.SEATING;
  const seats = [];
  const instructors = [];

  matches.forEach(function (match) {
    if (match.seat && seats.indexOf(match.seat) === -1) seats.push(match.seat);
    if (match.instructor && instructors.indexOf(match.instructor) === -1) {
      instructors.push(match.instructor);
    }
  });

  const left = seats.join(config.SEAT_JOIN);
  const right = instructors.join(config.INSTRUCTOR_JOIN);
  if (!left) return '';
  return right ? left + config.SEPARATOR + right : left;
}

/** Opens the seating chart, wherever it has been put. */
function seatingSheet_() {
  const id = String(CONFIG.SEATING.SPREADSHEET_ID || '').trim();
  const book = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getSheetByName(CONFIG.SEATING.SHEET_NAME);
  if (!sheet) {
    throw new Error('No sheet named "' + CONFIG.SEATING.SHEET_NAME + '" ' +
      (id ? 'in the seating chart spreadsheet.' : 'in this spreadsheet.') +
      ' Set CONFIG.SEATING.SHEET_NAME to the name of its tab.');
  }
  return sheet;
}

/**
 * Menu entry: records where the highlighted students sat, and who sat with them.
 */
function importSeatingChart() {
  const log = ActionLog_();
  const stats = { written: 0, unchanged: 0, replaced: 0, missing: 0 };

  let sheets;
  let selection;
  try {
    sheets = getSheets_();
    selection = getSelection_(sheets.wop);
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
    const seats = parseSeatingChart_(seatingSheet_().getDataRange().getValues());
    if (!seats.length) {
      showError_('No students found on the seating chart. Check that ' +
        'CONFIG.SEATING.SHEET_NAME points at the right tab, and that the chart ' +
        'has its table numbers along the top of each hour.');
      return;
    }

    const nameCol = WopColumn_(sheets.wop, selection.startRow,
      selection.numRows, CONFIG.WOP_COL.NAME);
    const seatCol = WopColumn_(sheets.wop, selection.startRow,
      selection.numRows, CONFIG.SEATING.TARGET_COLUMN);

    // Who is being asked about, so a chart entry that could be any of two of
    // them can be spotted before it is written to either.
    const students = [];
    for (let i = 0; i < selection.numRows; i++) {
      const name = extractName_(nameCol.value(i));
      if (name) students.push({ index: i, name: name });
    }

    seats.forEach(function (entry) {
      const claimants = students.filter(function (student) {
        return seatingNameMatches_(entry.occupant, student.name);
      });
      if (claimants.length > 1) {
        entry.ambiguous = claimants.map(function (s) { return s.name; });
      }
    });

    students.forEach(function (student) {
      const matches = [];
      const ambiguous = [];

      seats.forEach(function (entry) {
        if (!seatingNameMatches_(entry.occupant, student.name)) return;
        if (entry.ambiguous) ambiguous.push(entry);
        else matches.push(entry);
      });

      if (ambiguous.length) {
        log.error(student.name, '"' + ambiguous[0].occupant + '" on the chart ' +
          'could be ' + ambiguous[0].ambiguous.join(' or ') +
          '. Nothing written — write the surname out on the chart to tell them apart.');
        return;
      }

      if (!matches.length) {
        stats.missing++;
        log.warn(student.name, 'not found on the seating chart.');
        return;
      }

      const text = formatSeating_(matches);
      const current = cellText_(seatCol.value(student.index));

      if (current === text) {
        stats.unchanged++;
        return;
      }
      if (current) {
        stats.replaced++;
        log.warn(student.name, 'replaced "' + current + '" with "' + text + '".');
      } else {
        log.ok(student.name, text);
      }
      seatCol.setValue(student.index, text);
      stats.written++;
    });

    seatCol.flush();

    showReport_('Seating chart', 'Seating recorded in column ' +
      columnLetter_(CONFIG.SEATING.TARGET_COLUMN), [
      { label: 'Students written', value: stats.written },
      { label: 'Already correct', value: stats.unchanged },
      { label: 'Replaced', value: stats.replaced, alert: stats.replaced > 0 },
      { label: 'Not on the chart', value: stats.missing, alert: stats.missing > 0 }
    ], log);
  } catch (err) {
    showError_(err.message);
  } finally {
    lock.releaseLock();
  }
}
