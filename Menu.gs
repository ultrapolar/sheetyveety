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

  const tools = ui.createMenu('Tools')
    .addItem('Check setup', 'checkSheetSetup');

  // The migration items disappear once Config.gs points the history back at
  // the legacy column (step 5 of the runbook). They also refuse to run if
  // reached some other way -- see assertHistoryMigrationPending_ in Repair.gs.
  if (!historyMigrationFinished_()) {
    tools
      .addSeparator()
      .addItem('1. Repair history column (M → N)', 'repairHistoryColumn')
      .addItem('2. Delete leftover column M', 'deleteLegacyHistoryColumn');
  }

  tools.addToUi();
}
