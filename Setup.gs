/**
 * Sheet setup check.
 *
 * A column inserted ahead of the history column once pushed it sideways while
 * the script carried on writing where it had always written, and nothing said
 * so. This is what says so.
 */

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
