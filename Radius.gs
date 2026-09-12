/**
 * Radius import (experimental).
 *
 * Reads student names from column A of the highlighted Daily WOP rows, looks
 * each one up on radius.mathnasium.com, and writes values pulled off their DWP
 * page into the columns listed in CONFIG.RADIUS.FIELDS.
 *
 * Two pieces are deliberately unfinished, both marked NEEDS HTML below:
 *   - resolveRadiusSession_, which has to find today's attendanceId and
 *     dwpEntryId for a student. Those are almost certainly created fresh at
 *     each visit, so they cannot simply be catalogued -- this needs whatever
 *     roster or attendance page lists today's sessions.
 *   - RADIUS_EXTRACTORS, which pulls the actual values out of the page.
 *
 * Both fail loudly with an explanation rather than writing a wrong value.
 */

// ------------------------------------------------------------------
// Session cookie
// ------------------------------------------------------------------

/** Menu entry: stores the session cookie without going near Project Settings. */
function setRadiusCookie() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('Radius session cookie',
    'In a browser logged in to Radius, open DevTools → Application → Cookies, ' +
    'and copy the whole cookie string for radius.mathnasium.com.\n\n' +
    'It is stored in this script\'s properties, not in the spreadsheet, and is ' +
    'not visible to people you share the sheet with.',
    ui.ButtonSet.OK_CANCEL);

  if (response.getSelectedButton() !== ui.Button.OK) return;

  const cookie = String(response.getResponseText()).trim();
  if (!cookie) {
    showError_('Nothing entered — the stored cookie was left as it was.');
    return;
  }

  PropertiesService.getScriptProperties()
    .setProperty(CONFIG.RADIUS.COOKIE_PROPERTY, cookie);
  showError_('Cookie saved. Run Radius → Test connection to check it works.');
}

function radiusCookie_() {
  const cookie = PropertiesService.getScriptProperties()
    .getProperty(CONFIG.RADIUS.COOKIE_PROPERTY);
  if (!cookie) {
    throw new Error('No Radius session cookie stored. Run Radius → Set session ' +
      'cookie first.');
  }
  return cookie;
}

/**
 * A logged-out request gets the sign-in page back with a perfectly normal 200,
 * so the status code alone cannot be trusted.
 */
function looksLikeLoginPage_(html, url) {
  const text = String(html).toLowerCase();
  if (/<form[^>]+action="[^"]*(account\/login|signin|log-?in)/.test(text)) return true;
  if (/name="password"/.test(text) && /name="(username|email)"/.test(text)) return true;
  if (/\/account\/login/.test(String(url).toLowerCase())) return true;
  return false;
}

/** Fetches one Radius page as the logged-in user. */
function radiusFetch_(url) {
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Cookie: radiusCookie_() },
    muteHttpExceptions: true,
    followRedirects: true
  });

  const status = response.getResponseCode();
  const html = response.getContentText();

  if (status === 401 || status === 403) {
    throw new Error('Radius rejected the session cookie (HTTP ' + status +
      '). Log in again and re-run Radius → Set session cookie.');
  }
  if (status >= 400) {
    throw new Error('Radius returned HTTP ' + status + ' for ' + url);
  }
  if (looksLikeLoginPage_(html, url)) {
    throw new Error('Radius returned the sign-in page, so the stored cookie has ' +
      'expired. Log in again and re-run Radius → Set session cookie.');
  }
  return html;
}

function dwpUrl_(session) {
  const r = CONFIG.RADIUS;
  return r.BASE_URL + '/DWP/Index' +
    '?studentId=' + encodeURIComponent(session.studentId) +
    '&attendanceId=' + encodeURIComponent(session.attendanceId) +
    '&centerId=' + encodeURIComponent(r.CENTER_ID) +
    '&dwpEntryId=' + encodeURIComponent(session.dwpEntryId);
}

// ------------------------------------------------------------------
// Finding today's session for a student
// ------------------------------------------------------------------

/**
 * Reads the cached studentId lookup. Sheet layout: name in column A,
 * Radius studentId in column B, row 1 a header.
 */
function loadRadiusIds_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(CONFIG.RADIUS.ID_SHEET);
  if (!sheet) return {};

  const values = sheet.getDataRange().getValues();
  const index = {};
  for (let r = 1; r < values.length; r++) {
    const name = String(values[r][0]).trim().toLowerCase();
    const id = String(values[r][1]).trim();
    if (name && id) index[name] = id;
  }
  return index;
}

/**
 * NEEDS HTML.
 *
 * Has to return { studentId, attendanceId, dwpEntryId } for this student's
 * session today. studentId comes from the cache; the other two are per-visit
 * and have to be read off whatever page lists today's attendance.
 */
