/**
 * Pasting the day's calendar in, laid out the way the sheet wants it.
 *
 * A day's block is built from the top down:
 *
 *     8:45am - 1:15pm IC (Amanda)  AL      the shifts, as they stand
 *     9am - 1pm IC (Bo)  BK
 *     10 - 11am Staff meeting              anything else, as it stands
 *     @HOME                                the section header
 *     9:00 Student One                     ...its students
 *     In-Center | Issue | ... | IAAT       the section header
 *     9:00 Student Two                     ...its students, with the
 *     9:00 Student Three                   instructors covering each hour
 *
 * Three kinds of calendar item, and each goes somewhere different:
 *
 *   - **A session.** "Amalie Laz - (IN-CENTER) 1 hour session - Appointy" is
 *     written "9:00 Amalie Laz" and filed under the section its bracket names.
 *   - **A shift**, which is anything on one of CONFIG.SCHEDULE.SHIFT_CALENDARS.
 *     Pasted as it stands at the top, and listed again beside each hour it
 *     covers.
 *   - **Anything else**, pasted as it stands under the shifts.
 *
 * Only the columns it fills are written, so the formulas in the columns beside
 * them are left where they are.
 */

/**
 * "8:45am", or "9" when the meridiem is coming from the other end of a range.
 */
function timeOfDayLabel_(date, withMeridiem) {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const hour = hours % 12 === 0 ? 12 : hours % 12;
  return hour + (minutes ? ':' + (minutes < 10 ? '0' : '') + minutes : '') +
    (withMeridiem ? (hours < 12 ? 'am' : 'pm') : '');
}

/**
 * "8:45am - 1:15pm", or "9 - 11am" when both ends are the same half of the day.
 *
 * Written the way a calendar writes it, because these lines go in as they
 * stand and are read by a person who is used to seeing them that way.
 */
function timeRangeLabel_(start, end) {
  if (!start) return '';
  if (!end) return timeOfDayLabel_(start, true);
  const sameHalf = (start.getHours() < 12) === (end.getHours() < 12);
  return timeOfDayLabel_(start, !sameHalf) + CONFIG.SCHEDULE.RANGE_SEPARATOR +
    timeOfDayLabel_(end, true);
}

/**
 * The student and the kind of session out of a booking title.
 *
 * "Amalie Laz - (IN-CENTER) 1 hour session - Appointy : Updated" is a name, a
 * bracket saying where they are, and then the booking system talking to
 * itself. Only the first two are wanted.
 */
function parseSessionTitle_(title) {
  const parts = String(title == null ? '' : title).trim()
    .match(/^(.+?)\s*[-–—]\s*\(([^)]*)\)/);
  if (!parts) return null;
  const name = parts[1].trim();
  return name ? { name: name, tag: parts[2].trim() } : null;
}

/** Which section a session's bracket puts it in, or -1 for one nobody named. */
function sectionForTag_(tag) {
  const upper = String(tag || '').toUpperCase();
  const sections = CONFIG.SCHEDULE.SECTIONS || [];
  for (let i = 0; i < sections.length; i++) {
    const marks = sections[i].match || [];
    for (let m = 0; m < marks.length; m++) {
      if (upper.indexOf(String(marks[m]).toUpperCase()) !== -1) return i;
    }
  }
  return -1;
}

/** True for a calendar whose items are shifts rather than sessions. */
function isShiftCalendar_(name) {
  return (CONFIG.SCHEDULE.SHIFT_CALENDARS || []).some(function (wanted) {
    return String(wanted).trim().toLowerCase() ===
      String(name || '').trim().toLowerCase();
  });
}

/**
 * Whether a shift covers an hour.
 *
 * A shift that ends on the hour is not working it: nine to eleven covers the
 * nine and the ten, and the eleven belongs to whoever comes next.
 */
function shiftCoversHour_(shift, hourStart) {
  if (!shift.start || !shift.end) return false;
  return shift.start.getTime() <= hourStart.getTime() &&
    shift.end.getTime() > hourStart.getTime();
}

/** The top of the hour a time falls in. */
function hourStartOf_(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(),
    date.getHours(), 0, 0, 0);
}

/**
 * Everything on every calendar for one day, sorted into the three kinds.
 *
 * The same item reached through two calendars is one item, but a student in
 * twice in a day is two -- so it takes the time and the name together to be a
 * repeat.
 */
