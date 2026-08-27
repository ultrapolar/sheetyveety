/**
 * One-off repair tools for the Deck List.
 *
 * A column was inserted ahead of the history column, which pushed the real
 * history from M across to N while the script carried on writing to M. This
 * moves the entries the script wrote after the insert into N, so that column M
 * can be deleted and the layout put back the way it was.
 */

// Where the history has been landing since the column was inserted.
const LEGACY_ARCHIVE_COL_ = 13; // M

// The Deck List's first 3 rows are header/non-student rows, not data. Only
// the history repair needs to know this -- SOD and EOD are unaffected.

// Give up rather than spin if an entry's date cannot be reconciled.
const MAX_YEAR_LOOKBACK_ = 50;
const DECK_HEADER_ROWS_ = 3;

// ------------------------------------------------------------------
// Dating history entries
// ------------------------------------------------------------------

/**
 * Pulls the date off the end of a history entry ("Fractions 08/20").
 * Accepts an explicit year if one is ever present, but does not need it.
 */
function parseEntryMonthDay_(entry) {
  const match = String(entry).trim().match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*$/);
  if (!match) return null;

  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  let year = null;
  if (match[3]) {
    year = Number(match[3]);
    if (year < 100) year += 2000;
  }
  return { month: month, day: day, year: year };
}

/**
 * Works out which year each entry belongs to.
 *
 * Entries are appended to the right as tasks finish, so a cell reads oldest to
 * newest. Reading it backwards from the newest, the dates must never move
 * forward -- when one does, it belongs to the year before. The newest entry
 * itself cannot be later than today.
 *
 * Returns one {entry, date} per input entry, date being null when the entry
 * carries no readable date.
 */
function inferEntryDates_(entries, referenceDate) {
  const results = new Array(entries.length);
  let year = referenceDate.getFullYear();
  let newerDate = null;

  for (let i = entries.length - 1; i >= 0; i--) {
    const parsed = parseEntryMonthDay_(entries[i]);
    if (!parsed) {
      results[i] = { entry: entries[i], date: null };
      continue;
    }

    if (parsed.year !== null) {
      const explicit = new Date(parsed.year, parsed.month - 1, parsed.day);
      results[i] = { entry: entries[i], date: explicit };
      newerDate = explicit;
      year = parsed.year;
      continue;
    }

    const ceiling = newerDate || referenceDate;
    let candidate = new Date(year, parsed.month - 1, parsed.day);
    let guard = 0;
    while (candidate.getTime() > ceiling.getTime() && guard < MAX_YEAR_LOOKBACK_) {
      year--;
      candidate = new Date(year, parsed.month - 1, parsed.day);
      guard++;
    }

    results[i] = { entry: entries[i], date: candidate };
    newerDate = candidate;
  }

  return results;
}

/**
 * Splits one cell's history at the cutoff.
 *
 * Because the entries are in date order, this is a single split point rather
 * than a per-entry filter: everything from the first entry on or after the
 * cutoff moves, everything before it stays.
 */
function splitHistoryEntries_(text, cutoff, referenceDate) {
  const entries = String(text).split(/\s*\|\s*/).map(function (part) {
    return part.trim();
  }).filter(function (part) {
    return part !== '';
  });

  if (!entries.length) return { move: [], keep: [], undatedKept: [] };

  const dated = inferEntryDates_(entries, referenceDate);

  let splitIndex = entries.length;
  for (let i = 0; i < dated.length; i++) {
    if (dated[i].date && dated[i].date.getTime() >= cutoff.getTime()) {
      splitIndex = i;
      break;
    }
  }

  const keep = entries.slice(0, splitIndex);
  return {
    move: entries.slice(splitIndex),
    keep: keep,
    // Anything left behind that could not be dated is worth a human look,
    // since column M is going to be deleted afterwards.
    undatedKept: dated.slice(0, splitIndex).filter(function (d) {
      return d.date === null;
    }).map(function (d) { return d.entry; })
  };
}

