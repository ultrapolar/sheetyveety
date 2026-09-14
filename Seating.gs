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

    // The hour is written down the left of the block, on whichever of its rows
    // suited whoever drew it.
    let hour = '';
    for (let r = header.row; r < stop && !hour; r++) {
      hour = hourLabel_(values[r][0]);
    }

    // Instructor slots are a property of the block, not of one row: a row with
    // only some of them filled still has the others, empty. Finding them row by
    // row made an empty slot reach across the room for the next name along.
    const instructorColumns = [];
    for (let r = header.row + 1; r < stop; r++) {
      if (!rowLetterOf_(values[r], header.columns)) continue;
      for (let c = 0; c < values[r].length; c++) {
        if (header.columns.indexOf(c) !== -1) continue;
        if (instructorColumns.indexOf(c) !== -1) continue;
        if (cellText_(values[r][c]).length > 1) instructorColumns.push(c);
      }
    }

    for (let r = header.row + 1; r < stop; r++) {
      const row = values[r];
      const letter = rowLetterOf_(row, header.columns);
      if (!letter) continue;   // a spacer or a footer, not a row of seats

      header.columns.forEach(function (c) {
        const occupant = cellText_(row[c]);
        if (!occupant) return;
        const table = tableNumberText_(values[header.row][c]);
        seats.push({
          seat: table + letter,
          occupant: occupant,
          instructor: nearestValue_(row, instructorColumns, c),
          hour: hour,
          block: n,
          table: Number(table),
          letter: letter
        });
      });
    }
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
  if (value instanceof Date) {
    const hours = value.getHours();
    const minutes = value.getMinutes();
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
    if (entry.instructor && pods[pod].instructors.indexOf(entry.instructor) === -1) {
      pods[pod].instructors.push(entry.instructor);
    }
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
    const startRow = CONFIG.SEATING.ORGANIZE_START_ROW;
    const instructorCol = CONFIG.SEATING.INSTRUCTOR_COLUMN;
    const lastRow = wop.getLastRow();

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
        'CONFIG.SEATING.SHEET_NAME points at the right tab.');
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
