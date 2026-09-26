/**
 * Who signed in and out on a day, from Radius's Student Attendance Report,
 * checked against column A of the Daily WOP.
 *
 * The report page (Detail View) fills its table from one request: every
 * sign-in for a range of dates, with the arrival and departure of each. Asked
 * for a single day, it hands over the whole day in one go -- where the Radius
 * import reads a DWP page per student.
 *
 * Laid beside that day's block in column A, it flags:
 *
 *   - anybody signed in more than once
 *   - anybody Radius signed in who is not in column A
 *   - anybody in column A Radius has no sign-in for
 *   - anybody still signed in (or, for a day gone by, never signed out)
 *
 * Column A is coloured for the day's students: green for one sign-in and one
 * sign-out an hour or a double apart, orange for anything worth a look. A row
 * struck through or marked not coming is left as it is. Nothing else on the
 * sheet is touched.
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
  // The report page's own token and cookies, read once for every page of rows.
  const session = radiusFormSession_(String(settings.PAGE_URL || '').trim() ||
    CONFIG.RADIUS.TOKEN_PAGE_URL);
  const seen = {};
  const entries = [];
  const otherDays = [];

  for (let page = 1; page <= settings.MAX_PAGES; page++) {
    if (page > 1) Utilities.sleep(CONFIG.RADIUS.FETCH_DELAY_MS);
    let reply;
    try {
      reply = radiusPostForm_(url, attendanceRequestFields_(date, page), session);
    } catch (err) {
      // A form turned away for want of its token says so in no words at all,
      // so say it here.
      throw new Error(err.message + (session.token ? '' : '\n\nThe report page ' +
        'had no antiforgery token on it to send, which is the usual reason a ' +
        'request like this is refused.'));
    }
    const rows = attendanceRowsOf_(reply);

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
 * The students column A lists for a day, from that day's block on the Daily
 * WOP: the rows under its dated heading, down to the next day's.
 *
 * A block laid out by Paste the calendar opens with the instructors and
 * anything else on the calendar, and only then its @HOME and In-Center
 * headers, so a student is a row under one of those. A block with neither
 * header was typed by hand, and there a student is any row that starts with a
 * time and is not an instructor's shift -- said in the report, because it is
 * a looser reading.
 *
 * Returns { students, problem, note }. problem is set when there is nothing to
 * compare against, and then nobody is reported as missing. A student listed
 * twice (a double, written as two hours) is one student with two rows.
 */
const STRUCK_THROUGH_ = 'struck through';

function wopStudentsFor_(sheet, date) {
  const headers = dayHeaderRows_(sheet);
  let mine = -1;
  for (let i = 0; i < headers.length; i++) {
    if (sameDayAs_(headers[i].date, date)) { mine = i; break; }
  }
  if (mine === -1) {
    return { students: [], problem: 'The Daily WOP has no row for ' +
      dayHeaderText_(date) + ', so there is no column A to compare with.' };
  }

  const first = headers[mine].row + 1;
  const next = headers[mine + 1];
  const last = next ? next.row - 1 : sheet.getLastRow();
  if (last < first) {
    return { students: [], problem: 'Nothing is written under ' +
      dayHeaderText_(date) + ' on the Daily WOP yet, so there is no column A ' +
      'to compare with.' };
  }

  const values = sheet.getRange(first, 1, last - first + 1,
    Math.max(sheet.getLastColumn(), CONFIG.WOP_COL.NAME)).getValues();
  // A name struck through is somebody who is not coming, said with a line
  // instead of a word.
  const lines = sheet.getRange(first, CONFIG.WOP_COL.NAME, last - first + 1, 1)
    .getFontLines();
  const column = CONFIG.WOP_COL.NAME - 1;
  const headings = (CONFIG.SCHEDULE.SECTIONS || []).map(function (section) {
    return section.header && section.header[0]
      ? String(section.header[0].text).trim().toLowerCase() : '';
  }).filter(Boolean);
  const textOf = function (row) {
    const value = row[column];
    return String(value == null ? '' : value).trim();
  };
  const isHeading = function (row) {
    return headings.indexOf(textOf(row).toLowerCase()) !== -1;
  };

  const sectioned = values.some(isHeading);
  let inSection = !sectioned;
  const students = [];
  const byKey = {};

  values.forEach(function (row, i) {
    if (isHeading(row)) { inSection = true; return; }
    const raw = textOf(row);
    if (!inSection || !raw) return;
    const name = extractName_(raw);
    const time = leadingTimeOf_(raw);
    if (!name) return;
    if (!sectioned && (!time || looksLikeShiftTitle_(name))) return;

    const key = normalizeStudentName_(name);
    if (!byKey[key]) {
      byKey[key] = { name: name, keys: attendanceNameKeys_(name), rows: [],
        times: [], minutes: [], notComing: '' };
      students.push(byKey[key]);
    }
    const student = byKey[key];
    student.rows.push(first + i);
    if (time) student.times.push(time);
    student.minutes.push(time ? slotMinutes_(time) : null);
    student.notComing = student.notComing ||
      (lines[i][0] === 'line-through' ? STRUCK_THROUGH_ : rowSaysNotComing_(row));
  });

  return { students: students, problem: '', first: first, last: last,
    note: sectioned ? '' : 'No @HOME or In-Center heading under ' +
      dayHeaderText_(date) + ', so every row starting with a time was taken ' +
      'as a student.' };
}