function scheduleItemsFor_(calendars, date) {
  const shifts = [];
  const other = [];
  const sessions = [];
  const unplaced = [];
  const seen = {};

  calendars.forEach(function (calendar) {
    let events = [];
    try {
      events = calendar.getEventsForDay(date) || [];
    } catch (err) {
      return;   // a calendar that will not answer is skipped, not fatal
    }
    const fromShifts = isShiftCalendar_(calendar.getName());

    events.forEach(function (event) {
      const title = cellText_(event.getTitle());
      if (!title) return;
      const start = asDate_(event.getStartTime());
      const end = asDate_(event.getEndTime());
      const allDay = event.isAllDayEvent && event.isAllDayEvent();

      const asIs = allDay || !start ? title
        : (timeRangeLabel_(start, end) + ' ' + title);
      const item = { title: title, start: start, end: end, allDay: !!allDay,
        asIs: asIs, calendar: calendar.getName() };

      if (fromShifts) {
        if (seen['shift|' + asIs]) return;
        seen['shift|' + asIs] = true;
        shifts.push(item);
        return;
      }

      const session = parseSessionTitle_(title);
      if (!session || allDay || !start) {
        if (seen['other|' + asIs]) return;
        seen['other|' + asIs] = true;
        other.push(item);
        return;
      }

      const key = 'session|' + hourLabel_(start) + '|' +
        normalizeStudentName_(session.name);
      if (seen[key]) return;
      seen[key] = true;

      const section = sectionForTag_(session.tag);
      if (section === -1) {
        // A bracket nobody has taught it about. Kept, pasted as it stands so
        // nothing is lost, and named in the report -- putting the student in
        // whichever section came first would be a guess about where they sat.
        unplaced.push(item);
        other.push(item);
        return;
      }

      sessions.push({ section: section, name: session.name, start: start,
        text: hourLabel_(start) + ' ' + session.name,
        calendar: calendar.getName() });
    });
  });

  const byTime = function (a, b) { return a.start - b.start; };
  shifts.sort(byTime);
  other.sort(function (a, b) {
    if (!a.start || !b.start) return a.start ? 1 : -1;
    return a.start - b.start;
  });
  sessions.sort(byTime);

  return { shifts: shifts, other: other, sessions: sessions, unplaced: unplaced };
}

/**
 * The day's block, as rows of { column: text }.
 *
 * Built whole before anything is written, so the run either lays the day out
 * or leaves the sheet as it found it.
 */
function scheduleBlock_(items) {
  const rows = [];
  const push = function (cells, student) {
    rows.push({ cells: cells, student: !!student });
    return rows.length - 1;
  };

  items.shifts.forEach(function (shift) { push({ 1: shift.asIs }); });
  items.other.forEach(function (item) { push({ 1: item.asIs }); });

  (CONFIG.SCHEDULE.SECTIONS || []).forEach(function (section, index) {
    const header = {};
    (section.header || []).forEach(function (cell) {
      header[cell.column] = cell.text;
    });
    push(header);

    const mine = items.sessions.filter(function (s) { return s.section === index; });

    // The instructors covering each hour, listed from the row that hour opens
    // on. A shift that has run out is not on the list for the hour after it.
    const instructorColumn = section.instructorColumn || 0;
    let hour = '';
    let covering = [];
    let offset = 0;

    mine.forEach(function (session) {
      const label = hourLabel_(session.start);
      if (label !== hour) {
        hour = label;
        offset = 0;
        const hourStart = hourStartOf_(session.start);
        covering = instructorColumn
          ? items.shifts.filter(function (shift) {
              return shiftCoversHour_(shift, hourStart);
            })
          : [];
      }
      const values = { 1: session.text };
      if (instructorColumn && offset < covering.length) {
        values[instructorColumn] = covering[offset].asIs;
      }
      offset++;
      push(values, true);
    });
  });

  return rows;
}

/** Menu entry: lay today out from the cursor down. */
function importCalendarToday() {
  importCalendarFor_(new Date(), 'today');
}

/** Menu entry: the same, for tomorrow -- for setting up before you leave. */
function importCalendarTomorrow() {
  const today = new Date();
  importCalendarFor_(new Date(today.getFullYear(), today.getMonth(),
    today.getDate() + 1), 'tomorrow');
}

/** Menu entry: the same, for a day you type in. */
function importCalendarPickDay() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('Paste the calendar: pick a day',
    'Which day? Type it as 9/18/2026, or 9/18 for this year.',
    ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;

  const typed = String(response.getResponseText()).trim();
  if (!typed) {
    showError_('No day typed, so nothing was pasted.');
    return;
  }

  const date = parseTypedDate_(typed);
  if (!date) {
    showError_('"' + typed + '" is not a day I can read. Type it as ' +
      '9/18/2026, or 9/18 for this year.');
    return;
  }
  importCalendarFor_(date, 'the day you picked');
}

