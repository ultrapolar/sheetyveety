/**
 * Who signed in and out on a day, from Radius's Student Attendance Report.
 *
 * The report page (Detail View) fills its table from one request: every
 * sign-in for a range of dates, with the arrival and departure of each. Asked
 * for a single day, it hands over the whole day in one go -- where the Radius
 * import reads a DWP page per student.
 *
 * Laid beside the day's bookings on the calendar, that answers the questions
 * worth asking before everybody goes home:
 *
 *   - who is still signed in (or, for a day gone by, never signed out)
 *   - who was booked and never signed in
 *   - who signed in without being booked, or under a name the calendar spells
 *     differently
 *
 * It reads and it reports. Nothing is written to the sheet: this is the first
 * outing for this part of Radius, and a report that is wrong costs a second
 * look, where a column filled in wrong costs a day's records.
 */

/**
 * The request, field for field as the page sends it.
 *
 * Taken from the browser's own request rather than worked out from the page's
 * script. The grouping, the aggregate and the stray parameter=value are the
 * page's and do nothing for us, but a server is only known to answer the
 * request it has been seen answering, and every field here has been.
 */
function attendanceRequestFields_(date, page) {
  const settings = CONFIG.RADIUS.ATTENDANCE;
  // The page sends a date at midnight, written the way .NET writes one.
  const day = (date.getMonth() + 1) + '/' + date.getDate() + '/' +
    date.getFullYear() + ' 12:00:00 AM';
  return [
    ['sort', ''],
    ['page', String(page)],
    ['pageSize', String(settings.PAGE_SIZE)],
    ['group', 'StudentFullName-asc~EnrollmentId-asc'],
    ['aggregate', 'DurationInHours-sum'],
    ['filter', ''],
    ['start', day],
    ['end', day],
    ['centerId', String(settings.CENTER_ID).trim()],
    ['membershipTypeList', ''],
    ['selectStudent', ''],
    ['delivery', ''],            // blank is both In-Center and At Home
    ['schoolPartnership', '2'],  // 2 is the page's "All"
    ['ctrIds', ''],
    ['parameter', 'value']
  ];
}

/**
 * Every sign-in row in one reply, out from under the grouping.
 *
 * The page groups its table by student and then by enrollment, and the reply
 * comes back nested the same way. Each group carries its rows twice, under
 * Items and again under Subgroups, so only one of the two is followed --
 * reading both would count everybody twice.
 */
function attendanceRowsOf_(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('The attendance report came back empty, so there is ' +
      'nothing to read.');
  }
  if (data.Errors) {
    throw new Error('Radius refused the attendance report: ' +
      shorten_(typeof data.Errors === 'string' ? data.Errors
        : JSON.stringify(data.Errors), 300));
  }
  if (!Array.isArray(data.Data)) {
    throw new Error('The attendance report came back in a shape this script ' +
      'does not know, so nothing was read from it. Radius may have changed ' +
      'the report.');
  }

  const rows = [];
  const walk = function (nodes) {
    (nodes || []).forEach(function (node) {
      if (!node || typeof node !== 'object') return;
      const isGroup = 'HasSubgroups' in node ||
        ('Member' in node && Array.isArray(node.Items));
      if (!isGroup) { rows.push(node); return; }
      walk(node.Items && node.Items.length ? node.Items : node.Subgroups);
    });
  };
  walk(data.Data);
  return rows;
}

/**
 * One row as this script wants it.
 *
 * The times are the ones Radius has already written out for the centre --
 * "4:48 AM" -- and not the timestamps beside them. Those are in UTC, and the
 * day itself is stamped at UTC midnight, so turning them back into a clock
 * time means knowing which time zone Radius meant. The text is what the page
 * shows, so it is what gets used.
 */
function attendanceEntry_(row) {
  const name = String(row.StudentFullName ||
    [row.StudentFirstName, row.StudentLastName].filter(Boolean).join(' ') || '')
    .replace(/\s+/g, ' ').trim();
  return {
    name: name,
    studentId: row.StudentId == null ? '' : String(row.StudentId),
    day: parseDayHeader_(row.AttendanceDateString),
    dayText: String(row.AttendanceDateString || '').trim(),
    signedIn: String(row.ArrivalTimeString || '').trim(),
    signedOut: String(row.DepartureTimeString || '').trim(),
    minutes: typeof row.DurationInMinutes === 'number' ? row.DurationInMinutes : null,
    delivery: String(row.DeliveryText || row.Delivery || '').trim(),
    // Enough to tell one sign-in from another, so a row that turns up on two
    // pages is counted once.
    key: [row.StudentId, row.EnrollmentId, row.ArrivalTime, row.DepartureTime,
      name].join('|')
  };
}