function resolveRadiusSession_(name, idTable) {
  const studentId = idTable[String(name).trim().toLowerCase()];
  if (!studentId) {
    throw new Error('No Radius studentId cached for this name. Add a row to the "' +
      CONFIG.RADIUS.ID_SHEET + '" sheet: name in column A, studentId in column B.');
  }

  throw new Error('Cannot work out today\'s attendanceId and dwpEntryId yet — ' +
    'resolveRadiusSession_ in Radius.gs still needs the HTML of the page that ' +
    'lists today\'s sessions.');
}

// ------------------------------------------------------------------
// Pulling values off a DWP page
// ------------------------------------------------------------------

/**
 * NEEDS HTML.
 *
 * One entry per CONFIG.RADIUS.FIELDS key. Each takes the DWP page HTML and
 * returns the value, or null when the page genuinely has no value for it --
 * which is different from a broken selector, so throw for that instead.
 *
 * Apps Script has no DOM parser, so these are regexes over the raw HTML. If
 * the value turns out to arrive by a JSON/XHR call instead, fetching that
 * endpoint directly will be far steadier than scraping the markup.
 */
const RADIUS_EXTRACTORS = {
  testValue: function (html) {
    throw new Error('The extractor for "testValue" has not been written yet — ' +
      'RADIUS_EXTRACTORS in Radius.gs needs a sample of the DWP page HTML.');
  }
};

/** Runs every configured extractor over one page. */
function extractRadiusFields_(html) {
  return CONFIG.RADIUS.FIELDS.map(function (field) {
    const extractor = RADIUS_EXTRACTORS[field.key];
    if (!extractor) {
      throw new Error('No extractor defined for field "' + field.key + '".');
    }
    const value = extractor(html);
    return { field: field, value: value === null || value === undefined ? '' : value };
  });
}

// ------------------------------------------------------------------
// Menu entries
// ------------------------------------------------------------------

/** Menu entry: confirms the cookie works without touching the spreadsheet. */
function testRadiusConnection() {
  try {
    radiusFetch_(CONFIG.RADIUS.BASE_URL + '/');
    showError_('Connected to Radius successfully — the stored cookie is valid.');
  } catch (err) {
    showError_(err.message);
  }
}

/**
 * Menu entry: imports values for the highlighted Daily WOP rows.
 *
 * Nothing is written until every row has been attempted, so a failure part way
 * through does not leave half the selection filled in.
 */
function importRadiusData() {
  const started = Date.now();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    showError_('Someone else is running a batch on this spreadsheet right now.');
    return;
  }

  let sheets;
  let selection;
  try {
    sheets = getSheets_();
    selection = getSelection_(sheets.wop);
  } catch (err) {
    lock.releaseLock();
    showError_(err.message);
    return;
  }

  const log = ActionLog_();
  const stats = { imported: 0, skipped: 0, stoppedEarly: false };
  const columns = {};

  try {
    const nameCol = WopColumn_(sheets.wop, selection.startRow, selection.numRows,
      CONFIG.WOP_COL.NAME);
    CONFIG.RADIUS.FIELDS.forEach(function (field) {
      columns[field.key] = WopColumn_(sheets.wop, selection.startRow,
        selection.numRows, field.column);
    });

    const idTable = loadRadiusIds_();

    for (let i = 0; i < selection.numRows; i++) {
      if (Date.now() - started > CONFIG.RADIUS.MAX_RUNTIME_MS) {
        stats.stoppedEarly = true;
        log.warn('Run stopped', 'Approaching the 6-minute limit after ' +
          stats.imported + ' student(s). Everything fetched so far has been ' +
          'saved — highlight the remaining rows and run it again.');
        break;
      }

      const name = extractName_(nameCol.value(i));
      if (!name) continue;

      try {
        const session = resolveRadiusSession_(name, idTable);
        const html = radiusFetch_(dwpUrl_(session));
        const results = extractRadiusFields_(html);

        results.forEach(function (result) {
          columns[result.field.key].setValue(i, result.value);
        });

        stats.imported++;
        log.ok(name, results.map(function (r) {
          return r.field.label + ': ' + (r.value === '' ? '(blank)' : r.value);
        }).join(', '));
      } catch (err) {
        stats.skipped++;
        log.error(name, err.message);
      }

      Utilities.sleep(CONFIG.RADIUS.FETCH_DELAY_MS);
    }
  } catch (err) {
    log.error('Run stopped', 'Unexpected error: ' + err.message);
  } finally {
    try {
      Object.keys(columns).forEach(function (key) { columns[key].flush(); });
    } catch (flushErr) {
      log.error('Save failed', 'Could not write values back: ' + flushErr.message);
    }
    lock.releaseLock();
  }

  if (log.isEmpty()) {
    showError_('Nothing to import — no student names found in the highlighted rows.');
    return;
  }

  showReport_('Radius Import', '🔗 Import Summary', [
    { label: 'Students imported', value: stats.imported },
    { label: 'Failed', value: stats.skipped, alert: stats.skipped > 0 },
    { label: 'Columns written',
      value: CONFIG.RADIUS.FIELDS.map(function (f) {
        return columnLetter_(f.column);
      }).join(', ') }
  ], log);
}
