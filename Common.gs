/**
 * Shared helpers used by both the SOD and EOD scripts.
 */

// ------------------------------------------------------------------
// Sheet + selection access
// ------------------------------------------------------------------

/**
 * Resolves the two sheets the scripts work with and confirms the operator is
 * looking at the Daily WOP sheet. Throws with an operator-friendly message.
 */
function getSheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wop = ss.getSheetByName(CONFIG.SHEETS.WOP);
  const deck = ss.getSheetByName(CONFIG.SHEETS.DECK);

  if (!wop || !deck) {
    throw new Error(
      'Could not find both sheets. This spreadsheet needs a tab named "' +
      CONFIG.SHEETS.WOP + '" and one named "' + CONFIG.SHEETS.DECK +
      '", spelled exactly that way.');
  }
  if (ss.getActiveSheet().getName() !== CONFIG.SHEETS.WOP) {
    throw new Error('Switch to the "' + CONFIG.SHEETS.WOP +
      '" sheet and highlight the rows you want to process, then run this again.');
  }
  return { ss: ss, wop: wop, deck: deck };
}

/**
 * Returns the highlighted row range, clamped to rows that actually hold data
 * so that selecting a whole column does not scan thousands of empty rows.
 */
function getSelection_(wopSheet) {
  const range = wopSheet.getActiveRange();
  if (!range) {
    throw new Error('Highlight the rows you want to process first.');
  }
  const startRow = range.getRow();
  const lastDataRow = wopSheet.getLastRow();
  const numRows = Math.min(range.getNumRows(), lastDataRow - startRow + 1);

  if (numRows < 1) {
    throw new Error('The highlighted selection does not contain any data rows.');
  }
  return { startRow: startRow, numRows: numRows };
}

// ------------------------------------------------------------------
// Deck List: read once, write once
// ------------------------------------------------------------------

// Tuning for DeckTable_.flush(). A column's changed rows are written in one
// call when there are at least this many of them and they are not spread over
// more than this multiple of their own count.
const SPAN_WRITE_MIN_ROWS_ = 4;
const SPAN_WRITE_MAX_SPREAD_ = 6;

/**
 * An in-memory view of the Deck List.
 *
 * The whole sheet is read in a single call. Lookups go through a name index
 * instead of a nested scan, reads are free, and writes are buffered until
 * flush() so the same student can be touched twice in one run and stay
 * consistent. Only cells that actually changed are written back, so untouched
 * columns keep whatever they contain.
 */
function DeckTable_(sheet) {
  const range = sheet.getDataRange();
  const values = range.getValues();

  // getDataRange() stops at the last populated column, which may be short of
  // the archive column. Pad so every column we address exists.
  let width = values.length ? values[0].length : 0;
  Object.keys(CONFIG.DECK_COL).forEach(function (key) {
    width = Math.max(width, CONFIG.DECK_COL[key]);
  });
  values.forEach(function (row) {
    while (row.length < width) row.push('');
  });

  const index = {};
  for (let r = 0; r < values.length; r++) {
    const key = String(values[r][CONFIG.DECK_COL.NAME - 1]).trim().toLowerCase();
    if (!key) continue;
    if (index[key]) {
      index[key].duplicate = true;
    } else {
      index[key] = { row: r + 1, duplicate: false };
    }
  }

  const dirty = {};

  return {
    /** Returns {row, duplicate} for a name, or null if it is not on the list. */
    find: function (name) {
      return index[String(name).trim().toLowerCase()] || null;
    },
    /** The name currently sitting on a row, used to detect shifted rows. */
    nameAt: function (row) {
      if (row < 1 || row > values.length) return '';
      return String(values[row - 1][CONFIG.DECK_COL.NAME - 1]).trim();
    },
    get: function (row, col) {
      return String(values[row - 1][col - 1]).trim();
    },
    set: function (row, col, value) {
      values[row - 1][col - 1] = value;
      dirty[row + ':' + col] = true;
    },
    /** Writes every changed cell back, merging adjacent rows into one call. */
    flush: function () {
      const byColumn = {};
      Object.keys(dirty).forEach(function (key) {
        const parts = key.split(':');
        const col = parts[1];
        if (!byColumn[col]) byColumn[col] = [];
        byColumn[col].push(Number(parts[0]));
      });

      let writes = 0;
      Object.keys(byColumn).forEach(function (colKey) {
        const col = Number(colKey);
        const rows = byColumn[colKey].sort(function (a, b) { return a - b; });

        // Students are usually scattered through the roster, so writing each
        // changed cell on its own is slow. When the changed rows sit close
        // together it is far cheaper to write the whole span in one call --
        // but only once we have confirmed the untouched cells inside it hold
        // no formulas, since rewriting a formula with its result destroys it.
        const first = rows[0];
        const span = rows[rows.length - 1] - first + 1;
        if (rows.length >= SPAN_WRITE_MIN_ROWS_ && span <= rows.length * SPAN_WRITE_MAX_SPREAD_) {
          const spanRange = sheet.getRange(first, col, span, 1);
          const formulas = spanRange.getFormulas();
          writes++;
          const hasFormula = formulas.some(function (r) { return String(r[0]) !== ''; });
          if (!hasFormula) {
            const block = [];
            for (let r = 0; r < span; r++) {
              block.push([values[first + r - 1][col - 1]]);
            }
            spanRange.setValues(block);
            writes++;
            return;
          }
        }

        // Otherwise write only the changed cells, merging any adjacent runs.
        let runStart = 0;
        for (let i = 1; i <= rows.length; i++) {
          if (i === rows.length || rows[i] !== rows[i - 1] + 1) {
            const runFirst = rows[runStart];
            const count = i - runStart;
            const block = [];
            for (let r = 0; r < count; r++) {
              block.push([values[runFirst + r - 1][col - 1]]);
            }
            sheet.getRange(runFirst, col, count, 1).setValues(block);
            writes++;
            runStart = i;
          }
        }
      });
      return writes;
    }
  };
}