/**
 * Everybody who signed in on a day, read a page at a time.
 *
 * Returns { entries, otherDays, complete }. A row dated some other day is kept
 * out of entries and counted, not trusted: one day was asked for, and a reply
 * that says otherwise is something to mention rather than to report as today.
 * complete is false when the page cap ran out before the rows did.
 */
function loadAttendance_(date) {
  const settings = CONFIG.RADIUS.ATTENDANCE;
  const url = String(settings.URL || '').trim();
  if (!url) {
    throw new Error('Set CONFIG.RADIUS.ATTENDANCE.URL in Config.gs, then run ' +
      'this again.');
  }
  if (!String(settings.CENTER_ID || '').trim()) {
    throw new Error('Set CONFIG.RADIUS.ATTENDANCE.CENTER_ID in Config.gs to ' +
      'your centre number, then run this again.');
  }

  const size = Number(settings.PAGE_SIZE);
  const token = radiusVerificationToken_();
  const seen = {};
  const entries = [];
  const otherDays = [];

  for (let page = 1; page <= settings.MAX_PAGES; page++) {
    if (page > 1) Utilities.sleep(CONFIG.RADIUS.FETCH_DELAY_MS);
    const rows = attendanceRowsOf_(
      radiusPostForm_(url, attendanceRequestFields_(date, page), token));

    rows.forEach(function (row) {
      const entry = attendanceEntry_(row);
      if (seen[entry.key]) return;
      seen[entry.key] = true;
      if (!entry.day || !sameDayAs_(entry.day, date)) {
        otherDays.push(entry);
        return;
      }
      entries.push(entry);
    });

    // A short page is the last one. Whether Radius pages by row or by
    // student, a full page can only mean there may be more.
    if (rows.length < size) {
      return { entries: entries, otherDays: otherDays, complete: true };
    }
  }
  return { entries: entries, otherDays: otherDays, complete: false };
}

/**
 * A name as it is compared, twice over: exactly, and with anything in
 * brackets taken off.
 *
 * Radius keeps notes in a name -- "Jane Doe (IC)" -- that the booking
 * will not have. The loose form is only ever a second choice, so it cannot
 * take a booking away from somebody who matches it exactly.
 */
function attendanceNameKeys_(name) {
  return {
    exact: normalizeStudentName_(name),
    loose: normalizeStudentName_(String(name == null ? '' : name)
      .replace(/\([^)]*\)/g, ' '))
  };
}

/**
 * The day's sign-ins laid beside its bookings.
 *
 * `sessions` is the calendar's list for the day, or null when the calendar
 * could not be read -- in which case the sign-ins are still reported and
 * nothing is said about who did not come, rather than calling everybody a
 * no-show.
 *
 * A booking is matched to a student, not to a sign-in: a double booked as two
 * hours is one sign-in. When a name fits two students Radius has signed in,
 * neither is chosen, and the booking is listed as one that could not be told
 * apart.
 */
function compareAttendance_(entries, sessions, date, now) {
  const today = sameDayAs_(date, now);
  const ahead = !today && date > now;   // a day that has not happened yet

  const byClock = function (a, b) {
    const x = parseClockTime_(a.signedIn);
    const y = parseClockTime_(b.signedIn);
    if (x === null || y === null) return x === null ? (y === null ? 0 : 1) : -1;
    return x - y;
  };

  const people = [];
  const personFor = {};
  entries.slice().sort(byClock).forEach(function (entry) {
    const id = entry.studentId ? 'id|' + entry.studentId : 'name|' + entry.name;
    if (!personFor[id]) {
      personFor[id] = { name: entry.name, keys: attendanceNameKeys_(entry.name),
        entries: [], booked: false, contested: false };
      people.push(personFor[id]);
    }
    personFor[id].entries.push(entry);
  });

  const rows = entries.slice().sort(byClock).map(function (entry) {
    const review = reviewSessionTiming_(entry.signedIn, entry.signedOut);
    return { entry: entry, notes: review.notes, odd: review.shade };
  });

  const report = {
    date: date,
    today: today,
    people: people.length,
    rows: rows,
    stillIn: entries.filter(function (e) { return !e.signedOut; }).sort(byClock),
    calendarRead: sessions !== null && sessions !== undefined,
    missing: [],
    later: [],
    contested: [],
    unbooked: []
  };
  if (!report.calendarRead) return report;

  const bookings = [];
  const bookingFor = {};
  sessions.forEach(function (session) {
    const key = normalizeStudentName_(session.name);
    if (!bookingFor[key]) {
      bookingFor[key] = { name: session.name, keys: attendanceNameKeys_(session.name),
        starts: [], section: session.section };
      bookings.push(bookingFor[key]);
    }
    if (session.start) bookingFor[key].starts.push(session.start);
  });

  bookings.forEach(function (booking) {
    let found = people.filter(function (p) {
      return p.keys.exact === booking.keys.exact;
    });
    if (!found.length) {
      found = people.filter(function (p) {
        return p.keys.loose === booking.keys.loose;
      });
    }

    if (found.length === 1) { found[0].booked = true; return; }
    if (found.length > 1) {
      found.forEach(function (p) { p.contested = true; });
      report.contested.push({ booking: booking, people: found });
      return;
    }

    // Not in yet is not the same as not coming. On the day itself, a booking
    // whose hour has not started is listed apart from the ones that have, and
    // on a day still to come none of them is due.
    const due = !ahead && (!today || !booking.starts.length ||
      booking.starts.some(function (start) { return start <= now; }));
    (due ? report.missing : report.later).push(booking);
  });

  report.unbooked = people.filter(function (p) {
    return !p.booked && !p.contested;
  });

  const byStart = function (a, b) {
    const x = a.starts.length ? Math.min.apply(null, a.starts) : Infinity;
    const y = b.starts.length ? Math.min.apply(null, b.starts) : Infinity;
    return x === y ? 0 : (x < y ? -1 : 1);
  };
  report.missing.sort(byStart);
  report.later.sort(byStart);
  return report;
}

