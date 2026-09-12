/**
 * Radius import.
 *
 * Fetches the Instruction Manager page, which lists today's checked-in
 * students and carries a "DWP 2.0" link on each row. That link already holds
 * every id the DWP page needs, so nothing has to be catalogued or derived --
 * the roster is fetched once, names are matched against column A of the
 * highlighted Daily WOP rows, and each student's DWP page is read from the
 * link on their own row.
 *
 * One piece is still unfinished, marked NEEDS HTML below: RADIUS_EXTRACTORS,
 * which pulls the actual values out of a DWP page. It fails with an
 * explanation rather than writing a wrong value.
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

// ------------------------------------------------------------------
// HTML helpers
//
// Apps Script has no DOM parser, so this is string work. It is kept narrow on
// purpose: find rows, find cells, read their text and links.
// ------------------------------------------------------------------

function decodeHtmlEntities_(text) {
  return String(text)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, function (whole, code) {
      return String.fromCharCode(Number(code));
    });
}

/** Visible text of a table cell, tags and whitespace stripped out. */
function htmlCellText_(cellHtml) {
  return decodeHtmlEntities_(
    String(cellHtml)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

function absoluteRadiusUrl_(href) {
  const url = decodeHtmlEntities_(String(href).trim());
  if (/^https?:\/\//i.test(url)) return url;
  if (url.charAt(0) === '/') return CONFIG.RADIUS.BASE_URL + url;
  return CONFIG.RADIUS.BASE_URL + '/' + url;
}

/**
 * Names are compared loosely, because the roster and the Daily WOP sheet are
 * typed by different people. Case and spacing are ignored, and "Doe, Jane" is
 * treated as "Jane Doe".
 */
function normalizeStudentName_(name) {
  let text = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  if (text.indexOf(',') !== -1) {
    const parts = text.split(',');
    if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
      text = parts[1].trim() + ' ' + parts[0].trim();
    }
  }
  return text.toLowerCase();
}

function splitTableCells_(rowHtml) {
  const cells = [];
  const pattern = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let match;
  while ((match = pattern.exec(rowHtml)) !== null) cells.push(match[1]);
  return cells;
}

/** Pulls a DWP link out of a chunk of row HTML, href or onclick alike. */
function findDwpLink_(html) {
  const direct = String(html).match(/href\s*=\s*["']([^"']*\/DWP\/[^"']*)["']/i);
  if (direct) return absoluteRadiusUrl_(direct[1]);

  const loose = String(html).match(/((?:https?:\/\/[^\s"'<>]+)?\/DWP\/Index\?[^\s"'<>]+)/i);
  if (loose) return absoluteRadiusUrl_(loose[1]);

  return null;
}

// ------------------------------------------------------------------
// The Instruction Manager roster
// ------------------------------------------------------------------

/**
 * Reads the Instruction Manager table into a name -> DWP link lookup.
 *
 * Columns are located by their header text rather than by position, so
 * reordering them on the Radius side does not break this.
 */
function parseInstructionManager_(html) {
  const rows = [];
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowPattern.exec(html)) !== null) rows.push(match[1]);

  if (!rows.length) {
    throw new Error('No table rows found on the Instruction Manager page. Check ' +
      'that CONFIG.RADIUS.INSTRUCTION_MANAGER_URL points at the right page.');
  }

  let nameIndex = -1;
  let dwpIndex = -1;
  let headerRow = -1;

  for (let r = 0; r < rows.length && headerRow === -1; r++) {
    const cells = splitTableCells_(rows[r]).map(htmlCellText_);
    for (let c = 0; c < cells.length; c++) {
      if (/student\s*name/i.test(cells[c])) nameIndex = c;
      if (/dwp/i.test(cells[c])) dwpIndex = c;
    }
    if (nameIndex !== -1) headerRow = r;
    else { nameIndex = -1; dwpIndex = -1; }
  }

  if (headerRow === -1) {
    throw new Error('Could not find a "Student Name" column on the Instruction ' +
      'Manager page. Its layout may have changed.');
  }

  const byName = {};
  let withLink = 0;
  let withoutLink = 0;

  for (let r = headerRow + 1; r < rows.length; r++) {
    const cells = splitTableCells_(rows[r]);
    if (cells.length <= nameIndex) continue;

    const name = htmlCellText_(cells[nameIndex]);
    if (!name) continue;

    // Prefer the DWP column, but fall back to anywhere in the row -- the link
    // is unmistakable wherever it sits.
    const url = (dwpIndex !== -1 && cells.length > dwpIndex
      ? findDwpLink_(cells[dwpIndex])
      : null) || findDwpLink_(rows[r]);

    if (url) withLink++; else withoutLink++;
    byName[normalizeStudentName_(name)] = { name: name, url: url };
  }

  return { byName: byName, withLink: withLink, withoutLink: withoutLink };
}

/** Fetches and parses the roster. One request, however many students. */
function loadInstructionManager_() {
  const url = String(CONFIG.RADIUS.INSTRUCTION_MANAGER_URL || '').trim();
  if (!url) {
    throw new Error('Set CONFIG.RADIUS.INSTRUCTION_MANAGER_URL in Config.gs to the ' +
      'address of the Instruction Manager page, then run this again.');
  }
  return parseInstructionManager_(radiusFetch_(url));
}

/** Finds a Daily WOP name on the roster, and says why if it is not there. */
function lookupRosterEntry_(roster, name) {
  const entry = roster.byName[normalizeStudentName_(name)];
  if (!entry) {
    throw new Error('not on the Instruction Manager — have they checked in yet, ' +
      'and is the name spelled the same way in both places?');
  }
  if (!entry.url) {
    throw new Error('is on the Instruction Manager but has no DWP 2.0 link yet.');
  }
  return entry;
}

// ------------------------------------------------------------------
// Pulling values off a DWP page
// ------------------------------------------------------------------

/**
 * Field-level HTML helpers.
 *
 * These work on the raw markup, so they are written to be position-independent
 * about attribute order and tolerant of an attribute simply being absent --
 * which is how this page represents "no value yet".
 */

function escapeForRegex_(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The whole <input> tag carrying a given id, or null. */
function inputTagById_(html, id) {
  const match = String(html).match(
    new RegExp('<input\\b[^>]*\\bid="' + escapeForRegex_(id) + '"[^>]*>', 'i'));
  return match ? match[0] : null;
}

/**
 * An input's value attribute. Returns null when the tag is missing entirely,
 * and '' when the tag is there but carries no value -- the page omits the
 * attribute rather than writing value="", so the two are worth telling apart.
 */
function inputValueById_(html, id) {
  const tag = inputTagById_(html, id);
  if (!tag) return null;
  const value = tag.match(/\bvalue="([^"]*)"/i);
  return value ? decodeHtmlEntities_(value[1]).trim() : '';
}

/** True when a tag carries a bare or assigned checked attribute. */
function tagIsChecked_(tag) {
  return /(^|\s)checked(\s|=|\/|>)/i.test(String(tag));
}

function textareaContentById_(html, id) {
  const match = String(html).match(
    new RegExp('<textarea\\b[^>]*\\bid="' + escapeForRegex_(id) +
      '"[^>]*>([\\s\\S]*?)<\\/textarea>', 'i'));
  return match ? decodeHtmlEntities_(match[1]).trim() : null;
}

/**
 * The state of a tri-state switch.
 *
 * The switch's radios carry no checked attribute; the server passes the value
 * as the third argument of a loadButtons call instead:
 *
 *     loadButtons("divWrapUp", "Deck1NeedsUpdate", 1);
 *
 * On an untouched switch that argument is empty. NEEDS VERIFYING against a
 * page where a switch is actually set -- the sample available showed only the
 * empty form, so the truthy spelling (1, true, True) is inferred from the
 * radio values on the control rather than observed.
 */
function tripleSwitchRaw_(html, fieldName) {
  const match = String(html).match(new RegExp(
    'loadButtons\\(\\s*"[^"]*"\\s*,\\s*"' + escapeForRegex_(fieldName) +
    '"\\s*,([^)]*)\\)', 'i'));
  return match ? match[1].trim().replace(/^["\']|["\']$/g, '') : null;
}

function tripleSwitchLabel_(raw) {
  if (raw === null) return null;
  const value = String(raw).trim().toLowerCase();
  if (value === '' || value === 'null' || value === 'undefined') return '';
  if (value === '1' || value === 'true') return 'Yes';
  if (value === '0' || value === 'false') return 'No';
  return raw;
}

/** The learning-plan assignment rows, as raw row HTML. */
function dwpAssignmentRows_(html) {
  const body = String(html).match(
    /<tbody[^>]*\bid="dwpPKsBody"[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!body) return [];

  const rows = [];
  const pattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = pattern.exec(body[1])) !== null) rows.push(match[1]);
  return rows;
}

/** Whether a row's WO / CM / CBNM checkbox is ticked. */
function assignmentCheckboxChecked_(rowHtml, suffix) {
  const tag = String(rowHtml).match(
    new RegExp('<input\\b[^>]*\\bid="[^"]*' + escapeForRegex_(suffix) + '[^"]*"[^>]*>', 'i'));
  return tag ? tagIsChecked_(tag[0]) : false;
}

/** The student the page is actually about, read from its title. */
function pageStudentName_(html) {
  const match = String(html).match(/<title>([\s\S]*?)<\/title>/i);
  return match ? decodeHtmlEntities_(match[1]).trim() : '';
}

// ------------------------------------------------------------------
// Pulling values off a DWP page
// ------------------------------------------------------------------

/**
 * One entry per CONFIG.RADIUS.FIELDS key. Each takes the DWP page HTML and
 * returns the value, or null when the page genuinely has no value for it.
 *
 * A missing element throws, because that means the page changed shape and a
 * wrong value is worse than a loud failure. An element that is present but
 * empty returns '' -- that is a real answer, not a fault.
 */
const RADIUS_EXTRACTORS = {

  /** Cool Down -> Pages Completed. */
  pagesCompleted: function (html) {
    const value = inputValueById_(html, 'NumberOfPagesCompleted');
    if (value === null) {
      throw new Error('could not find the Pages Completed field on the DWP page.');
    }
    return value;
  },

  /** Cool Down -> Primary Deck -> Needs deck update. */
  deckNeedsUpdate: function (html) {
    const raw = tripleSwitchRaw_(html, 'Deck1NeedsUpdate');
    if (raw === null) {
      throw new Error('could not find the "Needs deck update" switch on the DWP page.');
    }
    return tripleSwitchLabel_(raw);
  },

  /** Header -> End. Present means the student has been signed out. */
  signedOut: function (html) {
    const endTime = inputValueById_(html, 'SessionEndTime');
    if (endTime === null) {
      throw new Error('could not find the session End time field on the DWP page.');
    }
    return endTime ? endTime : 'No';
  },

  /**
   * The finalize timestamp is injected into a script constant; empty means
   * the DWP has not been finalized.
   */
  finalized: function (html) {
    const match = String(html).match(/const\s+finalizedDate\s*=\s*'([^']*)'/);
    if (!match) {
      throw new Error('could not find the finalized marker on the DWP page.');
    }
    return match[1].trim() ? 'Yes' : 'No';
  },

  /** Session -> the learning-plan rows whose "Worked On" box is ticked. */
  topicsWorkedOn: function (html) {
    const rows = dwpAssignmentRows_(html);
    if (!rows.length) return '';

    const worked = [];
    rows.forEach(function (row) {
      if (!assignmentCheckboxChecked_(row, '_WO_checkbox')) return;
      const cells = splitTableCells_(row);
      // Row shape: [marker, PK code, topic, WO, C&M, CBNM].
      const topic = htmlCellText_(cells[2] === undefined ? '' : cells[2]);
      const code = htmlCellText_(cells[1] === undefined ? '' : cells[1]);
      worked.push(topic || code || '(unnamed)');
    });
    return worked.join('; ');
  },

  /** Session -> Problem of the Week switch. */
  problemOfTheWeek: function (html) {
    const raw = tripleSwitchRaw_(html, 'ProblemOfTheWeek');
    if (raw === null) {
      throw new Error('could not find the Problem of the Week switch on the DWP page.');
    }
    return tripleSwitchLabel_(raw);
  },

  /**
   * Session Summary Notes appear twice, once on the Session tab and once on
   * Cool Down, kept in step by the page's own script. Either will do; take
   * whichever actually holds text.
   */
  sessionSummary: function (html) {
    const first = textareaContentById_(html, 'SessionNotes-0');
    const second = textareaContentById_(html, 'SessionNotes-1');
    if (first === null && second === null) {
      throw new Error('could not find the Session Summary Notes field on the DWP page.');
    }
    return first || second || '';
  },

  /** Internal Notes, likewise duplicated across the two tabs. */
  internalNotes: function (html) {
    const first = textareaContentById_(html, 'NotesForCenterDirector-0');
    const second = textareaContentById_(html, 'NotesForCenterDirector-1');
    if (first === null && second === null) {
      throw new Error('could not find the Internal Notes field on the DWP page.');
    }
    return first || second || '';
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

/** Menu entry: checks the cookie and the roster without touching the sheet. */
function testRadiusConnection() {
  try {
    const roster = loadInstructionManager_();
    const total = roster.withLink + roster.withoutLink;
    showError_('Connected to Radius. The Instruction Manager lists ' + total +
      ' student(s), ' + roster.withLink + ' with a DWP 2.0 link' +
      (roster.withoutLink ? ' and ' + roster.withoutLink + ' without one yet' : '') + '.');
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
  const stats = { imported: 0, failed: 0 };
  const columns = {};

  try {
    const nameCol = WopColumn_(sheets.wop, selection.startRow, selection.numRows,
      CONFIG.WOP_COL.NAME);
    CONFIG.RADIUS.FIELDS.forEach(function (field) {
      columns[field.key] = WopColumn_(sheets.wop, selection.startRow,
        selection.numRows, field.column);
    });

    const roster = loadInstructionManager_();

    for (let i = 0; i < selection.numRows; i++) {
      if (Date.now() - started > CONFIG.RADIUS.MAX_RUNTIME_MS) {
        log.warn('Run stopped', 'Approaching the 6-minute limit after ' +
          stats.imported + ' student(s). Everything fetched so far has been ' +
          'saved — highlight the remaining rows and run it again.');
        break;
      }

      const name = extractName_(nameCol.value(i));
      if (!name) continue;

      try {
        const entry = lookupRosterEntry_(roster, name);
        const html = radiusFetch_(entry.url);

        // Guard against a mislinked roster row writing another student's data
        // into this row. The page names the student it belongs to.
        const pageName = pageStudentName_(html);
        if (pageName && normalizeStudentName_(pageName) !== normalizeStudentName_(name)) {
          throw new Error('the roster link opened the DWP for "' + pageName +
            '" instead. Nothing was written for this row.');
        }

        const results = extractRadiusFields_(html);

        results.forEach(function (result) {
          columns[result.field.key].setValue(i, result.value);
        });

        stats.imported++;
        log.ok(name, results.map(function (r) {
          return r.field.label + ': ' + (r.value === '' ? '(blank)' : r.value);
        }).join(', '));
      } catch (err) {
        stats.failed++;
        log.error(name, err.message);
      }

      Utilities.sleep(CONFIG.RADIUS.FETCH_DELAY_MS);
    }
  } catch (err) {
    log.error('Run stopped', err.message);
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
    { label: 'Failed', value: stats.failed, alert: stats.failed > 0 },
    { label: 'Columns written',
      value: CONFIG.RADIUS.FIELDS.map(function (f) {
        return columnLetter_(f.column);
      }).join(', ') }
  ], log);
}