/**
 * A day somebody typed, or null.
 *
 * The year may be left off, which means this one. A date that does not exist
 * is a typo and comes back null -- taking 2/31 for the first of March would
 * paste a day nobody asked for and say nothing about it.
 */
function parseTypedDate_(text) {
  const parts = String(text == null ? '' : text).trim()
    .match(/^(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?$/);
  if (!parts) return null;

  const month = Number(parts[1]);
  const day = Number(parts[2]);
  let year = parts[3] === undefined ? new Date().getFullYear() : Number(parts[3]);
  if (year < 100) year += 2000;

  const date = new Date(year, month - 1, day);
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

/**
 * Lays a day out from the cursor down.
 *
 * The day is whichever the entry said, not whatever the sheet suggests. The
 * dated row above the cursor is still read, but only to say so when the two
 * disagree: pasting tomorrow under today's heading is a reasonable thing to be
 * doing the evening before, and pasting today under last Tuesday's is not.
 */
function importCalendarFor_(date, source) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();
  const range = sheet.getActiveRange();
  if (!range) {
    showError_('Click the cell the day should start in, then run this.');
    return;
  }

  const startRow = range.getRow();
  const above = scheduleDayFor_(sheet, startRow);
  const day = { date: date, from: source,
    mismatch: above.from !== 'today' && !sameDayAs_(above.date, date)
      ? above.from + ' is ' + dayHeaderText_(above.date) : '' };

  const found = allCalendars_();
  if (found.problem) {
    showError_('This script cannot read your calendars yet: ' + found.problem +
      '\n\nThis is usually the first time it has been asked to. Run it once ' +
      'more and accept the permission Google asks for.');
    return;
  }
  if (!found.calendars.length) {
    showError_('This account can see no calendars at all, so there is nothing ' +
      'to import.');
    return;
  }

  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    showError_('Another run is in progress. Try again in a moment.');
    return;
  }

  try {
    const items = scheduleItemsFor_(found.calendars, day.date);
    const rows = scheduleBlock_(items);
    const bodyRows = items.shifts.length + items.other.length +
      items.sessions.length;
    if (!bodyRows) {
      showError_('Nothing on any calendar for ' + dayHeaderText_(day.date) +
        ' (taken from ' + day.from + '), so nothing was pasted.');
      return;
    }

    if (rows.length + startRow - 1 > sheet.getMaxRows()) {
      sheet.insertRowsAfter(sheet.getMaxRows(),
        rows.length + startRow - 1 - sheet.getMaxRows());
    }

    // Only the columns the block actually fills are touched, so the formulas
    // in the columns beside them stay where they are.
    const columns = {};
    rows.forEach(function (row, i) {
      Object.keys(row.cells).forEach(function (column) {
        if (!columns[column]) columns[column] = {};
        columns[column][i] = row.cells[column];
      });
    });

    // The columns that go beside a student: the formulas, and the column the
    // result is copied into afterwards. Nothing is written into them here --
    // they are listed so the guard below looks at them too, because a formula
    // laid over somebody's note is as lost as anything else.
    const besideStudents = [];
    (CONFIG.SCHEDULE.FORMULAS || []).forEach(function (entry) {
      besideStudents.push(entry.column);
    });
    (CONFIG.SCHEDULE.VALUE_COPIES || []).forEach(function (entry) {
      if (besideStudents.indexOf(entry.to) === -1) besideStudents.push(entry.to);
    });
    besideStudents.forEach(function (column) {
      if (!columns[column]) columns[column] = {};
      rows.forEach(function (row, i) {
        if (row.student && columns[column][i] === undefined) {
          columns[column][i] = '';
        }
      });
    });

    // Nothing is written over. A day laid on top of another day is not
    // something anybody can unpick afterwards.
    const occupied = [];
    Object.keys(columns).forEach(function (column) {
      const existing = sheet.getRange(startRow, Number(column), rows.length, 1)
        .getValues();
      Object.keys(columns[column]).forEach(function (i) {
        const was = cellText_(existing[Number(i)][0]);
        if (was) {
          occupied.push(columnLetter_(Number(column)) + (startRow + Number(i)) +
            ' ("' + shorten_(was, 40) + '")');
        }
      });
    });
    if (occupied.length) {
      showError_('Nothing was pasted: the day needs ' + rows.length +
        ' rows from row ' + startRow + ', and there is already something in ' +
        occupied.slice(0, 5).join(', ') +
        (occupied.length > 5 ? ' and ' + (occupied.length - 5) + ' more' : '') +
        '.\n\nClear them, or start somewhere further down.');
      return;
    }

    Object.keys(columns).forEach(function (column) {
      if (besideStudents.indexOf(Number(column)) !== -1) return;
      const block = [];
      for (let i = 0; i < rows.length; i++) {
        block.push([columns[column][i] === undefined ? '' : columns[column][i]]);
      }
      sheet.getRange(startRow, Number(column), rows.length, 1).setValues(block);
    });

    writeStudentFormulas_(sheet, startRow, rows);

    const log = ActionLog_();
    if (day.mismatch) {
      log.warn('The day above', 'this went in as ' + dayHeaderText_(day.date) +
        ', but ' + day.mismatch + '. That is fine when you are setting up ' +
        'ahead; it is not when you meant to paste under the heading you are ' +
        'sitting in. Ctrl+Z puts it back.');
    }
    items.unplaced.forEach(function (item) {
      log.warn(item.title, 'is a session, but nothing in CONFIG.SCHEDULE' +
        '.SECTIONS matches what is in its brackets, so there is no telling ' +
        'which section it belongs in. Pasted as it stands with the rest.');
    });
    (CONFIG.SCHEDULE.SECTIONS || []).forEach(function (section, index) {
      log.ok(section.header[0].text, items.sessions.filter(function (s) {
        return s.section === index;
      }).length + ' student(s).');
    });
    if (items.shifts.length) log.ok('Shifts', items.shifts.length + ' listed.');
    if (!CONFIG.SCHEDULE.SHIFT_CALENDARS.length) {
      log.warn('Shifts', 'CONFIG.SCHEDULE.SHIFT_CALENDARS names no calendar, ' +
        'so nothing was read as a shift and no instructors are listed beside ' +
        'the hours.');
    }

    showReport_('Calendar', dayHeaderText_(day.date), [
      { label: 'Rows written', value: rows.length },
      { label: 'From', value: 'A' + startRow },
      { label: 'Day', value: day.from },
      { label: 'Heading above says', value: day.mismatch || 'the same day',
        alert: !!day.mismatch },
      { label: 'Students', value: items.sessions.length },
      { label: 'Shifts', value: items.shifts.length },
      { label: 'Pasted as they stand', value: items.other.length },
      { label: 'Section not recognised', value: items.unplaced.length,
        alert: items.unplaced.length > 0 }
    ], log);
  } catch (err) {
    showError_(err.message);
  } finally {
    lock.releaseLock();
  }
}