/** "4pm, 5pm (In-Center)" for a booking. */
function attendanceBookedText_(booking) {
  const section = (CONFIG.SCHEDULE.SECTIONS || [])[booking.section];
  const label = section && section.header && section.header[0]
    ? section.header[0].text : '';
  const times = booking.starts.slice().sort(function (a, b) { return a - b; })
    .map(function (start) { return timeOfDayLabel_(start, true); });
  return (times.length ? 'booked ' + times.join(', ') : 'booked') +
    (label ? ' (' + label + ')' : '');
}

/** The report, as the page the dialog shows. */
function attendanceReportHtml_(report, extra) {
  const notes = extra || {};
  const h = escapeHtml_;

  const stat = function (label, value, alert) {
    return '<tr><td style="padding: 2px 0;">' + h(label) + '</td>' +
      '<td style="text-align: right; color: ' + (alert ? '#b91c1c' : '#334155') +
      ';"><b>' + h(String(value)) + '</b></td></tr>';
  };

  const section = function (title, color, items, hint) {
    if (!items.length) return '';
    return '<div style="font-weight: bold; margin: 14px 0 4px; color: ' + color +
      ';">' + h(title) + ' (' + items.length + ')</div>' +
      (hint ? '<div style="color: #64748b; font-size: 12px; margin-bottom: 4px;">' +
        h(hint) + '</div>' : '') +
      '<ul style="padding-left: 20px; margin: 0;">' + items.map(function (item) {
        return '<li style="margin-bottom: 2px;"><strong>' + h(item.name) +
          '</strong>' + (item.text ? ' &mdash; ' + h(item.text) : '') + '</li>';
      }).join('') + '</ul>';
  };

  const stillInTitle = report.today ? 'Still signed in' : 'Never signed out';
  const laterTitle = report.today ? 'Booked, later today' : 'Booked, not due yet';
  const stillIn = report.stillIn.map(function (e) {
    return { name: e.name, text: 'signed in ' + (e.signedIn || 'at a time Radius did not give') };
  });
  const missing = report.missing.map(function (b) {
    return { name: b.name, text: attendanceBookedText_(b) };
  });
  const later = report.later.map(function (b) {
    return { name: b.name, text: attendanceBookedText_(b) };
  });
  const contested = report.contested.map(function (c) {
    return { name: c.booking.name, text: 'Radius has ' + c.people.map(function (p) {
      return p.name;
    }).join(' and ') + ' signed in, so there is no telling which is booked' };
  });
  const unbooked = report.unbooked.map(function (p) {
    return { name: p.name, text: p.entries.map(function (e) {
      return (e.signedIn || '?') + ' – ' + (e.signedOut || 'still in');
    }).join(', ') };
  });

  let warnings = '';
  const warn = function (text) {
    warnings += '<div style="color: #b45309; margin: 8px 0 0;">⚠️ ' + h(text) + '</div>';
  };
  if (!report.calendarRead) {
    warn('The calendar could not be read' +
      (notes.calendarProblem ? ' (' + notes.calendarProblem + ')' : '') +
      ', so this lists who signed in and says nothing about who did not.');
  }
  if (notes.otherDays) {
    warn(notes.otherDays + ' row(s) Radius sent back were dated another day, ' +
      'and are left out.');
  }
  if (notes.incomplete) {
    warn('Radius was still sending rows after ' + CONFIG.RADIUS.ATTENDANCE.MAX_PAGES +
      ' pages, so this is not everybody. Raise CONFIG.RADIUS.ATTENDANCE.MAX_PAGES.');
  }

  const table = report.rows.length
    ? '<table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 4px;">' +
      '<tr style="text-align: left; color: #64748b;"><th>Student</th><th>In</th>' +
      '<th>Out</th><th>Mins</th><th>Where</th><th>Note</th></tr>' +
      report.rows.map(function (row) {
        const e = row.entry;
        const shade = row.odd ? ' background: #fef3c7;' : '';
        return '<tr style="border-top: 1px solid #e2e8f0;' + shade + '">' +
          '<td style="padding: 3px 4px 3px 0;">' + h(e.name) + '</td>' +
          '<td>' + h(e.signedIn || '?') + '</td>' +
          '<td>' + (e.signedOut ? h(e.signedOut) : '<i>still in</i>') + '</td>' +
          '<td>' + (e.signedOut && e.minutes !== null ? h(String(e.minutes)) : '') + '</td>' +
          '<td>' + h(e.delivery) + '</td>' +
          '<td>' + h(row.notes.join('; ')) + '</td></tr>';
      }).join('') + '</table>'
    : '<p style="color: #64748b;">Nobody signed in on this day.</p>';

  const stats = stat('Signed in', report.people) +
    stat(stillInTitle, report.stillIn.length, report.stillIn.length > 0) +
    (report.calendarRead
      ? stat('Booked, no sign-in', report.missing.length, report.missing.length > 0) +
        (report.later.length ? stat(laterTitle, report.later.length) : '') +
        stat('Signed in, not booked', report.unbooked.length, report.unbooked.length > 0)
      : '');

  return '<div style="font-family: Arial, sans-serif; font-size: 14px; ' +
    'line-height: 1.5; padding: 5px; color: #1e293b;">' +
    '<div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px;">' +
    '<h4 style="margin: 0 0 8px 0;">Radius sign-ins, ' + h(dayHeaderText_(report.date)) +
    '</h4><table style="width: 100%; font-size: 14px;">' + stats + '</table></div>' +
    warnings +
    section(stillInTitle, '#b91c1c', stillIn) +
    section('Booked, no sign-in', '#b91c1c', missing) +
    section('Booked, but more than one match', '#b45309', contested) +
    section('Signed in, not booked', '#b45309', unbooked,
      'A walk-in or a make-up, or a name the calendar spells differently.') +
    section(laterTitle, '#334155', later) +
    '<div style="font-weight: bold; margin: 14px 0 0;">Everybody who signed in</div>' +
    table +
    '<p style="color: #64748b; font-size: 12px; margin-top: 12px;">Read only. ' +
    'Nothing on the sheet was changed.</p></div>';
}

