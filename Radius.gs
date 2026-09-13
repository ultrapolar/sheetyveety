/**
 * Radius import.
 *
 * Asks Radius for the Instruction Manager's roster, which lists the centre's
 * students along with the ids each "DWP 2.0" link is built from, so nothing
 * has to be catalogued or derived. The roster is fetched once, names are
 * matched against column A of the highlighted Daily WOP rows, and each
 * student's own DWP page is read.
 *
 * Note that the Instruction Manager *page* is not what gets fetched. Its
 * student grid is assembled in the browser out of localStorage, so the HTML
 * that arrives over the wire holds the column definitions and not one
 * student. The roster comes from the endpoint that grid is filled from.
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
 * Pulls something readable out of a failed response.
 *
 * Three different things can come back, and quoting the wrong part of the
 * wrong one is worse than saying nothing: a rendered Radius page opens with
 * several hidden modals about billing dates that are present on every page,
 * so the first few hundred characters of one read exactly like a real
 * complaint about billing while having nothing to do with the failure.
 */
function serverComplaint_(body) {
  const raw = String(body || '');

  // ASP.NET's own error page states the fault in an <h2><i>...</i></h2>.
  const detail = raw.match(/<h2>\s*<i>([\s\S]*?)<\/i>\s*<\/h2>/i);
  if (detail) return '\n\nRadius said: ' + shorten_(htmlCellText_(detail[1]), 300);

  // Otherwise a whole page means the detail is behind a custom error page.
  if (/<html|<!doctype/i.test(raw)) {
    const title = raw.match(/<title>([\s\S]*?)<\/title>/i);
    return '\n\nRadius sent back a web page' +
      (title ? ' titled "' + htmlCellText_(title[1]) + '"' : '') +
      ' instead of data, so it is hiding the reason behind its own error page.';
  }

  const text = htmlCellText_(raw);
  return text ? '\n\nRadius said: ' + shorten_(text, 300) : '';
}

/**
 * ASP.NET pairs an antiforgery cookie with a token rendered into the page, and
 * rejects a request that brings the cookie without its partner -- as an
 * unhandled exception, so it surfaces as a 500 rather than a 403. Radius puts
 * the token in a hidden field on every page, which is where the browser gets
 * it too.
 *
 * A page we cannot read a token out of is not worth failing over: the request
 * may not need one. Go without and let the request itself say.
 */
function radiusVerificationToken_() {
  const url = String(CONFIG.RADIUS.TOKEN_PAGE_URL || '').trim();
  if (!url) return '';

  let html;
  try { html = radiusFetch_(url); } catch (err) { return ''; }

  const tag = html.match(/<input\b[^>]*__RequestVerificationToken[^>]*>/i);
  if (!tag) return '';
  const value = tag[0].match(/\bvalue="([^"]*)"/i);
  return value ? value[1] : '';
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
    throw new Error('Radius returned HTTP ' + status + ' for ' + url +
      serverComplaint_(html));
  }
  if (looksLikeLoginPage_(html, url)) {
    throw new Error('Radius returned the sign-in page, so the stored cookie has ' +
      'expired. Log in again and re-run Radius → Set session cookie.');
  }
  return html;
}

/**
 * Posts a JSON body to Radius and hands back the decoded reply.
 *
 * Radius answers these with JSON, so anything else coming back -- an HTML page,
 * an empty body -- means the request did not reach the endpoint as a signed-in
 * user, whatever the status code claims.
 */
function radiusPostJson_(url, payload) {
  const token = radiusVerificationToken_();
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    payload: JSON.stringify(payload),
    headers: Object.assign({
      Cookie: radiusCookie_(),
      // Radius reaches this endpoint through jQuery's $.ajax, and ASP.NET MVC
      // decides whether a request is an AJAX call by looking for these. A
      // controller written for the AJAX path can fail outright without them.
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01'
    }, token ? { '__RequestVerificationToken': token } : {}),
    muteHttpExceptions: true,
    followRedirects: true
  });

  const status = response.getResponseCode();
  const body = response.getContentText();

  if (status === 401 || status === 403) {
    throw new Error('Radius rejected the session cookie (HTTP ' + status +
      '). Log in again and re-run Radius → Set session cookie.');
  }
  if (status >= 400) {
    throw new Error('Radius returned HTTP ' + status + ' for ' + url +
      serverComplaint_(body));
  }
  if (looksLikeLoginPage_(body, url)) {
    throw new Error('Radius returned the sign-in page, so the stored cookie has ' +
      'expired. Log in again and re-run Radius → Set session cookie.');
  }

  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error('Radius did not return data for ' + url + '. The stored ' +
      'cookie has most likely expired — log in again and re-run ' +
      'Radius → Set session cookie.');
  }
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

// ------------------------------------------------------------------
// The Instruction Manager roster
// ------------------------------------------------------------------

/**
 * Builds the DWP 2.0 address for one roster entry.
 *
 * The four ids come straight from the roster, which is how the page itself
 * builds this link. No id is derived or guessed.
 */
