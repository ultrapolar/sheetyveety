/**
 * Seating chart import.
 *
 * The chart is a grid of tables drawn one block per hour. A block opens with a
 * row of table numbers, and under it sit the seat rows -- C, B and A -- with an
 * instructor column between each pair of tables.
 *
 * The table number always comes from the block's header row directly above.
 * The row letter is looked for in three places, in this order, because charts
 * in the wild carry different amounts of help:
 *
 *   1. A seat still showing its own label -- "1C" written in the cell -- names
 *      its row outright, and one such seat names the whole row.
 *   2. Failing that, single-letter markers down the side of the row, which the
 *      older chart had.
 *   3. Failing both, the row's position in its block, against
 *      CONFIG.SEATING.SEAT_ROW_ORDER.
 *
 * Only the third is an assumption, so the report says when it was used and
 * which way round it read. A seat name that is silently upside down puts every
 * student at the wrong table.
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

/**
 * The row letter a seat cell names for itself, if it is still showing its
 * label rather than a student.
 *
 * The table number has to match the column it sits in, so a student recorded
 * as "J5" is not mistaken for a seat label, and a stray note is not either.
 */
function seatLabelLetter_(text, table) {
  const parts = String(text == null ? '' : text).trim()
    .match(/^(\d+)\s*([A-Za-z])$/);
  if (!parts) return '';
  return parts[1] === String(table) ? parts[2].toUpperCase() : '';
}

/**
 * The columns holding instructors: the ones dividing the two tables of a pod.
 *
 * Read from where the tables sit rather than from what is written in them,
 * because an instructor column is empty for most of the day and a hunt for
 * text finds nothing. The gap between two pods looks exactly like the gap
 * inside one, so CONFIG.SEATING.PODS is what tells them apart.
 */
function wallColumns_(columns, tableOf) {
  const walls = [];
  for (let i = 0; i + 1 < columns.length; i++) {
    const left = tableOf[columns[i]];
    const right = tableOf[columns[i + 1]];
    if (podOfTable_(left) === -1 || podOfTable_(left) !== podOfTable_(right)) {
      continue;   // the space between two pods, not the wall inside one
    }
    for (let c = columns[i] + 1; c < columns[i + 1]; c++) {
      if (walls.indexOf(c) === -1) walls.push(c);
    }
  }
  return walls;
}

/**
 * Which column is which table, across the whole chart.
 *
 * The room does not move between four o'clock and seven, so the header row
 * over each hour is the same layout drawn again. Read block by block that is a
 * waste; worse, it is fragile, because a header that has lost a table -- the
 * real chart has three of them missing the middle pod -- takes that hour's
 * students down with it. Reading every header together means one complete
 * drawing anywhere on the sheet names the columns for all of them.
 *
 * Two headers naming the same column differently is the room having moved, and
 * that is reported rather than resolved: the last one drawn is not obviously
 * more right than the first.
 */
function seatingLayout_(values, headers) {
  const tableOf = {};
  const conflicts = [];

  headers.forEach(function (header) {
    header.columns.forEach(function (c) {
      const table = Number(tableNumberText_(values[header.row][c]));
      if (tableOf[c] === undefined) { tableOf[c] = table; return; }
      if (tableOf[c] === table) return;
      conflicts.push({ column: c, was: tableOf[c], now: table, row: header.row + 1 });
    });
  });

  const columns = Object.keys(tableOf).map(Number).sort(function (a, b) {
    return a - b;
  });
  return { tableOf: tableOf, columns: columns, conflicts: conflicts,
    walls: wallColumns_(columns, tableOf) };
}

/**
 * The little hour tables off to the side of the chart, and who is on them.
 *
 * They look like this, two of them side by side, splitting the day's hours:
 *
 *     H:00 | CAT        H:00 | CAT
 *     4:00 | AL         6:00 | AL
 *     5:00 | AL         7:00 | AL
 *
 * Whoever is written beside an hour there worked that whole hour, across every
 * pod, so their initials belong to every student in it -- not to one table the
 * way the wall columns do.
 *
 * Found by the "H:00" heading rather than by where it is, because it is a
 * loose table somebody may move, and a fixed cell reference would go on
 * reading whatever ended up there. The heading beside it ("CAT" here) is a
 * label for a person: what the column is called is not what makes it
 * instructors, so any column in the table is read.
 *
 * Returns { hours: { <minutes past midnight>: [initials] }, labels: {...} }.
 */
