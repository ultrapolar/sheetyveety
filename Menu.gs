/**
 * Builds the custom menus when the spreadsheet is opened.
 *
 * Menus are grouped by when you reach for them: SOD at the start of the day,
 * EOD at the end, and Tools for the things you set up once and then forget.
 * Nothing here runs anything on its own -- every entry is a deliberate click.
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();

  ui.createMenu('SOD')
    .addItem('Pinks Printed', 'processSodPinks')
    .addSeparator()
    .addItem('Organise rows from the seating chart', 'organizeSeatingRows')
    .addToUi();

  ui.createMenu('EOD')
    .addItem('Colored Sheets Batch Process', 'processWopToDeck')
    .addSeparator()
    .addItem('Radius import for highlighted rows', 'importRadiusData')
    .addItem('Seating chart for highlighted rows', 'importSeatingChart')
    .addToUi();

  ui.createMenu('Tools')
    .addItem('Check setup', 'checkSheetSetup')
    .addSeparator()
    .addItem('Set Radius session cookie', 'setRadiusCookie')
    .addItem('Test Radius connection', 'testRadiusConnection')
    .addToUi();
}