function dwpUrl_(row) {
  if (!row.AttendanceId || !row.DWPEntryId) return null;
  return CONFIG.RADIUS.BASE_URL + '/DWP/Index' +
    '?studentId=' + encodeURIComponent(row.StudentId) +
    '&attendanceId=' + encodeURIComponent(row.AttendanceId) +
    '&centerId=' + encodeURIComponent(row.CenterId) +
    '&dwpEntryId=' + encodeURIComponent(row.DWPEntryId);
}

/**
 * Turns the roster reply into a name -> DWP link lookup.
 *
 * The Instruction Manager *page* is no use for this. Its student grid is built
 * in the browser out of localStorage, so the HTML that arrives over the wire
 * carries the column definitions and not one student -- there is nothing to
 * scrape. The grid is filled from this endpoint, so we ask it directly, and it
 * hands over the ids rather than a rendered link.
 */
function parseRoster_(data) {
  if (!data || String(data.Status || '') !== 'Success') {
    throw new Error('The Instruction Manager roster came back without data' +
      (data && data.Message ? ' (' + data.Message + ')' : '') +
      '. Check that CONFIG.RADIUS.CENTER_ID is your centre number.');
  }

  const rows = data.DataSource || [];
  const byName = {};
  let withLink = 0;
  let withoutLink = 0;

  rows.forEach(function (row) {
    const name = String(row.StudentName || '').trim();
    if (!name) return;

    const key = normalizeStudentName_(name);

    // Two students sharing a name cannot be told apart from a Daily WOP row,
    // and the DWP page would confirm either of them, so neither is safe.
    if (byName[key]) {
      byName[key].ambiguous = true;
      return;
    }

    const url = dwpUrl_(row);
    if (url) withLink++; else withoutLink++;

    byName[key] = {
      name: name,
      url: url,
      checkedIn: Boolean(row.AttendanceId),
      ambiguous: false
    };
  });

  return { byName: byName, withLink: withLink, withoutLink: withoutLink };
}

/** Fetches the roster. One request, however many students. */
function loadRoster_() {
  const url = String(CONFIG.RADIUS.ROSTER_URL || '').trim();
  if (!url) {
    throw new Error('Set CONFIG.RADIUS.ROSTER_URL in Config.gs, then run this again.');
  }
  const centers = String(CONFIG.RADIUS.CENTER_ID || '').trim();
  if (!centers) {
    throw new Error('Set CONFIG.RADIUS.CENTER_ID in Config.gs to your centre ' +
      'number, then run this again.');
  }
  return parseRoster_(radiusPostJson_(url, { centers: centers }));
}

/** Finds a Daily WOP name on the roster, and says why if it is not usable. */
function lookupRosterEntry_(roster, name) {
  const entry = roster.byName[normalizeStudentName_(name)];
  if (!entry) {
    throw new Error('not on the Instruction Manager — is the name spelled the ' +
      'same way in both places, and is CONFIG.RADIUS.CENTER_ID the right centre?');
  }
  if (entry.ambiguous) {
    throw new Error('matches more than one student on the Instruction Manager, ' +
      'so there is no way to tell which session is theirs.');
  }
  if (!entry.checkedIn) {
    throw new Error('is on the Instruction Manager but has not checked in.');
  }
  if (!entry.url) {
    throw new Error('has checked in but has no DWP 2.0 yet.');
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

/**
 * A textarea's text.
 *
 * Radius puts the content in a value attribute on the tag rather than between
 * the tags, which is not how a textarea normally works:
 *
 *     <textarea id="SessionNotes-0" ... value="She flew so high"></textarea>
 *
 * Reading only the inner content returns '' for a note that is plainly there,
 * and '' is a legitimate "nothing written" answer -- so the mistake would be
 * silent rather than loud. Prefer the attribute, fall back to the inner text.
 */
function textareaContentById_(html, id) {
  const match = String(html).match(
    new RegExp('<textarea\\b[^>]*\\bid="' + escapeForRegex_(id) +
      '"[^>]*>([\\s\\S]*?)<\\/textarea>', 'i'));
  if (!match) return null;

  const openTag = match[0].match(/<textarea\b[^>]*>/i);
  if (openTag) {
    const value = openTag[0].match(/\bvalue="([^"]*)"/i);
    if (value) return decodeHtmlEntities_(value[1]).trim();
  }
  return decodeHtmlEntities_(match[1]).trim();
}

/**
 * The state of a tri-state switch.
 *
 * The switch's radios carry no checked attribute; the server passes the value
 * as the third argument of a loadButtons call instead:
 *
 *     loadButtons("divWrapUp", "Deck1NeedsUpdate", 1);
 *
 * On an untouched switch that argument is empty. Confirmed against a real
 * filled-in page: a switch answered No renders 0. The 1 spelling for Yes is
 * taken from the radio values on the control and matches, but has not itself
 * been seen in the wild, so unrecognised values are passed through unchanged
 * rather than forced into a Yes/No.
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

/** The value of whichever radio in a same-named group is ticked, or ''. */
function checkedRadioValue_(html, name) {
  const pattern = new RegExp(
    '<input\\b[^>]*\\bname="' + escapeForRegex_(name) + '"[^>]*>', 'gi');
  let match;
  while ((match = pattern.exec(html)) !== null) {
    if (!tagIsChecked_(match[0])) continue;
    const value = match[0].match(/\bvalue="([^"]*)"/i);
    return value ? decodeHtmlEntities_(value[1]).trim() : '';
  }
  return '';
}

