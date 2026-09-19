/**
 * Pasting the day's calendar into a column.
 *
 * Put the cursor where you want the list to start, run it, and every item on
 * every calendar this account can see lands down that column, one to a row,
 * written the way the Daily WOP writes a session: "4:00 Amalie Laz".
 *
 * Two things it works out for itself rather than asking:
 *
 *   - **Which day.** The dated row above the cursor, if the sheet keeps one --
 *     so selecting a cell under "9/19/2026 Friday" imports that Friday. On a
 *     sheet with no dated rows it is today.
 *   - **Which calendars.** All of them, subscribed ones included. "Every one
 *     of the calendars" is the request, so nothing is filtered out and the
 *     report says how many came from where.
 *
 * It will not write over anything. A column with something already in it is
 * named and left alone, because the alternative is a paste that silently
 * takes out a morning's work.
 */

/**
 * The day a target row belongs to.
 *
 * The nearest dated row above it wins, so the list goes under the day it was
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

/** One calendar item as the sheet writes a session. */
function scheduleRowText_(item) {
  // An all-day item has no hour to give, and inventing one would put it in the
  // middle of the afternoon.
  return item.time ? item.time + ' ' + item.name : item.name;
}

/**
 * Everything on every calendar for one day, in the order it happens.
 *
 * The same item subscribed through two calendars is one item. Two students at
 * the same time are not, so it takes both the time and the name to be a
 * repeat.
 */
function calendarItemsFor_(calendars, date) {
  const items = [];
  const seen = {};

  calendars.forEach(function (calendar) {
    let events = [];
    try {
      events = calendar.getEventsForDay(date) || [];
    } catch (err) {
      return;   // a calendar that will not answer is counted, not fatal
    }

    events.forEach(function (event) {
      // The title may already carry a time, written by whoever made it. The
      // event's own start is the one to trust.
      const name = extractName_(event.getTitle());
      if (!name) return;

      const allDay = event.isAllDayEvent && event.isAllDayEvent();
      const time = allDay ? '' : hourLabel_(event.getStartTime());
      const key = time + '|' + normalizeStudentName_(name);
      if (seen[key]) return;
      seen[key] = true;

      items.push({ time: time, name: name, allDay: !!allDay,
        start: event.getStartTime(), calendar: calendar.getName() });
    });
  });

  items.sort(function (a, b) {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return a.start - b.start;
  });
  return items;
}

/**
 * Menu entry: paste the day's calendar down the column from the cursor.
 */
function importCalendarSchedule() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();
  const range = sheet.getActiveRange();
  if (!range) {
    showError_('Click the cell you want the list to start in, then run this.');
    return;
  }

  const startRow = range.getRow();
  const column = range.getColumn();
  const day = scheduleDayFor_(sheet, startRow);

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
    const items = calendarItemsFor_(found.calendars, day.date);
    if (!items.length) {
      showError_('Nothing on any calendar for ' + dayHeaderText_(day.date) +
        ' (taken from ' + day.from + '), so nothing was pasted.');
      return;
    }

    // Never over the top of anything. A paste that quietly takes out a
    // morning's work is worse than one that refuses and says where to look.
    const height = sheet.getMaxRows() - startRow + 1;
    if (height > 0) {
      const existing = sheet.getRange(startRow, column,
        Math.min(height, items.length), 1).getValues();
      for (let i = 0; i < existing.length; i++) {
        if (String(existing[i][0]).trim() !== '') {
          showError_('Row ' + (startRow + i) + ' of column ' +
            columnLetter_(column) + ' already has "' +
            String(existing[i][0]).trim() + '" in it, and ' + items.length +
            ' items need ' + items.length + ' clear rows. Nothing was pasted.' +
            '\n\nClear them, or start somewhere further down.');
          return;
        }
      }
    }

    const needed = startRow + items.length - 1;
    if (needed > sheet.getMaxRows()) {
      sheet.insertRowsAfter(sheet.getMaxRows(), needed - sheet.getMaxRows());
    }

    // One write, so one Ctrl+Z puts it back.
    sheet.getRange(startRow, column, items.length, 1)
      .setValues(items.map(function (item) { return [scheduleRowText_(item)]; }));

    const log = ActionLog_();
    const noTime = items.filter(function (item) { return item.allDay; });
    noTime.forEach(function (item) {
      log.warn(item.name, 'is an all-day item, so it has no time in front of ' +
        'it and is listed first.');
    });

    const perCalendar = {};
    items.forEach(function (item) {
      perCalendar[item.calendar] = (perCalendar[item.calendar] || 0) + 1;
    });
    Object.keys(perCalendar).forEach(function (name) {
      log.ok(name, perCalendar[name] + ' item(s).');
    });

    showReport_('Calendar', 'Pasted ' + dayHeaderText_(day.date), [
      { label: 'Items pasted', value: items.length },
      { label: 'Into', value: columnLetter_(column) + startRow + ':' +
        columnLetter_(column) + (startRow + items.length - 1) },
      { label: 'Day taken from', value: day.from },
      { label: 'Calendars read', value: found.calendars.length },
      { label: 'Without a time', value: noTime.length, alert: noTime.length > 0 }
    ], log);
  } catch (err) {
    showError_(err.message);
  } finally {
    lock.releaseLock();
  }
}