// ------------------------------------------------------------------
// Daily WOP: one column of the highlighted selection
// ------------------------------------------------------------------

/**
 * A buffered view of a single column across the highlighted rows. Values and
 * backgrounds are read once and written back in one call each, instead of one
 * call per cell.
 */
function WopColumn_(sheet, startRow, numRows, col) {
  const range = sheet.getRange(startRow, col, numRows, 1);
  const values = range.getValues();
  const backgrounds = range.getBackgrounds();
  let valuesDirty = false;
  let backgroundsDirty = false;

  return {
    value: function (i) { return values[i][0]; },
    background: function (i) { return normalizeColor_(backgrounds[i][0]); },
    setValue: function (i, value) { values[i][0] = value; valuesDirty = true; },
    setBackground: function (i, color) { backgrounds[i][0] = color; backgroundsDirty = true; },
    flush: function () {
      if (valuesDirty) range.setValues(values);
      if (backgroundsDirty) range.setBackgrounds(backgrounds);
    }
  };
}

// ------------------------------------------------------------------
// Parsing
// ------------------------------------------------------------------

function normalizeColor_(color) {
  let text = String(color == null ? '' : color).trim().toLowerCase();
  // Expand shorthand hex (#0f0) to the long form so comparisons line up.
  if (/^#[0-9a-f]{3}$/.test(text)) {
    text = '#' + text[1] + text[1] + text[2] + text[2] + text[3] + text[3];
  }
  return text;
}

/** True when a background marks the row as already finished. */
function isDoneColor_(color) {
  return CONFIG.DONE_COLORS.indexOf(normalizeColor_(color)) !== -1;
}

const TIME_PATTERN_ = '\\d{1,2}(?::\\d{2})?\\s*(?:[ap]\\.?m\\.?)?';
const TIME_JOIN_ = '(?:\\s*(?:-|–|—|to)\\s*)';
const LEADING_TIME_ = new RegExp(
  '^\\s*' + TIME_PATTERN_ + '(?:' + TIME_JOIN_ + TIME_PATTERN_ + ')?\\s*[-–—:]?\\s*', 'i');

/**
 * Strips a leading appointment time from a Daily WOP name cell.
 * Handles "9 Jane", "10:30 AM Jane", "10:30am-11:00am Jane", "9 - 10 Jane".
 */
function extractName_(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  return text.replace(LEADING_TIME_, '').trim();
}

/** Splits a comma-separated task list, dropping blanks. */
function splitList_(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return [];
  return text.split(/\s*,\s*/).map(function (item) {
    return item.trim();
  }).filter(function (item) {
    return item !== '';
  });
}

