/**
 * Sheet setup check.
 *
 * A column inserted ahead of the history column once pushed it sideways while
 * the script carried on writing where it had always written, and nothing said
 * so. This is what says so.
 */

// Readable names for the two Daily WOP columns that are not Radius fields.
const WOP_COL_LABELS_ = {
  NAME: 'Student name (highlight these)',
  STATUS: 'Deck update / paperwork'
};

/**
 * Every Daily WOP column the script touches, in sheet order.
 *
 * The two sides of the sheet are configured separately -- WOP_COL for the
 * columns EOD works with, RADIUS.FIELDS for the ones the import fills -- and
 * they legitimately overlap on K. Merging them here means the check shows the
 * sheet as it really is, one row per column, rather than one list per setting.
 */
function wopColumnPlan_() {
  const byColumn = {};

  function add(column, label) {
    if (!column) return;
    if (!byColumn[column]) byColumn[column] = { column: column, labels: [] };
    if (byColumn[column].labels.indexOf(label) === -1) byColumn[column].labels.push(label);
  }

  Object.keys(CONFIG.WOP_COL).forEach(function (key) {
    add(CONFIG.WOP_COL[key], WOP_COL_LABELS_[key] || key);
  });
  (CONFIG.RADIUS.FIELDS || []).forEach(function (field) {
    add(field.column, field.label);
  });

  return Object.keys(byColumn)
    .map(function (k) { return byColumn[k]; })
    .sort(function (a, b) { return a.column - b.column; });
}

function deckColumnPlan_() {
  return Object.keys(CONFIG.DECK_COL).map(function (key) {
    return { column: CONFIG.DECK_COL[key], labels: [key] };
  }).sort(function (a, b) { return a.column - b.column; });
}

/**
 * Reads a column's heading.
 *
 * Row 1 is sometimes left deliberately blank as a spacer, with the real
 * heading sitting in row 2, so a blank row 1 is not an answer -- look below it
 * before calling the column unlabelled.
 */
function headerFor_(rows, column) {
  for (let r = 0; r < rows.length; r++) {
    const cell = rows[r][column - 1];
    const text = String(cell === undefined || cell === null ? '' : cell).trim();
    if (text) return { text: text, row: r + 1 };
  }
  return { text: '', row: 0 };
}

/**
 * Menu entry: shows which column each setting points at, next to whatever the
 * sheet actually says is there. Catches a mismatch like the one that sent the
 * history into the wrong column.
 */
function checkSheetSetup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  function describe(sheetLabel, plan) {
    const sheet = ss.getSheetByName(sheetLabel);
    if (!sheet) {
      return '<p style="color: #b91c1c;">✗ No sheet named "' +
        escapeHtml_(sheetLabel) + '".</p>';
    }

    const lastColumn = sheet.getLastColumn() || 1;
    const headerRows = sheet.getRange(1, 1, Math.min(2, sheet.getLastRow() || 1),
      lastColumn).getValues();

    let rows = '';
    plan.forEach(function (entry) {
      const beyond = entry.column > lastColumn;
      const header = beyond ? { text: '', row: 0 } : headerFor_(headerRows, entry.column);

      let shown;
      let colour;
      if (beyond) {
        shown = '(past the last column on this sheet)';
        colour = '#b91c1c';
      } else if (header.text) {
        shown = header.text + (header.row > 1 ? '  (row ' + header.row + ')' : '');
        colour = '#334155';
      } else {
        shown = '(no heading in row 1 or 2)';
        colour = '#b45309';
      }

      rows += '<tr>' +
        '<td style="padding: 3px 10px 3px 0; white-space: nowrap;"><b>' +
        columnLetter_(entry.column) + '</b></td>' +
        '<td style="padding: 3px 14px 3px 0;">' +
        escapeHtml_(entry.labels.join(' · ')) + '</td>' +
        '<td style="padding: 3px 0; color: ' + colour + ';">' +
        escapeHtml_(shown) + '</td></tr>';
    });

    return '<h4 style="margin: 16px 0 4px;">' + escapeHtml_(sheetLabel) + '</h4>' +
      '<table style="font-size: 13px; border-collapse: collapse;">' +
      '<tr style="color: #64748b;"><td style="padding-right: 10px;">Column</td>' +
      '<td style="padding-right: 14px;">What the script uses it for</td>' +
      '<td>Heading on the sheet</td></tr>' + rows + '</table>';
  }

  const html = '<div style="font-family: Arial, sans-serif; font-size: 13px; ' +
    'padding: 10px; color: #1e293b;">' +
    '<p style="color: #4b5563; margin-top: 0;">Where the script is pointed, and ' +
    'what is actually sitting there. If a heading does not match what the ' +
    'column is really for, fix the number in Config.gs. A blank row 1 falls ' +
    'back to row 2.</p>' +
    describe(CONFIG.SHEETS.WOP, wopColumnPlan_()) +
    describe(CONFIG.SHEETS.DECK, deckColumnPlan_()) +
    '</div>';

  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(560).setHeight(620), 'Check Setup');
}