function historyCutoffDate_() {
  const parts = String(CONFIG.HISTORY_CUTOFF).split('-');
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

// ------------------------------------------------------------------
// Planning
// ------------------------------------------------------------------

/**
 * Works out what the repair would do, without changing anything.
 * The first DECK_HEADER_ROWS_ rows are treated as headers and left alone.
 */
function planHistoryColumnRepair_(deckSheet, referenceDate) {
  const values = deckSheet.getDataRange().getValues();
  const from = LEGACY_ARCHIVE_COL_;
  const to = CONFIG.DECK_COL.ARCHIVE;
  const cutoff = historyCutoffDate_();
  const reference = referenceDate || new Date();

  const actions = [];
  let alreadyDone = 0;

  for (let r = DECK_HEADER_ROWS_; r < values.length; r++) {
    const row = values[r];
    const stray = String(row.length >= from ? row[from - 1] : '').trim();
    if (!stray) continue;

    const name = String(row[CONFIG.DECK_COL.NAME - 1]).trim() || '(row ' + (r + 1) + ')';
    const current = String(row.length >= to ? row[to - 1] : '').trim();
    const split = splitHistoryEntries_(stray, cutoff, reference);

    if (!split.move.length) {
      // Nothing recent enough to rescue, but the cell is not empty either.
      actions.push({
        row: r + 1, name: name, kind: 'keepAll',
        moveText: '', keepText: split.keep.join(CONFIG.ARCHIVE_SEPARATOR),
        existing: current, result: current, undatedKept: split.undatedKept
      });
      continue;
    }

    const moveText = split.move.join(CONFIG.ARCHIVE_SEPARATOR);

    // Skip anything an earlier run of this repair already carried across.
    if (current && current.indexOf(moveText) !== -1) {
      alreadyDone++;
      continue;
    }

    actions.push({
      row: r + 1,
      name: name,
      kind: current ? 'merge' : 'move',
      moveText: moveText,
      keepText: split.keep.join(CONFIG.ARCHIVE_SEPARATOR),
      existing: current,
      // Whatever is already in the destination keeps its place at the front.
      result: current ? current + CONFIG.ARCHIVE_SEPARATOR + moveText : moveText,
      undatedKept: split.undatedKept
    });
  }

  return {
    actions: actions,
    alreadyDone: alreadyDone,
    from: from,
    to: to,
    cutoff: cutoff,
    // Rows that will still hold text in the old column once this has run.
    leftBehind: actions.filter(function (a) { return a.keepText !== ''; })
  };
}

// ------------------------------------------------------------------
// Menu entries
// ------------------------------------------------------------------

function deckSheetOrThrow_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.DECK);
  if (!sheet) throw new Error('Could not find a sheet named "' + CONFIG.SHEETS.DECK + '".');
  return sheet;
}