/**
 * Reads a Column K status cell.
 *
 * The letters are the instruction: each Y means "advance one task", a P means
 * "mark pink". Anything the script itself appended -- " - B empty?" or
 * " (2 of 3 done, ran out)" -- is stripped before the letters are read, so a
 * flagged row re-runs against the work that is still outstanding.
 *
 * Returns null when the cell is not an instruction at all.
 */
function parseStatus_(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;

  const core = text.split(/\s+-\s+|\s+\(/)[0].trim().toUpperCase();
  if (!/^[YP]+$/.test(core)) return null;

  return {
    core: core,
    yCount: (core.match(/Y/g) || []).length,
    pCount: (core.match(/P/g) || []).length
  };
}

// ------------------------------------------------------------------
// Action log
// ------------------------------------------------------------------

/**
 * Collects structured log entries. Kept as data rather than HTML strings so
 * the report can sort, count and escape them at render time.
 */
function ActionLog_() {
  const entries = [];
  function add(level, subject, message) {
    entries.push({ level: level, subject: subject, message: message });
  }
  return {
    ok: function (subject, message) { add('ok', subject, message); },
    warn: function (subject, message) { add('warn', subject, message); },
    error: function (subject, message) { add('error', subject, message); },
    all: function () { return entries; },
    /** Warnings and errors together -- the things needing a human. */
    issueCount: function () {
      return entries.filter(function (e) {
        return e.level === 'warn' || e.level === 'error';
      }).length;
    },
    isEmpty: function () { return entries.length === 0; }
  };
}

// ------------------------------------------------------------------
// Reporting
// ------------------------------------------------------------------

function escapeHtml_(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const LOG_STYLE_ = {
  ok: { icon: '✅', color: '#166534' },
  warn: { icon: '⚠️', color: '#b45309' },
  error: { icon: '❌', color: '#b91c1c' }
};

/**
 * Renders the end-of-run summary. Problems are listed first so the operator
 * sees what needs attention without scrolling past the successes.
 */
function showReport_(title, heading, statRows, log) {
  const entries = log.all();
  const problems = entries.filter(function (e) { return e.level !== 'ok'; });
  const successes = entries.filter(function (e) { return e.level === 'ok'; });

  function renderList(list) {
    return list.map(function (entry) {
      const style = LOG_STYLE_[entry.level] || LOG_STYLE_.ok;
      return '<li style="color: ' + style.color + '; margin-bottom: 4px;">' +
        style.icon + ' <strong>' + escapeHtml_(entry.subject) + '</strong> &mdash; ' +
        escapeHtml_(entry.message) + '</li>';
    }).join('');
  }

  const stats = statRows.map(function (row) {
    const color = row.alert ? '#b91c1c' : '#334155';
    return '<tr><td style="padding: 2px 0;">' + escapeHtml_(row.label) + '</td>' +
      '<td style="text-align: right; color: ' + color + ';"><b>' +
      escapeHtml_(row.value) + '</b></td></tr>';
  }).join('');

  let body = '';
  if (problems.length) {
    body += '<div style="font-weight: bold; margin: 14px 0 6px;">Needs attention (' +
      problems.length + ')</div><ul style="padding-left: 20px; margin: 0;">' +
      renderList(problems) + '</ul>';
  }
  if (successes.length) {
    body += '<div style="font-weight: bold; margin: 14px 0 6px;">Completed (' +
      successes.length + ')</div><ul style="padding-left: 20px; margin: 0;">' +
      renderList(successes) + '</ul>';
  }
  if (!body) {
    body = '<p style="color: #64748b; margin-top: 14px;">Nothing in the highlighted ' +
      'selection needed processing.</p>';
  }

  const html = '<div style="font-family: Arial, sans-serif; font-size: 14px; ' +
    'line-height: 1.5; padding: 5px; color: #1e293b;">' +
    '<div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px;">' +
    '<h4 style="margin: 0 0 8px 0;">' + escapeHtml_(heading) + '</h4>' +
    '<table style="width: 100%; font-size: 14px;">' + stats + '</table></div>' +
    body + '</div>';

  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(500).setHeight(520), title);
}

/** Shows an error to the operator without leaving a stack trace on screen. */
function showError_(message) {
  SpreadsheetApp.getUi().alert(message);
}
