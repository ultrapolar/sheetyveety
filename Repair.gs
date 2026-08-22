/**
 * One-off repair tools for the Deck List.
 *
 * Until this was corrected, the EOD script wrote the task history into
 * column M instead of column N. Nothing was lost -- it simply accumulated one
 * column to the left. This moves it across.
 */

// Where the history used to be written by mistake.
const LEGACY_ARCHIVE_COL_ = 13; // M

/**
 * Works out what the repair would do, without changing anything.
 * Row 1 is treated as a header and left alone.
 */
function planHistoryColumnRepair_(deckSheet, includeFirstRow) {
  const values = deckSheet.getDataRange().getValues();
  const from = LEGACY_ARCHIVE_COL_;
  const to = CONFIG.DECK_COL.ARCHIVE;

  const actions = [];
  let untouched = 0;

  for (let r = includeFirstRow ? 0 : 1; r < values.length; r++) {
    const row = values[r];
    const stray = String(row.length >= from ? row[from - 1] : '').trim();
    if (!stray) continue;

    const name = String(row[CONFIG.DECK_COL.NAME - 1]).trim() || '(row ' + (r + 1) + ')';
    const current = String(row.length >= to ? row[to - 1] : '').trim();

    // Already merged by an earlier run of this repair.
    if (current && current.indexOf(stray) !== -1) {
      untouched++;
      continue;
    }

    actions.push({
      row: r + 1,
      name: name,
      kind: current ? 'merge' : 'move',
      existing: current,
      stray: stray,
      // Anything already in the destination keeps its place at the front.
      result: current ? current + CONFIG.ARCHIVE_SEPARATOR + stray : stray
    });
  }

  return { actions: actions, untouched: untouched, from: from, to: to };
}