/**
 * The day's sign-ins laid beside column A.
 *
 * `students` is column A's list for the day, or null when there is none -- in
 * which case the sign-ins are still reported and nothing is said about who
 * did not come, rather than calling everybody a no-show.
 *
 * Column A is matched to a student Radius signed in, not to a sign-in: a
 * student written on two rows for a double is one person. When a name fits
 * two students Radius has signed in, neither is chosen, and the name is listed
 * as one that could not be told apart.
 */
function compareAttendance_(entries, students, date, now) {
  const today = sameDayAs_(date, now);
  const ahead = !today && date > now;   // a day that has not happened yet
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

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
        entries: [], student: null, contested: false };
      people.push(personFor[id]);
    }
    personFor[id].entries.push(entry);
  });

  const report = {
    date: date,
    today: today,
    people: people.length,
    rows: [],
    stillIn: entries.filter(function (e) { return !e.signedOut; }).sort(byClock),
    // More than one sign-in on the day. Always worth a look: a double is one
    // sign-in of two hours, so two sign-ins is somebody who went out and came
    // back, or was signed in twice by mistake.
    twice: people.filter(function (p) { return p.entries.length > 1; }),
    listRead: students !== null && students !== undefined,
    missing: [],
    later: [],
    notComing: [],
    cameAnyway: [],
    contested: [],
    notListed: []
  };

  (students || []).forEach(function (student) {
    let found = people.filter(function (p) {
      return p.keys.exact === student.keys.exact;
    });
    if (!found.length) {
      found = people.filter(function (p) {
        return p.keys.loose === student.keys.loose;
      });
    }

    if (found.length === 1) {
      found[0].student = student;
      student.person = found[0];
      if (student.notComing) report.cameAnyway.push({ student: student, person: found[0] });
      return;
    }
    if (found.length > 1) {
      student.contested = true;
      found.forEach(function (p) { p.contested = true; });
      report.contested.push({ student: student, people: found });
      return;
    }

    // Somebody the row already says is not coming is not a surprise.
    if (student.notComing) { report.notComing.push(student); return; }

    // Not in yet is not the same as not coming. On the day itself, a row whose
    // hour has not started is listed apart from the ones that have, and on a
    // day still to come none of them is due.
    const due = !ahead && (!today || student.minutes.some(function (m) {
      return m === null || m <= nowMinutes;
    }));
    student.missing = due;
    (due ? report.missing : report.later).push(student);
  });

  if (report.listRead) {
    report.notListed = people.filter(function (p) {
      return !p.student && !p.contested;
    });
  }

  report.rows = entries.slice().sort(byClock).map(function (entry) {
    const person = personFor[entry.studentId ? 'id|' + entry.studentId : 'name|' + entry.name];
    const review = reviewSessionTiming_(entry.signedIn, entry.signedOut);
    return { entry: entry, notes: review.notes, odd: review.shade,
      sheetRows: person.student ? person.student.rows : [],
      twice: person.entries.length > 1 };
  });
  report.paint = attendancePaint_(students || []);
  return report;
}