/** Menu entry: shows the preview. */
function repairHistoryColumn() {
  let plan;
  let fromLetter;
  let toLetter;
  try {
    plan = planHistoryColumnRepair_(deckSheetOrThrow_());
    fromLetter = columnLetter_(plan.from);
    toLetter = columnLetter_(plan.to);
  } catch (err) {
    showError_(err.message);
    return;
  }

  const movers = plan.actions.filter(function (a) { return a.kind !== 'keepAll'; });
  if (!movers.length) {
    showError_('Nothing to move. No history in column ' + fromLetter + ' is dated on or ' +
      'after ' + CONFIG.HISTORY_CUTOFF + '.' +
      (plan.alreadyDone ? ' (' + plan.alreadyDone + ' row(s) were carried across already.)' : ''));
    return;
  }

  const merges = movers.filter(function (a) { return a.kind === 'merge'; });

  let html = '<div style="font-family: Arial, sans-serif; font-size: 13px; padding: 10px; color: #1e293b;">' +
    '<h3 style="margin-top: 0;">Move recent history from ' + fromLetter + ' to ' + toLetter + '</h3>' +
    '<p style="color: #4b5563;">Entries dated on or after <b>' + escapeHtml_(CONFIG.HISTORY_CUTOFF) +
    '</b> move across. Older entries stay in column ' + fromLetter +
    '. Nothing has been changed yet.</p>';

  if (plan.leftBehind.length) {
    html += '<div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; ' +
      'padding: 10px; margin-bottom: 12px; color: #b91c1c;"><b>' + plan.leftBehind.length +
      ' row(s) will still have text in column ' + fromLetter + ' after this.</b><br>' +
      'Deleting column ' + fromLetter + ' will destroy that text. It is shown in red below.</div>';
  }
  if (merges.length) {
    html += '<p style="color: #b45309;">' + merges.length + ' row(s) already have something ' +
      'in column ' + toLetter + '. The existing text keeps its place and the moved text is ' +
      'appended after it.</p>';
  }

  html += '<div style="max-height: 230px; overflow-y: auto; border: 1px solid #e5e7eb; ' +
    'border-radius: 6px; padding: 8px; background: #f9fafb;">';
  plan.actions.forEach(function (action) {
    html += '<div style="padding: 5px 0; border-bottom: 1px solid #eef2f7;">' +
      '<b>' + escapeHtml_(action.name) + '</b>';
    if (action.moveText) {
      html += '<div style="color: #166534; font-size: 12px;">→ ' + toLetter + ': ' +
        escapeHtml_(action.result) + '</div>';
    }
    if (action.keepText) {
      html += '<div style="color: #b91c1c; font-size: 12px;">stays in ' + fromLetter +
        ', lost on delete: ' + escapeHtml_(action.keepText) + '</div>';
    }
    if (action.undatedKept.length) {
      html += '<div style="color: #b45309; font-size: 12px;">could not read a date on: ' +
        escapeHtml_(action.undatedKept.join(', ')) + '</div>';
    }
    html += '</div>';
  });
  html += '</div>';

  if (plan.alreadyDone) {
    html += '<p style="color: #64748b; font-size: 12px;">' + plan.alreadyDone +
      ' row(s) were carried across already and will be left alone.</p>';
  }

  html += '<p style="font-size: 12px; color: #64748b;">The first ' + DECK_HEADER_ROWS_ +
    ' rows are treated as headers and skipped. Column ' + fromLetter + ' is not cleared — delete the column once you have ' +
    'checked column ' + toLetter + '.</p>' +
    '<div id="err" style="display: none; margin: 10px 0; padding: 8px; background: #fef2f2; ' +
    'border: 1px solid #fecaca; border-radius: 4px; color: #b91c1c;"></div>' +
    '<button type="button" id="go" onclick="submitRepair()" style="width: 100%; padding: 10px; ' +
    'background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer; ' +
    'font-weight: bold;">Move ' + movers.length + ' row(s)</button>' +
    '<button type="button" onclick="google.script.host.close()" style="width: 100%; padding: 8px; ' +
    'margin-top: 6px; background: none; color: #6b7280; border: none; cursor: pointer;">' +
    'Cancel — nothing will change</button>' +
    '<script>' +
    'function submitRepair() {' +
    '  var go = document.getElementById("go");' +
    '  var err = document.getElementById("err");' +
    '  err.style.display = "none"; go.disabled = true;' +
    '  go.textContent = "Working..."; go.style.background = "#9ca3af";' +
    '  google.script.run' +
    '    .withFailureHandler(function (e) {' +
    '      go.disabled = false; go.textContent = "Retry"; go.style.background = "#2563eb";' +
    '      err.textContent = "Nothing was changed. " + (e && e.message ? e.message : e);' +
    '      err.style.display = "block";' +
    '    })' +
    '    .applyHistoryColumnRepair();' +
    '}' +
    '</script></div>';

  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(540).setHeight(580), 'Repair History Column');
}

/**
 * Callback from the preview. The plan is recomputed here rather than carried
 * over from the dialog, so it always acts on what the sheet holds right now.
 * Running it twice is harmless: rows already carried across are skipped.
 *
 * The old column is deliberately left untouched, so this step is reversible
 * until the column is deleted.
 */
