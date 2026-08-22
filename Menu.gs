/**
 * Builds the custom menus when the spreadsheet is opened.
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();

  ui.createMenu('SOD')
    .addItem('Pinks Printed', 'processSodPinks')
    .addToUi();

  ui.createMenu('EOD')
    .addItem('Colored Sheets Batch Process', 'processWopToDeck')
    .addToUi();

  ui.createMenu('Tools')
    .addItem('Check setup', 'checkSheetSetup')
    .addSeparator()
    .addItem('Repair history column (M → N)', 'repairHistoryColumn')
    .addToUi();
}