/**
 * The day a target row belongs to.
 *
 * The nearest dated row above it wins, so the day goes under the row it was
 * meant for. A sheet that keeps no dated rows has nothing to say about it, and
 * today is the only honest answer.
 */
function scheduleDayFor_(sheet, row) {
  const headers = dayHeaderRows_(sheet).filter(function (header) {
    return header.row < row;
  });
  if (!headers.length) return { date: new Date(), from: 'today' };
  const nearest = headers[headers.length - 1];
  return { date: nearest.date, from: 'row ' + nearest.row };
}

/**
 * The formulas that go beside each student, and the text copied from them.
 *
 * The formulas find the student on the Deck List, so they belong to the row
 * and are written per row. What they work out is then copied across as **text**
 * -- column I is a record of what the lookup said on the day, and a second
 * copy of the formula would quietly change every time the Deck List did.
 *
 * The copy has to wait for the formulas to settle, which is what the flush is
 * for: read straight after writing and a spreadsheet hands back the old value,
 * or nothing at all.
 */
function writeStudentFormulas_(sheet, startRow, rows) {
  const formulas = CONFIG.SCHEDULE.FORMULAS || [];
  const copies = CONFIG.SCHEDULE.VALUE_COPIES || [];
  if (!formulas.length && !copies.length) return;

  const isStudent = rows.map(function (row) { return row.student; });
  if (isStudent.indexOf(true) === -1) return;

  formulas.forEach(function (entry) {
    const block = isStudent.map(function (student, i) {
      return [student
        ? String(entry.formula).replace(/\{\{row\}\}/g, String(startRow + i))
        : ''];
    });
    sheet.getRange(startRow, entry.column, rows.length, 1).setFormulas(block);
  });

  if (!copies.length) return;
  SpreadsheetApp.flush();

  copies.forEach(function (entry) {
    const shown = sheet.getRange(startRow, entry.from, rows.length, 1)
      .getDisplayValues();
    const block = isStudent.map(function (student, i) {
      if (!student) return [''];
      const text = String(shown[i][0] == null ? '' : shown[i][0]);
      // A leading "=" would be read as a formula, and this column is meant to
      // hold what the other one said, not to say it again.
      return [/^[=+]/.test(text) ? "'" + text : text];
    });
    sheet.getRange(startRow, entry.to, rows.length, 1).setValues(block);
  });
}