function applyHistoryColumnRepair() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    throw new Error('Someone else is running a batch on this spreadsheet right now.');
  }

  const log = ActionLog_();
  let moved = 0;
  let merged = 0;

  try {
    const deckSheet = deckSheetOrThrow_();
    const plan = planHistoryColumnRepair_(deckSheet);
    const deck = DeckTable_(deckSheet);
    const fromLetter = columnLetter_(plan.from);
    const toLetter = columnLetter_(plan.to);

    plan.actions.forEach(function (action) {
      if (action.kind !== 'keepAll') {
        deck.set(action.row, plan.to, action.result);
        if (action.kind === 'merge') {
          merged++;
          log.warn(action.name, 'already had history in column ' + toLetter +
            '; the moved text was appended after it — worth an eyeball.');
        } else {
          moved++;
        }
      }
      if (action.keepText) {
        log.error(action.name, 'still has pre-' + CONFIG.HISTORY_CUTOFF + ' text in column ' +
          fromLetter + ' that will be lost when the column is deleted: "' +
          action.keepText + '"');
      }
    });

    deck.flush();

    showReport_('History Moved', '🔧 Repair Summary', [
      { label: 'Rows moved across', value: moved },
      { label: 'Rows merged (check these)', value: merged, alert: merged > 0 },
      { label: 'Rows still holding old text in ' + fromLetter,
        value: plan.leftBehind.length, alert: plan.leftBehind.length > 0 },
      { label: 'Already done (skipped)', value: plan.alreadyDone }
    ], log);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Menu entry: deletes the leftover column once its contents have been dealt
 * with. Refuses while anything recent is still sitting in it.
 */
function deleteLegacyHistoryColumn() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    showError_('Someone else is running a batch on this spreadsheet right now.');
    return;
  }

  try {
    const deckSheet = deckSheetOrThrow_();
    const plan = planHistoryColumnRepair_(deckSheet);
    const fromLetter = columnLetter_(plan.from);
    const movers = plan.actions.filter(function (a) { return a.kind !== 'keepAll'; });

    if (movers.length) {
      showError_('Not deleting column ' + fromLetter + ' yet — ' + movers.length +
        ' row(s) still hold history dated on or after ' + CONFIG.HISTORY_CUTOFF +
        ' that has not been moved. Run "Repair history column" first.');
      return;
    }

    const doomed = plan.leftBehind.length;
    const ui = SpreadsheetApp.getUi();
    const answer = ui.alert('Delete column ' + fromLetter + '?',
      (doomed
        ? doomed + ' row(s) still hold pre-' + CONFIG.HISTORY_CUTOFF + ' text in column ' +
          fromLetter + '. That text will be permanently deleted.\n\n'
        : 'Column ' + fromLetter + ' holds no history that needs keeping.\n\n') +
      'Column ' + columnLetter_(plan.to) + ' will shift left and become column ' +
      fromLetter + '.\n\nAfter this you MUST open Config.gs, change ' +
      'DECK_COL.ARCHIVE from ' + plan.to + ' to ' + plan.from + ', and save — ' +
      'otherwise the next EOD run writes history to the wrong column again.',
      ui.ButtonSet.OK_CANCEL);

    if (answer !== ui.Button.OK) return;

    deckSheet.deleteColumn(plan.from);

    showError_('Column ' + fromLetter + ' deleted. History now lives in column ' + fromLetter +
      ' again.\n\nDo this now: open Config.gs, set DECK_COL.ARCHIVE to ' + plan.from +
      ', save, then run Tools → Check setup to confirm.');
  } finally {
    lock.releaseLock();
  }
}

/**
 * Menu entry: shows which column each setting points at, next to whatever the
 * header row actually says there. Catches a mismatch like the one that sent
 * the history into the wrong column.
 */
function checkSheetSetup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wopSheet = ss.getSheetByName(CONFIG.SHEETS.WOP);
  const deckSheet = ss.getSheetByName(CONFIG.SHEETS.DECK);

  function describe(sheet, sheetLabel, columns) {
    if (!sheet) {
      return '<p style="color: #b91c1c;">✗ No sheet named "' + escapeHtml_(sheetLabel) + '".</p>';
    }
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn() || 1).getValues()[0];
    let rows = '';
    Object.keys(columns).forEach(function (key) {
      const col = columns[key];
      const header = String(headers[col - 1] === undefined ? '' : headers[col - 1]).trim();
      rows += '<tr><td style="padding: 3px 10px 3px 0;">' + escapeHtml_(key) + '</td>' +
        '<td style="padding: 3px 10px 3px 0;"><b>' + columnLetter_(col) + '</b></td>' +
        '<td style="padding: 3px 0; color: ' + (header ? '#334155' : '#b45309') + ';">' +
        escapeHtml_(header || '(header cell is blank)') + '</td></tr>';
    });
    return '<h4 style="margin: 14px 0 4px;">' + escapeHtml_(sheetLabel) + '</h4>' +
      '<table style="font-size: 13px;"><tr style="color: #64748b;"><td>Setting</td>' +
      '<td>Column</td><td>Header in row 1</td></tr>' + rows + '</table>';
  }

  const html = '<div style="font-family: Arial, sans-serif; font-size: 13px; padding: 10px; color: #1e293b;">' +
    '<p style="color: #4b5563; margin-top: 0;">What the script is pointed at. If a header ' +
    'here does not match what that column is really for, fix the number in Config.gs.</p>' +
    describe(wopSheet, CONFIG.SHEETS.WOP, CONFIG.WOP_COL) +
    describe(deckSheet, CONFIG.SHEETS.DECK, CONFIG.DECK_COL) +
    '</div>';

  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(460).setHeight(420), 'Check Setup');
}

/** 1 -> "A", 14 -> "N". */
function columnLetter_(index) {
  let letter = '';
  let n = index;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}