/**
 * The label text of whichever ticked radio has a name starting with a prefix.
 *
 * The assessment options each carry their own name (AssessmentStatusId-1,
 * -2, ...) rather than sharing one, so they are matched by prefix and read
 * back through the label rather than the opaque numeric value.
 */
function checkedRadioLabel_(html, namePrefix) {
  const pattern = /<input\b[^>]*\btype="radio"[^>]*>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const tag = match[0];
    const name = tag.match(/\bname="([^"]*)"/i);
    if (!name || name[1].indexOf(namePrefix) !== 0) continue;
    if (!tagIsChecked_(tag)) continue;

    const id = tag.match(/\bid="([^"]*)"/i);
    if (!id) return '';
    const label = String(html).match(new RegExp(
      '<label\\b[^>]*\\bfor="' + escapeForRegex_(id[1]) + '"[^>]*>([\\s\\S]*?)<\\/label>', 'i'));
    return label ? htmlCellText_(label[1]) : '';
  }
  return '';
}

/**
 * Folds a letter into whatever column K already holds, rather than replacing
 * it, so a Y typed by hand and a P found on Radius end up as "YP".
 *
 * Refuses to touch a cell carrying one of EOD's markers ("YYP - B empty?",
 * "Y (2 of 3 done, ran out)"): those record outstanding work, and flattening
 * one back to bare letters would lose it.
 */
function mergeStatusLetters_(existing, letter) {
  const current = String(existing == null ? '' : existing).trim();
  const add = String(letter == null ? '' : letter).trim().toUpperCase();

  if (!add) return { value: current, changed: false };
  if (!current) return { value: add, changed: true };
  if (!/^[YP]+$/i.test(current)) {
    return { value: current, changed: false, blocked: true };
  }
  if (current.toUpperCase().indexOf(add) !== -1) {
    return { value: current, changed: false };
  }
  return { value: current.toUpperCase() + add, changed: true };
}

/**
 * A clock time like "10:48 AM" as minutes since midnight, or null if it is
 * not a time at all.
 */
function parseClockTime_(text) {
  const match = String(text == null ? '' : text).trim()
    .match(/^(\d{1,2}):(\d{2})\s*([AaPp])?\.?[Mm]?\.?$/);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  const period = match[3] ? match[3].toUpperCase() : null;
  if (period === 'A' && hours === 12) hours = 0;
  if (period === 'P' && hours !== 12) hours += 12;
  if (hours > 23) return null;

  return hours * 60 + minutes;
}

/**
 * Looks at how long a session actually ran.
 *
 * Sessions are booked on the hour, so a normal one is about an hour and a
 * double about two. A length in neither band is worth a human glance, and the
 * sign-in and sign-out cells are shaded to say so.
 *
 * A short session gets examined further, because there are two ordinary
 * reasons for one and they are worth telling apart: the student arrived well
 * after the hour started, or left well before it ended. Either earns a note;
 * both earn both.
 *
 * Returns { known, durationMinutes, shade, notes }. known is false when either
 * time is missing -- a student still in the centre is not late for anything.
 */
function reviewSessionTiming_(signIn, signOut) {
  const timing = CONFIG.RADIUS.TIMING;
  const start = parseClockTime_(signIn);
  const end = parseClockTime_(signOut);

  if (start === null || end === null) {
    return { known: false, durationMinutes: null, shade: false, notes: [] };
  }

  let duration = end - start;
  if (duration < 0) duration += 24 * 60;

  const isSingle = duration >= timing.SINGLE_MIN && duration <= timing.SINGLE_MAX;
  const isDouble = duration >= timing.DOUBLE_MIN && duration <= timing.DOUBLE_MAX;
  const notes = [];

  if (isDouble) notes.push('2 hour session');

  if (duration < timing.SINGLE_MIN) {
    const lateBy = start % 60;
    if (lateBy >= timing.LATE_AFTER) {
      notes.push('signed in ' + lateBy + ' minutes late');
    }
    // A sign-out exactly on the hour is not early at all.
    const earlyBy = (60 - (end % 60)) % 60;
    if (earlyBy >= timing.EARLY_BEFORE) {
      notes.push('left ' + earlyBy + ' minutes early');
    }
  }

  return {
    known: true,
    durationMinutes: duration,
    shade: !isSingle && !isDouble,
    notes: notes
  };
}

/** "Yes" becomes a bare Y; anything else becomes blank. */
function yesFlag_(label) {
  return String(label).trim().toLowerCase() === 'yes' ? 'Y' : '';
}