function hourInstructorTables_(values) {
  const heading = String(CONFIG.SEATING.HOUR_TABLE_HEADER || '').toLowerCase();
  const hours = {};
  const labels = {};
  if (!heading) return { hours: hours, labels: labels };

  const isHeading = function (r, c) {
    return cellText_((values[r] || [])[c]).toLowerCase() === heading;
  };

  for (let r = 0; r < values.length; r++) {
    for (let c = 0; c < (values[r] || []).length; c++) {
      if (!isHeading(r, c)) continue;

      // The rows under the heading, for as long as they carry an hour.
      const rows = [];
      for (let down = r + 1; down < values.length; down++) {
        const label = hourLabel_((values[down] || [])[c]);
        if (!label) break;
        rows.push({ row: down, label: label });
      }
      if (!rows.length) continue;

      // A column belongs to this table when it has a heading of its own, and
      // the table ends where the next one begins.
      //
      // Emptiness cannot mark the edge: the initials sit in a cell merged
      // across two columns, which reads as the value and then a blank, so a
      // blank column is as likely to be the right half of a merge as it is to
      // be the gap between two tables. A heading tells them apart, and it also
      // means a second column of initials beside the first is picked up while
      // a stray note out to the right of everything is not.
      const band = [];
      for (let right = c + 1; right < (values[r] || []).length; right++) {
        if (isHeading(r, right)) break;
        if (cellText_((values[r] || [])[right]) !== '') band.push(right);
      }

      rows.forEach(function (entry) {
        const key = hourSortKey_(entry.label);
        if (!hours[key]) { hours[key] = []; labels[key] = entry.label; }
        band.forEach(function (column) {
          const name = cellText_((values[entry.row] || [])[column]);
          if (name && hours[key].indexOf(name) === -1) hours[key].push(name);
        });
      });
    }
  }

  return { hours: hours, labels: labels };
}

