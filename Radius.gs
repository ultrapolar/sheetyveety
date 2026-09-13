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
function runRadiusImport_(sheets, selection, log) {
  const started = Date.now();
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

        // Timing review runs before anything is written, so its notes can be
        // folded into the note column's value rather than written separately.
        const valueOf = function (key) {
          const hit = results.filter(function (r) { return r.field.key === key; })[0];
          return hit ? hit.value : '';
        };
        const timing = CONFIG.RADIUS.TIMING;
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

        const skipped = [];
        results.forEach(function (result) {
          const column = columns[result.field.key];

          if (result.field.merge !== 'statusLetters') {
            column.setValue(i, result.value);
            return;
          }

          // EOD has already finished this row -- its record is the last word.
          if (isDoneColor_(column.background(i))) {
            skipped.push('already processed by EOD');
            return;
          }

          const merged = mergeStatusLetters_(column.value(i), result.value);
          if (merged.blocked) {
            skipped.push('column ' + columnLetter_(result.field.column) +
              ' holds "' + String(column.value(i)).trim() +
              '", which is an EOD marker — left alone');
            return;
          }
          if (merged.changed) column.setValue(i, merged.value);
        });

        if (review.shade) {
          timing.SHADE_FIELDS.forEach(function (key) {
            if (columns[key]) columns[key].setBackground(i, CONFIG.COLOR.TIMING);
          });
          log.warn(name, 'session ran ' + review.durationMinutes +
            ' minutes, which is neither about an hour nor about two — ' +
            'sign-in and sign-out shaded for a look.');
        }

        skipped.forEach(function (reason) { log.warn(name, reason); });

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
  }

  return stats;
}

/** True when there is enough set up for the import to be worth attempting. */
function radiusIsConfigured_() {
  return Boolean(
    PropertiesService.getScriptProperties().getProperty(CONFIG.RADIUS.COOKIE_PROPERTY) &&
    String(CONFIG.RADIUS.INSTRUCTION_MANAGER_URL || '').trim());
}

/** The columns the import writes, as letters, for a report line. */
function radiusColumnList_() {
  return CONFIG.RADIUS.FIELDS.map(function (f) {
    return columnLetter_(f.column);
  }).join(', ');
}

/** Menu entry: imports values for the highlighted Daily WOP rows. */
function importRadiusData() {
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
  let stats;
  try {
    stats = runRadiusImport_(sheets, selection, log);
  } finally {
    lock.releaseLock();
  }

  if (log.isEmpty()) {
    showError_('Nothing to import — no student names found in the highlighted rows.');
    return;
  }

  showReport_('Radius Import', '🔗 Import Summary', [
    { label: 'Students imported', value: stats.imported },
    { label: 'Failed', value: stats.failed, alert: stats.failed > 0 },
    { label: 'Columns written', value: radiusColumnList_() }
  ], log);
}