/**
 * The PK code as the sheet wants it: "PK-3918-00" on the page becomes
 * "PK3918". The trailing segment is a revision number and is dropped.
 */
function formatPkCode_(cellText) {
  const text = String(cellText).trim();
  const match = text.match(/^([A-Za-z]+)\s*-\s*(\d+)/);
  if (match) return match[1].toUpperCase() + match[2];
  return text.replace(/[^A-Za-z0-9]/g, '');
}

/** Topic names from every assignment row whose given checkbox is ticked. */
function topicsWhereChecked_(html, suffix) {
  const rows = dwpAssignmentRows_(html);
  if (!rows.length) return '';

  const topics = [];
  rows.forEach(function (row) {
    if (!assignmentCheckboxChecked_(row, suffix)) return;
    const cells = splitTableCells_(row);
    // Row shape: [marker, PK code, topic, WO, C&M, CBNM].
    const topic = htmlCellText_(cells[2] === undefined ? '' : cells[2]);
    const code = htmlCellText_(cells[1] === undefined ? '' : cells[1]);
    topics.push(topic || code || '(unnamed)');
  });
  return topics.join('; ');
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

  /** Header -> Start. Blank until the student is signed in. */
  signedIn: function (html) {
    const startTime = inputValueById_(html, 'SessionStartTime');
    if (startTime === null) {
      throw new Error('could not find the session Start time field on the DWP page.');
    }
    return startTime;
  },

  /** Header -> End. Blank until the student is signed out. */
  signedOut: function (html) {
    const endTime = inputValueById_(html, 'SessionEndTime');
    if (endTime === null) {
      throw new Error('could not find the session End time field on the DWP page.');
    }
    return endTime;
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

  /**
   * Yes/no answers as the sheet writes them by hand: a bare Y when true,
   * blank otherwise, to match the Y/P convention already used in column K.
   */
  finalizedFlag: function (html) {
    return yesFlag_(RADIUS_EXTRACTORS.finalized(html));
  },

  problemOfTheWeekFlag: function (html) {
    return yesFlag_(RADIUS_EXTRACTORS.problemOfTheWeek(html));
  },

  /**
   * Needs-deck-update as the letter column K already uses for it.
   *
   * Y, meaning the student worked through their deck and EOD should advance
   * them: archive column B to the history column and pull the next item out
   * of column E. Change this to 'P' if a deck update should instead mark them
   * pink for new paperwork without advancing the task.
   */
  deckNeedsUpdateFlag: function (html) {
    return yesFlag_(RADIUS_EXTRACTORS.deckNeedsUpdate(html)) ? 'Y' : '';
  },

  /** Session -> the learning-plan rows whose "Worked On" box is ticked. */
  topicsWorkedOn: function (html) {
    return topicsWhereChecked_(html, '_WO_checkbox');
  },

  /**
   * Every completed assignment as "PK3918(100)" or "PK3902(0)", comma
   * separated, in the order the learning plan lists them.
   *
   * Mastered scores 100, completed-but-not-mastered scores 0. A row that was
   * only worked on -- neither box ticked -- is left out entirely, so this
   * column is a record of what was finished rather than what was attempted.
   *
   * The page's own script stops both boxes being ticked at once; if one ever
   * slips through, mastered wins.
   */
  masteryScores: function (html) {
    const rows = dwpAssignmentRows_(html);
    if (!rows.length) return '';

    const scored = [];
    rows.forEach(function (row) {
      const mastered = assignmentCheckboxChecked_(row, '_CM_checkbox');
      const notMastered = assignmentCheckboxChecked_(row, '_CBNM_checkbox');
      if (!mastered && !notMastered) return;

      const cells = splitTableCells_(row);
      // Row shape: [marker, PK code, topic, WO, C&M, CBNM].
      const code = formatPkCode_(htmlCellText_(cells[1] === undefined ? '' : cells[1]));
      const topic = htmlCellText_(cells[2] === undefined ? '' : cells[2]);
      scored.push((code || topic || '(unnamed)') + '(' + (mastered ? '100' : '0') + ')');
    });
    return scored.join(', ');
  },

  /**
   * Everything finished this session in one cell: the mastery scores, then
   * the assessment status if one was given. Comma separated throughout, so
   * it reads as a single list.
   */
  masteryAndAssessment: function (html) {
    const parts = [];
    const mastery = RADIUS_EXTRACTORS.masteryScores(html);
    if (mastery) parts.push(mastery);
    const assessment = RADIUS_EXTRACTORS.assessmentStatus(html);
    if (assessment) parts.push(assessment);
    return parts.join(', ');
  },

  /**
   * The same two columns as plain topic names, kept for reference.
   *
   * Not wired into CONFIG.RADIUS.FIELDS -- add an entry there to write either
   * one to a column.
   */
  completedMastered: function (html) {
    return topicsWhereChecked_(html, '_CM_checkbox');
  },

  completedNotMastered: function (html) {
    return topicsWhereChecked_(html, '_CBNM_checkbox');
  },

  /**
   * Cool Down -> Mathlete Score, and the assessment status.
   *
   * Also not wired into CONFIG.RADIUS.FIELDS yet.
   */
  mathleteScore: function (html) {
    return checkedRadioValue_(html, 'MathleteScore');
  },

  assessmentStatus: function (html) {
    return checkedRadioLabel_(html, 'AssessmentStatusId');
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
    const roster = loadRoster_();
    const total = roster.withLink + roster.withoutLink;
    showError_('Connected to Radius. Centre ' + CONFIG.RADIUS.CENTER_ID +
      ' lists ' + total + ' student(s), ' + roster.withLink +
      ' with a DWP 2.0 ready to read' +
      (roster.withoutLink
        ? ' and ' + roster.withoutLink + ' not checked in or without one yet'
        : '') + '.');
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
/**
 * The import itself.
 *
 * Takes no lock, looks up no sheets and shows nothing -- the caller owns all
 * three, so this can run on its own from the Radius menu or as EOD's first
 * step without the two fighting over the document lock.
 *
 * Writes are flushed before returning, so a caller that reads the same columns
 * afterwards sees what the import put there.
 */
/**
 * Phase one: fetch everything and work out what would be written.
 *
 * Writes nothing. Takes no lock and shows nothing -- the caller owns both, so
 * this can feed the confirmation dialog or run straight into applyRadiusPlan_
 * as EOD's first step.
 */
function buildRadiusPlan_(sheets, selection, log) {
  const started = Date.now();
  const timing = CONFIG.RADIUS.TIMING;
  const plan = {
    startRow: selection.startRow,
    numRows: selection.numRows,
    students: [],
    problems: [],
    stoppedEarly: false
  };

  const nameCol = WopColumn_(sheets.wop, selection.startRow, selection.numRows,
    CONFIG.WOP_COL.NAME);
  const columns = {};
  CONFIG.RADIUS.FIELDS.forEach(function (field) {
    columns[field.key] = WopColumn_(sheets.wop, selection.startRow,
      selection.numRows, field.column);
  });

  const roster = loadRoster_();

  for (let i = 0; i < selection.numRows; i++) {
    if (Date.now() - started > CONFIG.RADIUS.MAX_RUNTIME_MS) {
      plan.stoppedEarly = true;
      log.warn('Run stopped', 'Approaching the 6-minute limit after ' +
        plan.students.length + ' student(s). Highlight the rest and run again.');
      break;
    }

    const name = extractName_(nameCol.value(i));
    if (!name) continue;

    try {
      const entry = lookupRosterEntry_(roster, name);
      const html = radiusFetch_(entry.url);

      // Guard against a mislinked roster row carrying another student's data
      // into this row. The page names the student it belongs to.
      const pageName = pageStudentName_(html);
      if (pageName && normalizeStudentName_(pageName) !== normalizeStudentName_(name)) {
        throw new Error('the roster link opened the DWP for "' + pageName +
          '" instead. Nothing was written for this row.');
      }

      const results = extractRadiusFields_(html);
      const valueOf = function (key) {
        const hit = results.filter(function (r) { return r.field.key === key; })[0];
        return hit ? hit.value : '';
      };

      const review = reviewSessionTiming_(
        valueOf(timing.SIGN_IN_FIELD), valueOf(timing.SIGN_OUT_FIELD));

      // Everything appended to the note column, in order: the timing
      // observations, then the Mathlete score if one was given.
      const appended = review.notes.slice();
      const mathlete = RADIUS_EXTRACTORS.mathleteScore(html);
      if (mathlete) appended.push('MLS (' + mathlete + ')');

      if (appended.length) {
        const noteResult = results.filter(function (r) {
          return r.field.key === timing.NOTE_FIELD;
        })[0];
        if (noteResult) {
          noteResult.value = [noteResult.value].concat(appended)
            .filter(function (part) { return String(part).trim() !== ''; })
            .join(' | ');
        }
      }

      const values = {};
      const existing = {};
      const conflicts = [];
      const blocked = [];

      results.forEach(function (result) {
        const field = result.field;
        const column = columns[field.key];
        const current = String(column.value(i)).trim();
        values[field.key] = result.value;
        existing[field.key] = current;

        if (field.merge === 'statusLetters') {
          // Column K has its own rules and is never part of the
          // append-or-overwrite choice.
          if (isDoneColor_(column.background(i))) {
            blocked.push('column ' + columnLetter_(field.column) +
              ' is already green — EOD has finished this row');
            values[field.key] = null;
            return;
          }
          const merged = mergeStatusLetters_(current, result.value);
          if (merged.blocked) {
            blocked.push('column ' + columnLetter_(field.column) + ' holds "' +
              current + '", which is an EOD marker');
            values[field.key] = null;
            return;
          }
          values[field.key] = merged.changed ? merged.value : null;
          return;
        }

        if (current && current !== String(result.value)) conflicts.push(field.key);
      });

      plan.students.push({
        index: i,
        name: name,
        values: values,
        existing: existing,
        conflicts: conflicts,
        blocked: blocked,
        shade: review.shade,
        durationMinutes: review.durationMinutes
      });
    } catch (err) {
      plan.problems.push({ index: i, name: name, message: err.message });
      log.error(name, err.message);
    }

    Utilities.sleep(CONFIG.RADIUS.FETCH_DELAY_MS);
  }

  return plan;
}

/**
 * Phase two: write the plan for the chosen students.
 *
 * `picked` is a set of student indexes to apply; omit it to apply all of them.
 * `mode` decides what happens where a cell already holds something:
 * 'overwrite' replaces it, 'append' joins the two, 'skip' leaves it be.
 * Column K is exempt -- it always uses its own merge.
 */
function applyRadiusPlan_(sheets, plan, picked, mode, log) {
  const stats = { imported: 0, skippedCells: 0 };
  const columns = {};
  const timing = CONFIG.RADIUS.TIMING;

  try {
    CONFIG.RADIUS.FIELDS.forEach(function (field) {
      columns[field.key] = WopColumn_(sheets.wop, plan.startRow,
        plan.numRows, field.column);
    });

    plan.students.forEach(function (student) {
      if (picked && picked.indexOf(student.index) === -1) return;

      const written = [];
      CONFIG.RADIUS.FIELDS.forEach(function (field) {
        const value = student.values[field.key];
        if (value === null || value === undefined) return;

        const column = columns[field.key];
        const current = String(column.value(student.index)).trim();

        if (field.merge === 'statusLetters') {
          column.setValue(student.index, value);
          written.push(field.label + ': ' + value);
          return;
        }

        if (current && current !== String(value)) {
          if (mode === 'skip') { stats.skippedCells++; return; }
          if (mode === 'append') {
            column.setValue(student.index, current + ' | ' + value);
            written.push(field.label + ': ' + current + ' | ' + value);
            return;
          }
        }

        column.setValue(student.index, value);
        if (String(value) !== '') written.push(field.label + ': ' + value);
      });

      if (student.shade) {
        timing.SHADE_FIELDS.forEach(function (key) {
          if (columns[key]) columns[key].setBackground(student.index, CONFIG.COLOR.TIMING);
        });
        log.warn(student.name, 'session ran ' + student.durationMinutes +
          ' minutes, which is neither about an hour nor about two — ' +
          'sign-in and sign-out shaded for a look.');
      }

      student.blocked.forEach(function (reason) { log.warn(student.name, reason); });

      stats.imported++;
      log.ok(student.name, written.length ? written.join(', ') : 'nothing to write');
    });
  } catch (err) {
    log.error('Run stopped', err.message);
  } finally {
    try {
      Object.keys(columns).forEach(function (key) { columns[key].flush(); });
    } catch (flushErr) {
      log.error('Save failed', 'Could not write values back: ' + flushErr.message);
    }
  }

  return stats;
}

// ------------------------------------------------------------------
// Parking a plan between the dialog and the callback
// ------------------------------------------------------------------

/**
 * Each student is cached under its own key. Notes can run to a thousand
 * characters apiece, so a whole selection in one entry would risk the
 * hundred-kilobyte ceiling on a busy day.
 */
function storeRadiusPlan_(plan) {
  const cache = CacheService.getUserCache();
  const token = Utilities.getUuid();
  const entries = {};

  entries['radiusPlan_' + token] = JSON.stringify({
    startRow: plan.startRow,
    numRows: plan.numRows,
    count: plan.students.length,
    problems: plan.problems,
    stoppedEarly: plan.stoppedEarly
  });
  plan.students.forEach(function (student, n) {
    entries['radiusPlan_' + token + '_' + n] = JSON.stringify(student);
  });

  cache.putAll(entries, CONFIG.CACHE_TTL_SECONDS);
  return token;
}

function loadRadiusPlan_(token) {
  const cache = CacheService.getUserCache();
  const raw = cache.get('radiusPlan_' + token);
  if (!raw) return null;

  const plan = JSON.parse(raw);
  plan.students = [];
  for (let n = 0; n < plan.count; n++) {
    const chunk = cache.get('radiusPlan_' + token + '_' + n);
    if (!chunk) return null;
    plan.students.push(JSON.parse(chunk));
  }
  return plan;
}

function clearRadiusPlan_(token, count) {
  const keys = ['radiusPlan_' + token];
  for (let n = 0; n < count; n++) keys.push('radiusPlan_' + token + '_' + n);
  CacheService.getUserCache().removeAll(keys);
}

/** True when there is enough set up for the import to be worth attempting. */
function radiusIsConfigured_() {
  return Boolean(
    PropertiesService.getScriptProperties().getProperty(CONFIG.RADIUS.COOKIE_PROPERTY) &&
    String(CONFIG.RADIUS.ROSTER_URL || '').trim() &&
    String(CONFIG.RADIUS.CENTER_ID || '').trim());
}

/** The columns the import writes, as letters, for a report line. */
function radiusColumnList_() {
  return CONFIG.RADIUS.FIELDS.map(function (f) {
    return columnLetter_(f.column);
  }).join(', ');
}

/**
 * Runs the import without asking: build the plan, apply all of it.
 * Used by EOD, where a modal part way through a batch would be a nuisance.
 */
function runRadiusImport_(sheets, selection, log) {
  const plan = buildRadiusPlan_(sheets, selection, log);
  return applyRadiusPlan_(sheets, plan, null, CONFIG.RADIUS.EOD_CONFLICT_MODE, log);
}


// ------------------------------------------------------------------
// The confirmation dialog
// ------------------------------------------------------------------

function shorten_(text, limit) {
  const value = String(text == null ? '' : text);
  return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
}

/** One student's block in the preview. */
function renderPlanStudent_(student, position) {
  const conflicts = student.conflicts || [];
  let html = '<div style="border: 1px solid #e5e7eb; border-radius: 6px; ' +
    'margin-bottom: 10px; background: ' + (conflicts.length ? '#fffbeb' : '#f9fafb') + ';">' +
    '<label style="display: block; padding: 8px 10px; cursor: pointer; ' +
    'border-bottom: 1px solid #e5e7eb;">' +
    '<input type="checkbox" class="pick" name="pick_' + student.index + '" checked> ' +
    '<b>' + escapeHtml_(student.name) + '</b>';

  if (student.durationMinutes !== null && student.durationMinutes !== undefined) {
    html += '<span style="color: ' + (student.shade ? '#b45309' : '#6b7280') +
      '; font-size: 12px;"> · ' + student.durationMinutes + ' min' +
      (student.shade ? ' (odd length)' : '') + '</span>';
  }
  html += '</label><table style="width: 100%; font-size: 12px; border-collapse: collapse;">';

  CONFIG.RADIUS.FIELDS.forEach(function (field) {
    const value = student.values[field.key];
    if (value === null || value === undefined) return;

    const letter = columnLetter_(field.column);
    const clash = conflicts.indexOf(field.key) !== -1;
    const current = student.existing[field.key];

    html += '<tr style="border-top: 1px solid #f1f5f9;">' +
      '<td style="padding: 3px 6px; width: 18px; color: #64748b;">' + letter + '</td>' +
      '<td style="padding: 3px 6px; width: 130px; color: #64748b;">' +
      escapeHtml_(field.label) + '</td>' +
      '<td style="padding: 3px 6px;" title="' + escapeHtml_(value) + '">' +
      (String(value) === ''
        ? '<i style="color: #cbd5e1;">(blank)</i>'
        : escapeHtml_(shorten_(value, 70))) +
      (clash
        ? '<div style="color: #b45309;">cell holds “' +
          escapeHtml_(shorten_(current, 40)) + '”</div>'
        : '') +
      '</td></tr>';
  });

  html += '</table>';

  (student.blocked || []).forEach(function (reason) {
    html += '<div style="padding: 4px 10px; color: #b45309; font-size: 12px;">⚠️ ' +
      escapeHtml_(reason) + '</div>';
  });
  return html + '</div>';
}

/** Phase one's output, put to the operator before anything is written. */
function showRadiusPlanDialog_(plan, log) {
  const token = storeRadiusPlan_(plan);
  const clashing = plan.students.filter(function (s) {
    return (s.conflicts || []).length > 0;
  });

  let html = '<div style="font-family: Arial, sans-serif; font-size: 13px; ' +
    'padding: 10px; color: #1e293b;">' +
    '<h3 style="margin-top: 0;">' + plan.students.length +
    ' student(s) fetched from Radius</h3>' +
    '<p style="color: #4b5563;">Nothing has been written yet. Untick anyone you ' +
    'want to leave out.</p>' +
    '<form id="radiusForm">' +
    '<input type="hidden" name="token" value="' + escapeHtml_(token) + '">';

  if (plan.problems.length) {
    html += '<div style="background: #fef2f2; border: 1px solid #fecaca; ' +
      'border-radius: 6px; padding: 8px; margin-bottom: 10px; color: #b91c1c;">' +
      plan.problems.length + ' row(s) could not be fetched: ' +
      plan.problems.map(function (p) { return escapeHtml_(p.name); }).join(', ') +
      '. They are listed in the report afterwards.</div>';
  }

  if (clashing.length) {
    html += '<div style="background: #fffbeb; border: 1px solid #fde68a; ' +
      'border-radius: 6px; padding: 10px; margin-bottom: 10px;">' +
      '<b>' + clashing.length + ' student(s) have cells that already hold ' +
      'something.</b><div style="margin-top: 6px;">' +
      '<label style="display: block; padding: 2px 0;">' +
      '<input type="radio" name="mode" value="append" checked> ' +
      'Append — keep what is there and add the new value after it</label>' +
      '<label style="display: block; padding: 2px 0;">' +
      '<input type="radio" name="mode" value="overwrite"> ' +
      'Overwrite — replace what is there</label>' +
      '<label style="display: block; padding: 2px 0;">' +
      '<input type="radio" name="mode" value="skip"> ' +
      'Leave alone — only fill cells that are empty</label></div>' +
      '<div style="margin-top: 6px; color: #92400e; font-size: 12px;">' +
      'Column K is not affected by this choice — its letters are always ' +
      'folded together.</div></div>';
  } else {
    html += '<input type="hidden" name="mode" value="overwrite">';
  }

  html += '<div style="max-height: 300px; overflow-y: auto; margin-bottom: 10px;">' +
    plan.students.map(renderPlanStudent_).join('') + '</div>';

  html += '<div id="err" style="display: none; margin: 10px 0; padding: 8px; ' +
    'background: #fef2f2; border: 1px solid #fecaca; border-radius: 4px; ' +
    'color: #b91c1c;"></div>' +
    '<button type="button" id="all" onclick="submitAll()" style="width: 100%; ' +
    'padding: 10px; background: #2563eb; color: white; border: none; ' +
    'border-radius: 6px; cursor: pointer; font-weight: bold;">' +
    'Confirm changes for all ' + plan.students.length + '</button>' +
    '<button type="button" id="some" onclick="submitPicked()" style="width: 100%; ' +
    'padding: 8px; margin-top: 6px; background: #f1f5f9; color: #1e293b; ' +
    'border: 1px solid #cbd5e1; border-radius: 6px; cursor: pointer;">' +
    'Apply only the ticked ones</button>' +
    '<button type="button" onclick="google.script.host.close()" style="width: 100%; ' +
    'padding: 8px; margin-top: 6px; background: none; color: #6b7280; ' +
    'border: none; cursor: pointer;">Cancel — nothing will change</button>' +
    '</form>' +
    '<script>' +
    'function lock(label) {' +
    '  document.getElementById("err").style.display = "none";' +
    '  ["all", "some"].forEach(function (id) {' +
    '    var b = document.getElementById(id); b.disabled = true;' +
    '  });' +
    '  document.getElementById("all").textContent = label;' +
    '}' +
    'function unlock(e) {' +
    '  ["all", "some"].forEach(function (id) {' +
    '    document.getElementById(id).disabled = false;' +
    '  });' +
    '  document.getElementById("all").textContent = "Retry";' +
    '  var box = document.getElementById("err");' +
    '  box.textContent = "Nothing was changed. " + (e && e.message ? e.message : e);' +
    '  box.style.display = "block";' +
    '}' +
    'function send() {' +
    '  google.script.run.withFailureHandler(unlock)' +
    '    .applyRadiusPlan_FromUI(document.getElementById("radiusForm"));' +
    '}' +
    'function submitAll() {' +
    '  var boxes = document.querySelectorAll(".pick");' +
    '  for (var i = 0; i < boxes.length; i++) boxes[i].checked = true;' +
    '  lock("Writing..."); send();' +
    '}' +
    'function submitPicked() { lock("Writing..."); send(); }' +
    '</script></div>';

  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(560).setHeight(600),
    'Confirm Radius import');
}

/** Callback from the dialog. */
function applyRadiusPlan_FromUI(formObject) {
  const plan = loadRadiusPlan_(formObject.token);
  if (!plan) {
    throw new Error('This dialog has expired. Re-run the import from the Radius menu.');
  }

  const picked = plan.students
    .filter(function (s) { return formObject['pick_' + s.index] !== undefined; })
    .map(function (s) { return s.index; });

  if (!picked.length) {
    throw new Error('No students were ticked, so there was nothing to write.');
  }

  const mode = ['append', 'overwrite', 'skip'].indexOf(formObject.mode) === -1
    ? 'overwrite' : formObject.mode;

  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    throw new Error('Someone else is running a batch on this spreadsheet right now.');
  }

  const log = ActionLog_();
  let stats;
  try {
    stats = applyRadiusPlan_(getSheets_(), plan, picked, mode, log);
    clearRadiusPlan_(formObject.token, plan.count);
  } finally {
    lock.releaseLock();
  }

  plan.problems.forEach(function (problem) { log.error(problem.name, problem.message); });

  showReport_('Radius Import', '🔗 Import Summary', [
    { label: 'Students written', value: stats.imported },
    { label: 'Left out', value: plan.students.length - picked.length },
    { label: 'Could not be fetched', value: plan.problems.length,
      alert: plan.problems.length > 0 },
    { label: 'Cells left alone', value: stats.skippedCells },
    { label: 'Columns', value: radiusColumnList_() }
  ], log);
}

/**
 * Menu entry: fetches for the highlighted rows and puts the result to the
 * operator before anything is written.
 */
function importRadiusData() {
  let sheets;
  let selection;
  try {
    sheets = getSheets_();
    selection = getSelection_(sheets.wop);
  } catch (err) {
    showError_(err.message);
    return;
  }

  const log = ActionLog_();
  let plan;
  try {
    plan = buildRadiusPlan_(sheets, selection, log);
  } catch (err) {
    showError_(err.message);
    return;
  }

  if (!plan.students.length) {
    showError_(plan.problems.length
      ? 'Nothing could be fetched. ' + plan.problems[0].message
      : 'No student names found in the highlighted rows of column A.');
    return;
  }

  showRadiusPlanDialog_(plan, log);
}
