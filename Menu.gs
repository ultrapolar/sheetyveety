/**
 * Builds the custom menus when the spreadsheet is opened.
 *
 * Grouped by when you reach for them, and by what they do to the sheet.
 *
 * SOD and EOD are the day's work: each entry reads the sheet, or fills it in.
 * Tools is everything else -- the checks and the Radius sign-in, set up once
 * and then forgotten, and none of which writes a student's data.
 *
 * Nothing here runs on its own. Every entry is a deliberate click. The Radius
 * and seating imports show you what they found before writing any of it; Auto
 * Attendance colours column A and nothing else, then says what it coloured.
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();

  ui.createMenu('SOD')
    .addItem('Jump to today', 'jumpToToday')
    .addItem('Start a new day', 'startNewDay')
    .addSeparator()
    .addItem('Paste the calendar — today', 'importCalendarToday')
    .addItem('Paste the calendar — tomorrow', 'importCalendarTomorrow')
    .addItem('Paste the calendar — pick a day', 'importCalendarPickDay')
    .addSeparator()
    .addItem('Pinks Printed', 'processSodPinks')
    // Parked at your request. organizeSeatingRows and everything it uses are
    // still there and still tested; putting this line back turns it on.
    // .addSeparator()
    // .addItem('Organise rows from the seating chart', 'organizeSeatingRows')
    .addToUi();

  ui.createMenu('EOD')
    .addItem('Colored Sheets Batch Process', 'processWopToDeck')
    .addSeparator()
    .addItem('Bring in Radius sessions (highlighted rows)', 'importRadiusData')
    .addItem('Bring in seating (highlighted rows)', 'importSeatingChart')
    .addSeparator()
    .addItem('Auto Attendance — today', 'radiusAttendanceToday')
    .addItem('Auto Attendance — pick a day', 'radiusAttendancePickDay')
    .addToUi();

  ui.createMenu('Changelog')
    .addItem('1. Create — date it and find the next session', 'changelogCreate')
    .addItem('2. Grade — change since last time, and stars', 'changelogGrade')
    .addItem('3. Learning plan — date it and count it', 'changelogLearningPlan')
    .addSeparator()
    .addItem('Draft a progress report (highlighted names)', 'draftProgressReport')
    .addToUi();

  ui.createMenu('Tools')
    .addItem('Check setup', 'checkSheetSetup')
    .addSeparator()
    .addItem('Radius: sign in (set session cookie)', 'setRadiusCookie')
    .addItem('Radius: test connection', 'testRadiusConnection')
    .addSeparator()
    .addItem('Seating chart: set the link', 'setSeatingSource')
    .addItem('Calendar: set the calendar', 'setSessionCalendar')
    .addToUi();
}