/**
 * The colour each of column A's rows is given, as [{ row, color }].
 *
 * Green only when there is nothing to look at: one sign-in, a sign-out, and a
 * length the timing review calls an hour or a double. Everything else a
 * student in column A can be -- in twice, still in, an odd length, never in,
 * a name that fits two -- is orange. A student not due yet has not had the
 * chance to be either and is left alone, as is anybody struck through or
 * marked not coming.
 */
function attendancePaint_(students) {
  const settings = CONFIG.RADIUS.ATTENDANCE;
  const paint = [];
  students.forEach(function (student) {
    if (student.notComing) return;
    let color = null;
    if (student.person) {
      const entries = student.person.entries;
      const review = entries.length === 1
        ? reviewSessionTiming_(entries[0].signedIn, entries[0].signedOut) : null;
      // No sign-out leaves the length unknown, and that is not clean either.
      const clean = review && !review.shade && review.durationMinutes !== null;
      color = clean ? settings.OK_COLOR : settings.ISSUE_COLOR;
    } else if (student.contested || student.missing) {
      color = settings.ISSUE_COLOR;
    }
    if (!color) return;
    student.rows.forEach(function (row) { paint.push({ row: row, color: color }); });
  });
  return paint;
}

/**
 * Colours column A. Only the rows being coloured change: the rest of the
 * block's backgrounds are read and written back as they were.
 *
 * Returns the number of rows coloured, or -1 when another run held the sheet.
 */
function paintAttendance_(sheet, list, paint) {
  if (!paint.length) return 0;
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) return -1;
  try {
    const range = sheet.getRange(list.first, CONFIG.WOP_COL.NAME,
      list.last - list.first + 1, 1);
    const backgrounds = range.getBackgrounds();
    paint.forEach(function (p) { backgrounds[p.row - list.first][0] = p.color; });
    range.setBackgrounds(backgrounds);
    SpreadsheetApp.flush();
    return paint.length;
  } finally {
    lock.releaseLock();
  }
}

/** "row 42 (9:00)" for a column A student. */
function attendanceRowText_(student) {
  return (student.rows.length > 1 ? 'rows ' : 'row ') + student.rows.join(', ') +
    (student.times.length ? ' (' + student.times.join(', ') + ')' : '');
}

/** "4:48 AM – 5:50 AM, 6:10 AM – still in" for a student's sign-ins. */
function attendanceTimesText_(person) {
  return person.entries.map(function (e) {
    return (e.signedIn || '?') + ' – ' + (e.signedOut || 'still in');
  }).join(', ');
}