/** Reads the day, lays it beside the calendar and shows what it found. */
function showAttendanceFor_(date) {
  let found;
  try {
    found = loadAttendance_(date);
  } catch (err) {
    showError_(err.message);
    return;
  }

  let sessions = null;
  let calendarProblem = '';
  const calendars = allCalendars_();
  if (calendars.problem) {
    calendarProblem = calendars.problem;
  } else if (!calendars.calendars.length) {
    calendarProblem = 'this account can see no calendars';
  } else {
    sessions = scheduleItemsFor_(calendars.calendars, date).sessions;
  }

  const report = compareAttendance_(found.entries, sessions, date, new Date());
  const html = attendanceReportHtml_(report, {
    calendarProblem: calendarProblem,
    otherDays: found.otherDays.length,
    incomplete: !found.complete
  });
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(640).setHeight(600),
    'Who signed in and out');
}

/** Menu entry: today, so far. */
function radiusAttendanceToday() {
  showAttendanceFor_(new Date());
}

/** Menu entry: the same, for a day you type in. */
function radiusAttendancePickDay() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('Who signed in and out: pick a day',
    'Which day? Type it as 9/18/2026, or 9/18 for this year.',
    ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;

  const typed = String(response.getResponseText()).trim();
  if (!typed) {
    showError_('No day typed, so Radius was not asked.');
    return;
  }
  const date = parseTypedDate_(typed);
  if (!date) {
    showError_('"' + typed + '" is not a day I can read. Type it as ' +
      '9/18/2026, or 9/18 for this year.');
    return;
  }
  showAttendanceFor_(date);
}
