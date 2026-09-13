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

  ui.createMenu('Radius')
    .addItem('Import for highlighted rows (also runs inside EOD)', 'importRadiusData')
    .addSeparator()
    .addItem('Set session cookie', 'setRadiusCookie')
    .addItem('Test connection', 'testRadiusConnection')
    .addToUi();

  ui.createMenu('Tools')
    .addItem('Check setup', 'checkSheetSetup')
    .addSeparator()
    .addItem('1. Repair history column (M → N)', 'repairHistoryColumn')
    .addItem('2. Delete leftover column M', 'deleteLegacyHistoryColumn')
    .addToUi();
}