/** What happened to column A, for the foot of the dialog. */
function attendancePaintText_(painted, paint) {
  if (painted === -1) {
    return 'Another run was using the sheet, so column A was not coloured. ' +
      'Run this again in a moment.';
  }
  if (!painted) return 'Nothing on the sheet was changed.';
  const green = paint.filter(function (p) {
    return p.color === CONFIG.RADIUS.ATTENDANCE.OK_COLOR;
  }).length;
  return 'Column A coloured: ' + green + ' row(s) green, ' + (paint.length - green) +
    ' orange. Rows struck through or marked not coming, and anybody not due ' +
    'yet, were left as they were. Nothing else on the sheet was changed.';
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
  const laterTitle = report.today ? 'In column A, later today' : 'In column A, not due yet';

  const saysNotComing = function (s) {
    return s.notComing === STRUCK_THROUGH_ ? ' is struck through'
      : ' says "' + s.notComing + '"';
  };
  const twice = report.twice.map(function (p) {
    return { name: p.name, text: p.entries.length + ' sign-ins: ' + attendanceTimesText_(p) };
  });
  const notListed = report.notListed.map(function (p) {
    return { name: p.name, text: attendanceTimesText_(p) };
  });
  const missing = report.missing.map(function (s) {
    return { name: s.name, text: attendanceRowText_(s) };
  });
  const cameAnyway = report.cameAnyway.map(function (c) {
    return { name: c.student.name, text: attendanceRowText_(c.student) +
      saysNotComing(c.student) + ', but Radius has them in: ' +
      attendanceTimesText_(c.person) };
  });
  const contested = report.contested.map(function (c) {
    return { name: c.student.name, text: attendanceRowText_(c.student) + ' fits ' +
      c.people.map(function (p) { return p.name; }).join(' and ') +
      ', so there is no telling which one it is' };
  });
  const stillIn = report.stillIn.map(function (e) {
    return { name: e.name, text: 'signed in ' + (e.signedIn || 'at a time Radius did not give') };
  });
  const later = report.later.map(function (s) {
    return { name: s.name, text: attendanceRowText_(s) };
  });
  const notComing = report.notComing.map(function (s) {
    return { name: s.name, text: attendanceRowText_(s) + saysNotComing(s) };
  });

  let warnings = '';
  const warn = function (text) {
    warnings += '<div style="color: #b45309; margin: 8px 0 0;">⚠️ ' + h(text) + '</div>';
  };
  if (!report.listRead) {
    warn((notes.listProblem || 'Column A could not be read.') +
      ' This lists who signed in and says nothing about who did not.');
  }
  if (notes.listNote) warn(notes.listNote);
  if (notes.otherDays) {
    warn(notes.otherDays + ' row(s) Radius sent back were dated another day, ' +
      'and are left out.');
  }
  if (notes.incomplete) {
    warn('Radius was still sending rows after ' + CONFIG.RADIUS.ATTENDANCE.MAX_PAGES +
      ' pages, so this is not everybody. Raise CONFIG.RADIUS.ATTENDANCE.MAX_PAGES.');
  }

  const table = report.rows.length
    ? '<table class="att" style="width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 4px;">' +
      '<tr style="text-align: left; color: #64748b;"><th>Student</th><th>Row</th>' +
      '<th>In</th><th>Out</th><th>Mins</th><th>Where</th><th>Note</th></tr>' +
      report.rows.map(function (row) {
        const e = row.entry;
        const flagged = row.twice || (report.listRead && !row.sheetRows.length);
        const shade = flagged ? ' background: #fee2e2;' : (row.odd ? ' background: #fef3c7;' : '');
        const noteList = row.notes.slice();
        if (row.twice) noteList.unshift('signed in more than once');
        return '<tr style="border-top: 1px solid #e2e8f0;' + shade + '">' +
          '<td>' + h(e.name) + '</td>' +
          '<td style="white-space: nowrap;">' + (row.sheetRows.length ? h(row.sheetRows.join(', '))
            : (report.listRead ? '<i>not in A</i>' : '')) + '</td>' +
          '<td style="white-space: nowrap;">' + h(e.signedIn || '?') + '</td>' +
          '<td style="white-space: nowrap;">' +
            (e.signedOut ? h(e.signedOut) : '<i>still in</i>') + '</td>' +
          '<td>' + (e.signedOut && e.minutes !== null ? h(String(e.minutes)) : '') + '</td>' +
          '<td style="white-space: nowrap;">' + h(e.delivery) + '</td>' +
          '<td>' + h(noteList.join('; ')) + '</td></tr>';
      }).join('') + '</table>'
    : '<p style="color: #64748b;">Nobody signed in on this day.</p>';

  const stats = stat('Signed in', report.people) +
    stat('Signed in more than once', report.twice.length, report.twice.length > 0) +
    (report.listRead
      ? stat('Signed in, not in column A', report.notListed.length, report.notListed.length > 0) +
        stat('In column A, no sign-in', report.missing.length, report.missing.length > 0) +
        (report.later.length ? stat(laterTitle, report.later.length) : '')
      : '') +
    stat(stillInTitle, report.stillIn.length, report.stillIn.length > 0);

  return '<style>.att td, .att th { padding: 3px 8px 3px 0; vertical-align: top; }</style>' +
    '<div style="font-family: Arial, sans-serif; font-size: 14px; ' +
    'line-height: 1.5; padding: 5px; color: #1e293b;">' +
    '<div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px;">' +
    '<h4 style="margin: 0 0 8px 0;">Radius sign-ins against column A, ' +
    h(dayHeaderText_(report.date)) +
    '</h4><table style="width: 100%; font-size: 14px;">' + stats + '</table></div>' +
    warnings +
    section('Signed in more than once', '#b91c1c', twice,
      'A double is one sign-in of two hours, so two sign-ins is somebody who ' +
      'left and came back, or was signed in twice by mistake.') +
    section('Signed in, not in column A', '#b91c1c', notListed,
      'Not on the Daily WOP for this day, or written there under a different name.') +
    section('In column A, no sign-in', '#b91c1c', missing) +
    section('Marked not coming, but signed in', '#b91c1c', cameAnyway) +
    section('In column A, more than one match', '#b45309', contested) +
    section(stillInTitle, '#b45309', stillIn) +
    section(laterTitle, '#334155', later) +
    section('Marked not coming', '#334155', notComing) +
    '<div style="font-weight: bold; margin: 14px 0 0;">Everybody who signed in</div>' +
    table +
    '<p style="color: #64748b; font-size: 12px; margin-top: 12px;">' +
    h(attendancePaintText_(notes.painted, report.paint)) + '</p></div>';
}