/** Menu entry: shows the preview. */
function repairHistoryColumn() {
  let deckSheet;
  try {
    deckSheet = getSheets_().deck;
  } catch (err) {
    // The repair does not care which sheet is in front, only that it exists.
    deckSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.DECK);
    if (!deckSheet) {
      showError_('Could not find a sheet named "' + CONFIG.SHEETS.DECK + '".');
      return;
    }
  }

  const plan = planHistoryColumnRepair_(deckSheet, false);
  const fromLetter = columnLetter_(plan.from);
  const toLetter = columnLetter_(plan.to);

  if (!plan.actions.length) {
    showError_('Nothing to repair. Column ' + fromLetter + ' holds no history that is ' +
      'missing from column ' + toLetter +
      (plan.untouched ? ' (' + plan.untouched + ' row(s) already carried across).' : '.'));
    return;
  }

  const merges = plan.actions.filter(function (a) { return a.kind === 'merge'; });

  let html = '<div style="font-family: Arial, sans-serif; font-size: 13px; padding: 10px; color: #1e293b;">' +
    '<h3 style="margin-top: 0;">Move history from column ' + fromLetter +
    ' to column ' + toLetter + '</h3>' +
    '<p style="color: #4b5563;">' + plan.actions.length + ' row(s) have history stranded in ' +
    'column ' + fromLetter + '. Nothing has been changed yet.</p>';

  if (merges.length) {
    html += '<p style="color: #b45309;">' + merges.length + ' of them already have ' +
      'something in column ' + toLetter + '. For those, the existing text is kept first ' +
      'and the stranded text is appended after it — check those rows below.</p>';
  }

  html += '<div style="max-height: 240px; overflow-y: auto; border: 1px solid #e5e7eb; ' +
    'border-radius: 6px; padding: 8px; background: #f9fafb;"><table style="width: 100%; font-size: 12px;">';
  plan.actions.forEach(function (action) {
    html += '<tr style="border-bottom: 1px solid #eef2f7;">' +
      '<td style="padding: 4px 6px 4px 0; white-space: nowrap; vertical-align: top;">' +
      (action.kind === 'merge' ? '⚠️ ' : '') + escapeHtml_(action.name) + '</td>' +
      '<td style="padding: 4px 0; color: #475569;">' + escapeHtml_(action.result) + '</td></tr>';
  });
  html += '</table></div>';

  if (plan.untouched) {
    html += '<p style="color: #64748b; font-size: 12px;">' + plan.untouched +
      ' row(s) were carried across already and will be left alone.</p>';
  }

  html += '<p style="font-size: 12px; color: #64748b;">Row 1 is treated as a header and ' +
    'skipped. If your Deck List has no header row, move that one cell by hand.</p>' +
    '<label style="display: block; margin: 12px 0;">' +
    '<input type="checkbox" name="clearOld" checked> Clear column ' + fromLetter +
    ' once the text has been copied</label>' +
    '<form id="repairForm">' +
    '<input type="hidden" name="confirmed" value="yes">' +
    '<div id="err" style="display: none; margin: 10px 0; padding: 8px; background: #fef2f2; ' +
    'border: 1px solid #fecaca; border-radius: 4px; color: #b91c1c;"></div>' +
    '<button type="button" id="go" onclick="submitRepair()" style="width: 100%; padding: 10px; ' +
    'background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer; ' +
    'font-weight: bold;">Move ' + plan.actions.length + ' row(s)</button>' +
    '<button type="button" onclick="google.script.host.close()" style="width: 100%; padding: 8px; ' +
    'margin-top: 6px; background: none; color: #6b7280; border: none; cursor: pointer;">' +
    'Cancel — nothing will change</button></form>' +
    '<script>' +
    'function submitRepair() {' +
    '  var go = document.getElementById("go");' +
    '  var err = document.getElementById("err");' +
    '  err.style.display = "none"; go.disabled = true;' +
    '  go.textContent = "Working..."; go.style.background = "#9ca3af";' +
    '  var clear = document.getElementsByName("clearOld")[0].checked;' +
    '  google.script.run' +
    '    .withFailureHandler(function (e) {' +
    '      go.disabled = false; go.textContent = "Retry"; go.style.background = "#2563eb";' +
    '      err.textContent = "Nothing was changed. " + (e && e.message ? e.message : e);' +
    '      err.style.display = "block";' +
    '    })' +
    '    .applyHistoryColumnRepair(clear);' +
    '}' +
    '</script></div>';

  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(520).setHeight(560), 'Repair History Column');
}

/**
 * Callback from the preview. The plan is recomputed here rather than carried
 * over from the dialog, so it always acts on what the sheet holds right now.
 * Running it twice is harmless: rows already carried across are skipped.
 */
function applyHistoryColumnRepair(clearOld) {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    throw new Error('Someone else is running a batch on this spreadsheet right now.');
  }

  const log = ActionLog_();
  let moved = 0;
  let merged = 0;

  try {
    const deckSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.DECK);
    if (!deckSheet) throw new Error('Could not find the "' + CONFIG.SHEETS.DECK + '" sheet.');

    const plan = planHistoryColumnRepair_(deckSheet, false);
    const deck = DeckTable_(deckSheet);

    plan.actions.forEach(function (action) {
      deck.set(action.row, plan.to, action.result);
      if (clearOld) deck.set(action.row, plan.from, '');
      if (action.kind === 'merge') {
        merged++;
        log.warn(action.name, 'already had history in column ' + columnLetter_(plan.to) +
          '; the stranded text was appended after it — worth an eyeball.');
      } else {
        moved++;
      }
    });

    deck.flush();

    showReport_('History Column Repaired', '🔧 Repair Summary', [
      { label: 'Rows moved across', value: moved },
      { label: 'Rows merged (check these)', value: merged, alert: merged > 0 },
      { label: 'Already done (skipped)', value: plan.untouched },
      { label: 'Column ' + columnLetter_(plan.from) + ' cleared', value: clearOld ? 'yes' : 'no' }
    ], log);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Menu entry: shows which column each setting points at, next to whatever the
 * header row actually says there. Catches a mismatch like the one that sent
 * the history into column M for so long.
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