/** Whichever of `columns` sits closest to `column`, or -1 if there are none. */
function nearestColumn_(columns, column) {
  let best = -1;
  let bestDistance = Infinity;
  columns.forEach(function (c) {
    const distance = Math.abs(c - column);
    if (distance < bestDistance) { bestDistance = distance; best = c; }
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

  const layout = seatingLayout_(values, headers);
  const byHour = hourInstructorTables_(values);
  const seats = [];
  seats.conflicts = layout.conflicts;
  seats.hourInstructors = byHour.hours;

  headers.forEach(function (header, n) {
    const stop = n + 1 < headers.length ? headers[n + 1].row : values.length;

    // The hour is written down the left of the block, on whichever of its rows
    // suited whoever drew it.
    let hour = '';
    for (let r = header.row; r < stop && !hour; r++) {
      hour = hourLabel_(values[r][0]);
    }

    // Instructor slots are a property of the block, not of one row: a row with
    // only some of them filled still has the others, empty. Finding them row by
    // row made an empty slot reach across the room for the next name along --
    // and on a chart where nobody is written in yet, found none at all.
    const instructorColumns = layout.walls;

    // Which rows of this block are seat rows, and what each one is called.
    // Gathered for the whole block before any of it is read, so that one
    // labelled seat anywhere in the block names its row for every table.
    // Rows that name themselves: a seat still showing its label, or markers
    // down the side.
    const named = [];
    for (let r = header.row + 1; r < stop; r++) {
      const row = values[r];

      let letter = '';
      let from = '';
      layout.columns.forEach(function (c) {
        if (letter) return;
        const found = seatLabelLetter_(row[c], String(layout.tableOf[c]));
        if (found) { letter = found; from = 'label'; }
      });

      if (!letter) {
        letter = rowLetterOf_(row, layout.columns);
        if (letter) from = 'marker';
      }

      if (letter) named.push({ row: r, letter: letter, from: from });
    }

    // A chart that says nothing about its rows has its seats directly under
    // the header, in the configured order -- and only those.
    //
    // This used to be "the first rows that have anything in them", which is
    // not the same thing. Each block on the real chart ends in a row of its
    // own workings: the hour again in the wall columns, =TODAY() in the table
    // columns. In a block nobody is sitting in, that is the first row with
    // anything in it, so its dates were read as students and its hour as an
    // instructor. Under the last block the rest of the sheet was counted too.
    // Where the seats are is fixed by the layout; what happens to be written
    // near them is not.
    let seatRows = named;
    if (!named.length) {
      const order = CONFIG.SEATING.SEAT_ROW_ORDER || [];
      seatRows = [];
      for (let i = 0; i < order.length && header.row + 1 + i < stop; i++) {
        seatRows.push({ row: header.row + 1 + i, letter: order[i], from: 'position' });
      }
    }

    // The instructors of a pod, for this hour.
    //
    // They are written down the wall column between the pod's two tables, one
    // to a line because there may be several of them -- not because a line
    // belongs to the seat row beside it. Reading them row by row left the
    // middle row of the real chart with no instructor at all, while the two
    // who were plainly there sat one line above and one below. The format this
    // ends up in says the same thing: "1C | IN1 IN2 IN3" is a list.
    const instructorsAt = {};
    instructorColumns.forEach(function (c) {
      const names = [];
      seatRows.forEach(function (seatRow) {
        const text = cellText_(values[seatRow.row][c]);
        if (text && names.indexOf(text) === -1) names.push(text);
      });
      instructorsAt[c] = names;
    });

    seatRows.forEach(function (seatRow) {
      const row = values[seatRow.row];

      layout.columns.forEach(function (c) {
        const occupant = cellText_(row[c]);
        const table = String(layout.tableOf[c]);
        if (!occupant || seatLabelLetter_(occupant, table)) return;
        seats.push({
          seat: table + seatRow.letter,
          occupant: occupant,
          instructors: instructorsAt[nearestColumn_(instructorColumns, c)] || [],
          // Whoever covered the whole hour, from the tables beside the chart.
          hourInstructors: (byHour.hours[hourSortKey_(hour)] || []).slice(),
          hour: hour,
          block: n,
          table: Number(table),
          letter: seatRow.letter,
          letterFrom: seatRow.from
        });
      });
    });
  });

  return seats;
}

/**
 * Applies the special-spellings list.
 *
 * Some chart shorthand cannot be worked out from the name alone -- two students
 * who share a first name and an initial, or a nickname nobody writes the same
 * way twice. Those are spelled out in CONFIG.SEATING.ALIASES rather than
 * guessed at here.
 */
function resolveSeatingAlias_(name) {
  const aliases = CONFIG.SEATING.ALIASES || {};
  const wanted = normalizeStudentName_(name);
  const keys = Object.keys(aliases);
  for (let i = 0; i < keys.length; i++) {
    if (normalizeStudentName_(keys[i]) === wanted) return aliases[keys[i]];
  }
  return name;
}

/** "12:00" from a cell holding either that text or a real time value. */
function hourLabel_(value) {
  const date = asDate_(value);
  if (date) {
    const hours = date.getHours();
    const minutes = date.getMinutes();
    return (hours % 12 === 0 ? 12 : hours % 12) + ':' +
      (minutes < 10 ? '0' : '') + minutes;
  }
  const text = cellText_(value);
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return '';
  return String(Number(match[1])) + ':' + match[2];
}

/**
 * Minutes past midnight, for putting the hours in the order the day runs.
 *
 * The centre opens mornings or afternoons and never at 1am, so a small hour is
 * an afternoon one: 4:00 belongs after 12:00, not eight hours before 9:00.
 */
function hourSortKey_(label) {
  const match = String(label).match(/^(\d{1,2}):(\d{2})/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  let hours = Number(match[1]);
  if (hours <= CONFIG.AFTERNOON_AT_OR_BELOW) hours += 12;
  return hours * 60 + Number(match[2]);
}

/** Which pod a table belongs to, as a zero-based index, or -1. */
function podOfTable_(table) {
  const pods = CONFIG.SEATING.PODS || [];
  for (let i = 0; i < pods.length; i++) {
    if (pods[i].indexOf(table) !== -1) return i;
  }
  return -1;
}

/**
 * Whether a name written on the chart is the student named on the Daily WOP.
 *
 * The chart is filled in by hand and in a hurry, so surnames get cut short --
 * "Amalie L" for "Amalie Laz". A shortened surname counts, a different one does
 * not, and a first name on its own counts only as far as the ambiguity check
 * below lets it.
 */
function seatingMatchRank_(chartName, wopName) {
  const a = normalizeStudentName_(resolveSeatingAlias_(chartName)).split(' ').filter(Boolean);
  const b = normalizeStudentName_(wopName).split(' ').filter(Boolean);
  if (!a.length || !b.length) return 0;
  if (a.join(' ') === b.join(' ')) return 2;
  if (a[0] !== b[0]) return 0;
  if (a.length === 1 || b.length === 1) return 1;

  const lastA = a[a.length - 1];
  const lastB = b[b.length - 1];
  return (lastA.indexOf(lastB) === 0 || lastB.indexOf(lastA) === 0) ? 1 : 0;
}

/**
 * Picks the one student a chart entry means, out of the ones on offer.
 *
 * A name written out in full beats one that merely starts the same way, so
 * "Student 11" is not taken to be an abbreviation of "Student 1" while a
 * "Student 11" is sitting right there. Only when nothing matches exactly does
 * the abbreviation rule get a say, and two candidates at that point is a
 * genuine ambiguity rather than something to pick between.
 */
function seatingCandidates_(chartName, names) {
  const exact = names.filter(function (n) {
    return seatingMatchRank_(chartName, n) === 2;
  });
  if (exact.length) return exact;
  return names.filter(function (n) { return seatingMatchRank_(chartName, n) === 1; });
}

/**
 * "1C | IN3 IN2 | AL", seat then who was at the table then who had the hour.
 *
 * The two sets of instructors answer different questions -- who sat with this
 * student, and who was covering the whole hour around them -- so they get a
 * slot each rather than running together into one list where a floater is
 * indistinguishable from somebody who was there the whole time.
 *
 * Somebody who is in both is written in both. They were at the table and they
 * covered the hour, and dropping either would be dropping something true.
 */
function formatSeating_(matches) {
  const config = CONFIG.SEATING;
  const seats = [];
  const atTable = [];
  const forHour = [];

  const add = function (list, name) {
    if (name && list.indexOf(name) === -1) list.push(name);
  };

  matches.forEach(function (match) {
    if (match.seat && seats.indexOf(match.seat) === -1) seats.push(match.seat);
    // A student who sat in two pods across the day has two sets of each.
    (match.instructors || []).forEach(function (name) { add(atTable, name); });
    (match.hourInstructors || []).forEach(function (name) { add(forHour, name); });
  });

  if (!seats.length) return '';

  const parts = [seats.join(config.SEAT_JOIN)];
  if (forHour.length) {
    // The middle slot is kept even when nobody was at the table, or the one
    // name left would read as having been sitting there.
    parts.push(atTable.length ? atTable.join(config.INSTRUCTOR_JOIN)
                              : config.NO_INSTRUCTOR);
    parts.push(forHour.join(config.INSTRUCTOR_JOIN));
  } else if (atTable.length) {
    parts.push(atTable.join(config.INSTRUCTOR_JOIN));
  }
  return parts.join(config.SEPARATOR);
}

/**
 * The id of the spreadsheet holding the chart, or '' for this one.
 *
 * What was pasted in through the menu wins over what is in CONFIG, so the
 * link can be changed without editing the code -- and so it does not have to
 * live in the file at all.
 */
function seatingSpreadsheetId_() {
  const stored = PropertiesService.getScriptProperties()
    .getProperty(CONFIG.SEATING.SOURCE_PROPERTY);
  return String(stored || CONFIG.SEATING.SPREADSHEET_ID || '').trim();
}

/**
 * A spreadsheet id out of whatever was pasted.
 *
 * People paste the whole address bar, so the id is dug out of it. A bare id
 * is accepted too, since that is what somebody who has done this before will
 * paste. Anything else comes back empty rather than being half-understood.
 */
function spreadsheetIdFromLink_(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return '';
  const inUrl = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (inUrl) return inUrl[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(raw)) return raw;
  return '';
}

/**
 * Which tab today's chart is on.
 *
 * The weekday and Saturday charts are the same shape, so the only thing that
 * decides between them is the day. Sunday names no tab, and that is an answer
 * rather than a gap: the centre is shut, and reading Saturday's chart on a
 * Sunday would seat everybody where they sat yesterday.
 */
function seatingSheetName_(when) {
  const day = (when || new Date()).getDay();
  return String((CONFIG.SEATING.DAY_SHEETS || [])[day] || '').trim();
}

/**
 * The rows the organiser should work over: today's day block, or the whole
 * sheet when it does not keep day blocks.
 *
 * Returns { startRow, lastRow } or { problem } -- a sheet that keeps day blocks
 * but has not opened today is not a sheet to guess about, because the guess is
 * "append to yesterday".
 */
function todaysBlock_(wop) {
  const headers = dayHeaderRows_(wop);
  const lastRow = wop.getLastRow();

  if (!headers.length) {
    return { startRow: CONFIG.SEATING.ORGANIZE_START_ROW, lastRow: lastRow };
  }

  const today = new Date();
  let mine = -1;
  for (let i = 0; i < headers.length; i++) {
    if (sameDayAs_(headers[i].date, today)) { mine = i; break; }
  }
  if (mine === -1) {
    return { problem: 'This sheet opens each day with a dated row, and there ' +
      'is none for ' + dayHeaderText_(today) + ' yet. Organising now would ' +
      'write today\'s students into yesterday\'s block.\n\n' +
      'SOD → Start a new day adds today\'s row first.' };
  }

  // The block runs to the row before the next day opens, or to the end.
  const next = headers[mine + 1];
  return { startRow: headers[mine].row + 1,
    lastRow: next ? next.row - 1 : lastRow,
    bounded: !!next };
}

/** Opens the seating chart, wherever it has been put. */
function seatingSheet_(when) {
  const name = seatingSheetName_(when);
  if (!name) {
    throw new Error('CONFIG.SEATING.DAY_SHEETS names no seating chart for a ' +
      CONFIG.CHANGELOG.DAY_LABELS[(when || new Date()).getDay()] +
      '. If the centre now opens that day, add its tab name there.');
  }

  const id = seatingSpreadsheetId_();
  let book;
  try {
    book = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  } catch (err) {
    throw new Error('Could not open the seating chart spreadsheet (id "' + id +
      '"): ' + err.message + ' Check the link with Tools → Seating chart: set ' +
      'the link, and that the account running this script can open it.');
  }

  const sheet = book.getSheetByName(name);
  if (!sheet) {
    const tabs = book.getSheets().map(function (s) { return s.getName(); });
    throw new Error('No tab named "' + name + '" ' +
      (id ? 'in the seating chart spreadsheet.' : 'in this spreadsheet.') +
      ' It has: ' + (tabs.length ? tabs.join(', ') : 'nothing') +
      '. Either rename the tab or change CONFIG.SEATING.DAY_SHEETS.');
  }
  return sheet;
}

/**
 * Menu entry: point the script at the spreadsheet holding the seating charts.
 *
 * Checks the link there and then rather than at six o'clock in the evening,
 * and says which tabs it can actually see -- a link to the wrong document, or
 * to one this account cannot open, looks identical to a right one until
 * somebody needs it.
 */
function setSeatingSource() {
  const ui = SpreadsheetApp.getUi();
  const current = seatingSpreadsheetId_();
  const wanted = (CONFIG.SEATING.DAY_SHEETS || []).filter(function (name) {
    return name;
  }).filter(function (name, i, all) { return all.indexOf(name) === i; });

  const response = ui.prompt('Seating chart: set the link',
    'Open the Google Sheet holding the seating charts and copy its address ' +
    'from the browser, then paste it here. A bare id works too.\n\n' +
    'It needs a tab for each of: ' + wanted.join(', ') + '.\n\n' +
    'The account running this script must be able to open it — share it with ' +
    'the same Google account you are in now.\n\n' +
    (current ? 'Currently set to: ' + current : 'Nothing is set, so the chart ' +
      'is looked for in this spreadsheet.'),
    ui.ButtonSet.OK_CANCEL);

  if (response.getSelectedButton() !== ui.Button.OK) return;

  const typed = String(response.getResponseText()).trim();
  if (!typed) {
    showError_('Nothing pasted, so the link was left as it was.');
    return;
  }

  const id = spreadsheetIdFromLink_(typed);
  if (!id) {
    showError_('That does not look like a Google Sheets link or id. A link ' +
      'looks like https://docs.google.com/spreadsheets/d/<id>/edit');
    return;
  }

  let book;
  try {
    book = SpreadsheetApp.openById(id);
  } catch (err) {
    showError_('That link could not be opened: ' + err.message +
      '\n\nNothing was saved. Most often this is sharing: the account running ' +
      'this script has to have access to that document too.');
    return;
  }

  const tabs = book.getSheets().map(function (s) { return s.getName(); });
  const missing = wanted.filter(function (name) {
    return tabs.indexOf(name) === -1;
  });

  PropertiesService.getScriptProperties()
    .setProperty(CONFIG.SEATING.SOURCE_PROPERTY, id);

  showError_('Saved. "' + book.getName() + '" has these tabs: ' +
    tabs.join(', ') + '.' +
    (missing.length
      ? '\n\nNo tab named ' + missing.join(' or ') + ' though, which is what ' +
        'the import will look for. Rename the tabs, or change ' +
        'CONFIG.SEATING.DAY_SHEETS to match what is there.'
      : '\n\nBoth charts are there.'));
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
        'the link is right (Tools → Seating chart: set the link) and that the chart ' +
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
      const raw = nameCol.value(i);
      const name = extractName_(raw);
      if (name) {
        students.push({ index: i, name: name,
          slot: slotMinutes_(leadingTimeOf_(raw)) });
      }
    }

    // One name per person, not per row. After the organiser has run, a student
    // who came twice has two rows, and counting rows made every one of their
    // seats look like it could belong to two different people -- so nothing
    // was written for the commonest case there is.
    const studentNames = [];
    students.forEach(function (student) {
      if (studentNames.indexOf(student.name) === -1) studentNames.push(student.name);
    });

    seats.forEach(function (entry) {
      const claimants = seatingCandidates_(entry.occupant, studentNames);
      entry.claimants = claimants;
      if (claimants.length > 1) entry.ambiguous = claimants;
    });

    students.forEach(function (student) {
      const matches = [];
      const ambiguous = [];

      // A row headed with an hour wants that hour's seat, not every seat the
      // student sat in all day. Without this the noon row and the one o'clock
      // row both read "1C, 3A" and neither says where they actually were.
      const hourly = student.slot !== null && seats.some(function (entry) {
        return entry.hour && slotMinutes_(entry.hour) !== null;
      });

      seats.forEach(function (entry) {
        if (entry.claimants.indexOf(student.name) === -1) return;
        if (entry.ambiguous) { ambiguous.push(entry); return; }
        if (hourly && slotMinutes_(entry.hour) !== student.slot) return;
        matches.push(entry);
      });

      if (ambiguous.length) {
        log.error(student.name, '"' + ambiguous[0].occupant + '" on the chart ' +
          'could be ' + ambiguous[0].ambiguous.join(' or ') +
          '. Nothing written — write the surname out on the chart to tell them apart.');
        return;
      }

      if (!matches.length) {
        stats.missing++;
        const at = leadingTimeOf_(nameCol.value(student.index));
        log.warn(student.name, at
          ? 'not seated at ' + at + ' on the chart.'
          : 'not found on the seating chart.');
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

// ------------------------------------------------------------------
// Start of day: putting the Daily WOP in seating order
// ------------------------------------------------------------------

/**
 * Groups the chart into the order the Daily WOP should read.
 *
 * Hours run in the order the day does, pods within an hour run 1 to 4, and
 * students within a pod run alphabetically. Empty pods are simply not there.
 */
function planSeatingOrder_(seats, nameFor) {
  const hours = [];
  const byHour = {};
  const unpodded = [];
  const doubleBooked = [];
  const unlabelledHour = { seen: false };

  seats.forEach(function (entry) {
    const pod = podOfTable_(entry.table);

    // A table no pod claims. Dropping it silently left the student to be
    // reported later as absent from a chart they are plainly sitting on,
    // which sends whoever reads that after entirely the wrong thing.
    if (pod === -1) {
      unpodded.push({ name: nameFor(entry.occupant), chart: entry.occupant,
        seat: entry.seat, table: entry.table, hour: entry.hour });
      return;
    }
    if (!byHour[entry.hour]) {
      byHour[entry.hour] = { hour: entry.hour, pods: {}, seen: {} };
      hours.push(entry.hour);
      if (!entry.hour) unlabelledHour.seen = true;
    }
    const block = byHour[entry.hour];
    const resolved = nameFor(entry.occupant);

    // Nobody sits in two seats at once. A chart that says otherwise would put
    // the student on the sheet twice for one hour, and the Radius import then
    // has two rows at the same hour and no way to tell which of them the one
    // session belongs to -- so a slip on the chart would cost the import too.
    const key = normalizeStudentName_(resolved);
    if (block.seen[key]) {
      doubleBooked.push({ name: resolved, hour: entry.hour,
        seats: [block.seen[key], entry.seat] });
      return;
    }
    block.seen[key] = entry.seat;

    const pods = block.pods;
    if (!pods[pod]) pods[pod] = { pod: pod, students: [], instructors: [] };
    pods[pod].students.push({ name: resolved, chart: entry.occupant });
    (entry.instructors || []).forEach(function (name) {
      if (name && pods[pod].instructors.indexOf(name) === -1) {
        pods[pod].instructors.push(name);
      }
    });
  });

  hours.sort(function (a, b) { return hourSortKey_(a) - hourSortKey_(b); });

  const rows = [];
  hours.forEach(function (hour, hourIndex) {
    const pods = byHour[hour].pods;
    Object.keys(pods).map(Number).sort(function (a, b) { return a - b; })
      .forEach(function (pod) {
        const group = pods[pod];
        group.students.sort(function (a, b) {
          return a.name.toLowerCase() < b.name.toLowerCase() ? -1
            : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0;
        });
        group.students.forEach(function (student) {
          rows.push({
            name: (hour ? hour + ' ' : '') + student.name,
            chart: student.chart,
            instructors: group.instructors.join(CONFIG.SEATING.INSTRUCTOR_SEPARATOR),
            pod: pod,
            hourIndex: hourIndex
          });
        });
      });
  });

  return { rows: rows, unpodded: unpodded, doubleBooked: doubleBooked,
    unlabelledHour: unlabelledHour.seen };
}

function podFill_(pod) {
  const fills = CONFIG.SEATING.POD_FILLS;
  return fills[pod % fills.length];
}

function podFont_(pod) {
  const fonts = CONFIG.SEATING.POD_FONTS;
  return fonts[pod % fonts.length];
}

function hourShade_(hourIndex) {
  const shades = CONFIG.SEATING.HOUR_SHADES;
  return shades[hourIndex % shades.length];
}

/**
 * Menu entry: rewrites columns A and B of the Daily WOP in seating order.
 *
 * This reorders whole rows' worth of meaning, so it refuses to run once
 * anything else on the sheet has been filled in. A student's pages and times
 * live in the columns to the right and are tied to their row by position
 * alone; shuffling column A underneath them would quietly hand one student's
 * session to another, and no report afterwards could untangle it.
 */
function organizeSeatingRows() {
  const log = ActionLog_();

  let sheets;
  try {
    sheets = getSheets_();
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
    const wop = sheets.wop;
    const instructorCol = CONFIG.SEATING.INSTRUCTOR_COLUMN;

    // Where today's block is.
    //
    // A Daily WOP that opens each day with a "9/17/2026 Thursday" row is a log
    // going back a year, and the only block worth organising is today's. Read
    // from row one it would shuffle every student who has ever been in --
    // which the pinned-data guard below would refuse, so the organiser simply
    // would not run. A sheet with no day headers on it is not a log, and is
    // organised from CONFIG.SEATING.ORGANIZE_START_ROW as before.
    const block = todaysBlock_(wop);
    if (block.problem) {
      showError_(block.problem);
      return;
    }
    const startRow = block.startRow;
    const lastRow = block.lastRow;

    // Everything already on the sheet, so a name can keep the spelling the
    // Daily WOP uses rather than the shorthand the chart was filled in with.
    const existing = [];
    if (lastRow >= startRow) {
      wop.getRange(startRow, CONFIG.WOP_COL.NAME, lastRow - startRow + 1, 1)
        .getValues().forEach(function (row) {
          const name = extractName_(row[0]);
          if (name) existing.push(name);
        });
    }

    // Refuse to shuffle names out from under data that is pinned to its row.
    const guardWidth = wop.getLastColumn();
    if (lastRow >= startRow && guardWidth > instructorCol) {
      const beyond = wop.getRange(startRow, instructorCol + 1,
        lastRow - startRow + 1, guardWidth - instructorCol).getValues();
      for (let r = 0; r < beyond.length; r++) {
        for (let c = 0; c < beyond[r].length; c++) {
          if (cellText_(beyond[r][c]) !== '') {
            showError_('Row ' + (startRow + r) + ' already has something in column ' +
              columnLetter_(instructorCol + 1 + c) + '. Reordering the names now ' +
              'would leave that data beside the wrong student, so nothing has ' +
              'been changed. Run this at the start of the day, before anything ' +
              'else is filled in.');
            return;
          }
        }
      }
    }

    const seats = parseSeatingChart_(seatingSheet_().getDataRange().getValues());
    if (!seats.length) {
      showError_('No students found on the seating chart. Check that ' +
        'the link is right (Tools → Seating chart: set the link).');
      return;
    }

    const unmatched = [];
    const claimed = {};
    const nameFor = function (chartName) {
      const resolved = resolveSeatingAlias_(chartName);
      const hits = seatingCandidates_(chartName, existing);
      hits.forEach(function (name) { claimed[name] = true; });
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        log.error(chartName, 'could be ' + hits.join(' or ') +
          '. Listed as written on the chart — add a line to ' +
          'CONFIG.SEATING.ALIASES to settle it.');
        unmatched.push(chartName);
        return resolved;
      }
      unmatched.push(chartName);
      return resolved;
    };

    const plan = planSeatingOrder_(seats, nameFor);
    const rows = plan.rows;
    if (!rows.length && !plan.unpodded.length) {
      showError_('The chart has students on it, but none at a table belonging ' +
        'to a pod. Check CONFIG.SEATING.PODS against the table numbers.');
      return;
    }

    // A student on the Daily WOP that the chart never mentions. The list is
    // rebuilt from the chart, so leaving them out would quietly delete them --
    // and the one name nobody remembered to seat is exactly the one that must
    // not vanish. They go at the end, marked, with no hour and no pod.
    const unseated = existing.filter(function (name) { return !claimed[name]; });
    const hourCount = rows.length ? rows[rows.length - 1].hourIndex + 1 : 0;

    plan.doubleBooked.forEach(function (entry) {
      log.warn(entry.name, 'is in two seats at ' + (entry.hour || 'one hour') +
        ' on the chart (' + entry.seats.join(' and ') + '). Listed once, at ' +
        entry.seats[0] + ' — fix the chart to settle which.');
    });

    if (plan.unlabelledHour) {
      log.warn('Seating chart', 'an hour block has no time beside it, so its ' +
        'students are listed without one and sorted after the hours that do.');
    }

    plan.unpodded.forEach(function (entry) {
      rows.push({ name: entry.name, chart: entry.chart, instructors: '',
        pod: -1, hourIndex: -1, unseated: true });
      log.warn(entry.name, 'is sitting at table ' + entry.table +
        ', which is not in any pod, so there is no telling where in the order ' +
        'they belong. Listed at the end — check CONFIG.SEATING.PODS.');
    });

    unseated.forEach(function (name) {
      rows.push({ name: name, chart: '', instructors: '',
        pod: -1, hourIndex: -1, unseated: true });
      log.warn(name, 'is on the Daily WOP but not on the seating chart, so they ' +
        'are listed at the end with no seat.');
    });

    // On a day log, today's block ends where tomorrow's begins, and the list
    // is as long as the chart makes it. Writing past the end would overwrite
    // the next day's students with today's -- so it stops instead and says how
    // much room it needs. Where today is the last block there is nothing below
    // to overwrite, and it simply grows.
    if (block.bounded && rows.length > lastRow - startRow + 1) {
      showError_('Today\'s block is rows ' + startRow + ' to ' + lastRow +
        ', which is ' + (lastRow - startRow + 1) + ' rows, and the chart has ' +
        rows.length + ' students on it. Writing them would overwrite the day ' +
        'below, so nothing has been changed.\n\nInsert ' +
        (rows.length - (lastRow - startRow + 1)) + ' more rows above row ' +
        (lastRow + 1) + ' and run this again.');
      return;
    }

    // A sheet trimmed to yesterday's length has nowhere to put today's list. Counted
    // after the unseated are added, or the last of them falls off the end.
    const needed = startRow + rows.length - 1;
    if (needed > wop.getMaxRows()) {
      wop.insertRowsAfter(wop.getMaxRows(), needed - wop.getMaxRows());
    }

    const names = rows.map(function (r) { return [r.name]; });
    const nameShades = rows.map(function (r) {
      return [r.unseated ? CONFIG.COLOR.WARN : hourShade_(r.hourIndex)];
    });
    const instructors = rows.map(function (r) { return [r.instructors]; });
    const podFills = rows.map(function (r) {
      return [r.unseated ? CONFIG.COLOR.WARN : podFill_(r.pod)];
    });
    const podFonts = rows.map(function (r) {
      return [r.unseated ? '#000000' : podFont_(r.pod)];
    });

    wop.getRange(startRow, CONFIG.WOP_COL.NAME, rows.length, 1).setValues(names)
      .setBackgrounds(nameShades);
    wop.getRange(startRow, instructorCol, rows.length, 1).setValues(instructors)
      .setBackgrounds(podFills).setFontColors(podFonts);

    // Yesterday's list may have been longer than today's.
    const spare = lastRow - (startRow + rows.length) + 1;
    if (spare > 0) {
      wop.getRange(startRow + rows.length, CONFIG.WOP_COL.NAME, spare, instructorCol)
        .clearContent();
    }

    unmatched.forEach(function (chartName) {
      log.warn(chartName, 'is on the chart but not on the Daily WOP, so it is ' +
        'listed exactly as the chart spells it.');
    });

    showReport_('Seating order', 'Daily WOP rewritten in seating order', [
      { label: 'Rows written', value: rows.length },
      { label: 'Hours', value: hourCount },
      { label: 'On the Daily WOP but not seated', value: unseated.length,
        alert: unseated.length > 0 },
      { label: 'Seated at a table no pod covers', value: plan.unpodded.length,
        alert: plan.unpodded.length > 0 },
      { label: 'In two seats at once', value: plan.doubleBooked.length,
        alert: plan.doubleBooked.length > 0 },
      { label: 'Names taken from the chart as-is', value: unmatched.length,
        alert: unmatched.length > 0 },
      { label: 'Rows cleared below', value: spare > 0 ? spare : 0 }
    ], log);
  } catch (err) {
    showError_(err.message);
  } finally {
    lock.releaseLock();
  }
}