/** Reads the day, lays it beside column A and shows what it found. */
function showAttendanceFor_(date) {
  let list;
  let wop = null;
  try {
    wop = wopSheet_();
    list = wopStudentsFor_(wop, date);
  } catch (err) {
    list = { students: [], problem: err.message };
  }

  let found;
  try {
    found = loadAttendance_(date);
  } catch (err) {
    showError_(err.message);
    return;
  }

  const report = compareAttendance_(found.entries,
    list.problem ? null : list.students, date, new Date());
  const painted = list.problem ? 0 : paintAttendance_(wop, list, report.paint);
  const html = attendanceReportHtml_(report, {
    painted: painted,
    listProblem: list.problem,
    listNote: list.note,
    otherDays: found.otherDays.length,
    incomplete: !found.complete
  });
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(680).setHeight(620),
    'Auto Attendance');
}

/**
 * The other files this one leans on that are older than it, by name.
 *
 * Files go into Apps Script one at a time, by hand, so it is easy to update
 * this one and miss one of them -- and what Apps Script says then is
 * "radiusPostForm_ is not defined", which names a function nobody has heard
 * of rather than the file to copy again. Each check is on something only the
 * current version of that file has. `typeof` is used because it answers
 * "undefined" for a name that does not exist at all, where reading the name
 * would throw.
 */
function attendanceOutOfDateFiles_() {
  const stale = [];
  if (typeof CONFIG !== 'object' || !CONFIG.RADIUS || !CONFIG.RADIUS.ATTENDANCE ||
      !CONFIG.RADIUS.ATTENDANCE.OK_COLOR) {
    stale.push('Config.gs');
  }
  if (typeof radiusPostForm_ !== 'function' || typeof formEncode_ !== 'function') {
    stale.push('Radius.gs');
  }
  if (typeof leadingTimeOf_ !== 'function' || typeof slotMinutes_ !== 'function') {
    stale.push('Common.gs');
  }
  if (typeof dayHeaderRows_ !== 'function' || typeof wopSheet_ !== 'function') {
    stale.push('Day.gs');
  }
  if (typeof looksLikeShiftTitle_ !== 'function' || typeof parseTypedDate_ !== 'function') {
    stale.push('Schedule.gs');
  }
  return stale;
}

/** True when everything is current; otherwise says which files to copy again. */
function attendanceReady_() {
  const stale = attendanceOutOfDateFiles_();
  if (!stale.length) return true;
  showError_('Auto Attendance needs a newer copy of ' + stale.join(', ') +
    ' than this spreadsheet has. Copy ' + (stale.length > 1 ? 'them' : 'it') +
    ' again from the repo, replacing everything in the file, then save and ' +
    'reload the spreadsheet. Nothing was changed.');
  return false;
}

/** Menu entry: today, so far. */
function radiusAttendanceToday() {
  if (!attendanceReady_()) return;
  showAttendanceFor_(new Date());
}

/** Menu entry: the same, for a day you type in. */
function radiusAttendancePickDay() {
  if (!attendanceReady_()) return;
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('Auto Attendance: pick a day',
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
