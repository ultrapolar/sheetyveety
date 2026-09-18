'use strict';
const fs = require('fs');
const vm = require('vm');
const { FakeSheet, makeGrid, install, fixedDate } = require('./fakeSheets.js');

const SOURCES = ['Config.gs', 'Common.gs', 'Sod.gs', 'Day.gs', 'Eod.gs', 'Setup.gs', 'Radius.gs', 'Seating.gs', 'Changelog.gs', 'Progress.gs', 'Menu.gs'];

let passed = 0;
const failures = [];

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; } else { failures.push(`${label}\n    expected ${e}\n    actual   ${a}`); }
}
function checkTruthy(label, value) {
  if (value) { passed++; } else { failures.push(`${label}\n    expected truthy, got ${JSON.stringify(value)}`); }
}

// --- Load the script under test -------------------------------------------
function loadScript(context) {
  const source = SOURCES.map(f => fs.readFileSync(f, 'utf8')).join('\n;\n') + `
;globalThis.__api = {
  CONFIG, parseStatus_, extractName_, splitList_, normalizeColor_, isDoneColor_,
  escapeHtml_, columnLetter_, processWopToDeck, processSodPinks,
  executeSodOperations_FromUI, checkSheetSetup, wopColumnPlan_, headerFor_,
  looksLikeLoginPage_, radiusFetch_, importRadiusData, RADIUS_EXTRACTORS,
  parseRoster_, loadRoster_, dwpUrl_, radiusPostJson_,
  normalizeStudentName_, htmlCellText_,
  lookupRosterEntry_, testRadiusConnection,
  inputValueById_, textareaContentById_, tripleSwitchRaw_, tripleSwitchLabel_,
  dwpAssignmentRows_, assignmentCheckboxChecked_, pageStudentName_,
  extractRadiusFields_, checkedRadioValue_, checkedRadioLabel_, formatPkCode_,
  yesFlag_, CONFIG, mergeStatusLetters_, parseClockTime_, reviewSessionTiming_,
  buildRadiusPlan_, applyRadiusPlan_, applyRadiusPlan_FromUI,
  storeRadiusPlan_, loadRadiusPlan_,
  importSeatingChart, parseSeatingChart_, seatingMatchRank_,
  formatSeating_, rowLetterOf_, isTableNumber_, seatingCandidates_,
  organizeSeatingRows, planSeatingOrder_, hourSortKey_, hourLabel_,
  jumpToToday, startNewDay, parseDayHeader_, dayHeaderText_, dayHeaderRows_,
  seatingSheetName_, spreadsheetIdFromLink_, setSeatingSource, seatingLayout_,
  seatLabelLetter_, wallColumns_, seatingSpreadsheetId_,
  podOfTable_, resolveSeatingAlias_, rowSaysNotComing_,
  changelogColumnPlan_, changelogCreate, changelogGrade,
  changelogLearningPlan, percentValue_, starsFor_, nextSessionFor_,
  sessionCalendars_, calendarNames_, eventNameFields_, setSessionCalendar,
  calendarIdFromLink_, looksLikeCalendarId_, saveSessionCalendar_FromUI,
  allCalendars_,
  previousAssessment_, monthDay_, dayLabel_, monthDayValue_,
  setRadiusCookie, saveRadiusCookie_FromUI, normalizeCookieString_,
  cookieComplaint_,
  draftProgressReport, nameColumnFor_, highlightedStudents_, upcomingTopics_,
  masteredTopics_, progressDraft_, topicLines_, PROGRESS_EXTRACTORS,
  progressAssessmentUrl_
};`;
  vm.runInContext(source, context);
  return context.__api;
}

function scenario(deckRows, wopRows, selection, today) {
  const deckValues = deckRows.map(r => {
    const row = r.slice();
    while (row.length < 13) row.push('');
    return row;
  });
  // A real sheet is 26 columns wide by default; the Radius import writes as
  // far right as Q, so the fixture has to be at least that wide too.
  const wopValues = wopRows.map(r => {
    const row = [r.name];
    while (row.length < 10) row.push('');
    row.push(r.status === undefined ? '' : r.status);
    while (row.length < 26) row.push('');
    return row;
  });
  const wopBg = makeGrid(wopValues.length, 26, '#ffffff');
  wopRows.forEach((r, i) => {
    if (r.nameBg) wopBg[i][0] = r.nameBg;
    if (r.statusBg) wopBg[i][10] = r.statusBg;
  });

  const deck = new FakeSheet('Deck List', deckValues);
  const wop = new FakeSheet('Daily WOP', wopValues, wopBg);
  wop.setSelection(selection.start, selection.rows);

  // Pinned by default. These tests assert dated archive entries, and used to
  // pass on the real clock only because the fake's formatDate ignored its
  // pattern and handed back the day they happened to be written on.
  const context = vm.createContext({ console, Buffer, JSON, Math,
    Date: fixedDate(today || '2026-08-22'), String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  const harness = install(context, [deck, wop], 'Daily WOP');
  const api = loadScript(context);
  return { deck, wop, harness, api, context,
    deckCell: (row, col) => String(deck.values[row - 1][col - 1]),
    wopStatus: i => String(wop.values[selection.start - 1 + i][10]),
    wopStatusBg: i => String(wop.backgrounds[selection.start - 1 + i][10]),
    wopNameBg: i => String(wop.backgrounds[selection.start - 1 + i][0]),
    /** Everything the operator was shown, alerts and dialogs alike. */
    said: () => harness.alerts.concat(harness.dialogs.map(d => d.html)).join(' ') };
}

/**
 * Drives the whole import: fetch, then answer the preview dialog. Returns the
 * preview dialog so a test can assert on what the operator was shown.
 */
function confirmRadiusImport(s, options) {
  const opts = options || {};
  s.api.importRadiusData();

  const preview = s.harness.dialogs[s.harness.dialogs.length - 1];
  if (!preview || preview.title !== 'Confirm Radius import') return preview;

  const token = (preview.html.match(/name="token" value="([^"]+)"/) || [])[1];
  const form = { token: token, mode: opts.mode || 'overwrite' };

  const picks = preview.html.match(/name="pick_(\d+)"/g) || [];
  picks.forEach(function (m) {
    const index = m.match(/\d+/)[0];
    if (opts.only && opts.only.indexOf(Number(index)) === -1) return;
    form['pick_' + index] = 'on';
  });

  if (opts.picked === false) { /* leave every box unticked */ }
  s.api.applyRadiusPlan_FromUI(form);
  return preview;
}

/** The report shown after the import, which is always the last dialog. */
function lastDialog(s) {
  return s.harness.dialogs[s.harness.dialogs.length - 1];
}

// ==========================================================================
// Pure parsing
// ==========================================================================
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  const st = raw => { const s = api.parseStatus_(raw); return s ? [s.core, s.yCount, s.pCount] : null; };

  check('parseStatus "Y"', st('Y'), ['Y', 1, 0]);
  check('parseStatus "YY"', st('YY'), ['YY', 2, 0]);
  check('parseStatus "YP"', st('YP'), ['YP', 1, 1]);
  check('parseStatus "PY"', st('PY'), ['PY', 1, 1]);
  check('parseStatus "P"', st('P'), ['P', 0, 1]);
  check('parseStatus "YPP" (multi-P)', st('YPP'), ['YPP', 1, 2]);
  check('parseStatus lowercase "yp"', st('yp'), ['YP', 1, 1]);
  check('parseStatus legacy "Y - B empty?"', st('Y - B empty?'), ['Y', 1, 0]);
  check('parseStatus new "YYP - B empty?"', st('YYP - B empty?'), ['YYP', 2, 1]);
  check('parseStatus "YY (2 of 3 done, ran out)"', st('YY (2 of 3 done, ran out)'), ['YY', 2, 0]);
  check('parseStatus legacy "(ran out of tasks)"', st('YY (ran out of tasks)'), ['YY', 2, 0]);
  check('parseStatus blank', st('   '), null);
  check('parseStatus "N"', st('N'), null);
  check('parseStatus "YES"', st('YES'), null);
  check('parseStatus "Y/P"', st('Y/P'), null);

  check('extractName plain', api.extractName_('Jane Doe'), 'Jane Doe');
  check('extractName "10:30 AM Jane Doe"', api.extractName_('10:30 AM Jane Doe'), 'Jane Doe');
  check('extractName "9 Jane Doe"', api.extractName_('9 Jane Doe'), 'Jane Doe');
  check('extractName "10:30am-11:00am Jane Doe"', api.extractName_('10:30am-11:00am Jane Doe'), 'Jane Doe');
  check('extractName "9 - 10 Jane Doe"', api.extractName_('9 - 10 Jane Doe'), 'Jane Doe');
  check('extractName "3:15 PM - Jane Doe"', api.extractName_('3:15 PM - Jane Doe'), 'Jane Doe');
  check('extractName "9:00 to 9:45 Jane Doe"', api.extractName_('9:00 to 9:45 Jane Doe'), 'Jane Doe');
  // The Daily WOP is typed as "H:MM Student Name", with no am/pm.
  check('extractName "3:30 Jane Doe"', api.extractName_('3:30 Jane Doe'), 'Jane Doe');
  check('extractName "11:00 JANE DOE"', api.extractName_('11:00 JANE DOE'), 'JANE DOE');
  check('extractName keeps a name that merely starts with a digit',
    api.extractName_('4Kids Doe'), '4Kids Doe');
  check('extractName blank', api.extractName_('   '), '');
  check('extractName time only', api.extractName_('10:30 AM'), '');

  check('splitList basic', api.splitList_('A, B,C'), ['A', 'B', 'C']);
  check('splitList drops blanks', api.splitList_('A, , B,'), ['A', 'B']);
  check('splitList empty', api.splitList_(''), []);

  check('normalizeColor uppercase', api.normalizeColor_('#00FF00'), '#00ff00');
  check('normalizeColor shorthand', api.normalizeColor_('#0F0'), '#00ff00');
  checkTruthy('isDoneColor #00FF00', api.isDoneColor_('#00FF00'));
  checkTruthy('isDoneColor #0f0', api.isDoneColor_('#0f0'));
  checkTruthy('isDoneColor white is false', !api.isDoneColor_('#ffffff'));
  checkTruthy('isDoneColor yellow is false', !api.isDoneColor_('#ffff00'));

  check('escapeHtml', api.escapeHtml_('<b>&"x"</b>'),
    '&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;');
}

// ==========================================================================
// EOD
// ==========================================================================
// The DWP fixtures are real pages from 09/12/2026, but the sheet-level tests
// run on a pinned clock. The import refuses a session from another day, so the
// page is stamped with the day under test; 45i below is where the refusal
// itself is exercised, using the fixture's real date against another day.
const DWP_TODAY = '8/22/2026';
function dwp(which, onDate) {
  return fs.readFileSync('tests/fixtures/dwp-' + which + '.html', 'utf8')
    .replace(/<span id="SessionDate">[^<]*<\/span>/,
      '<span id="SessionDate">' + (onDate || DWP_TODAY) + '</span>');
}

// The roster arrives as JSON, not as a page. The Instruction Manager builds its
// student grid in the browser, so its HTML carries no students at all -- this
// is the call that grid is filled from, and it hands over ids, not links.
function rosterReply(students) {
  return JSON.stringify({
    Status: 'Success',
    DataSource: students.map((entry, i) => {
      const row = typeof entry === 'string' ? { name: entry } : entry;
      return {
        StudentName: row.name,
        StudentId: row.studentId === undefined ? 1000 + i : row.studentId,
        AttendanceId: row.attendanceId === undefined ? 2000 + i : row.attendanceId,
        DWPEntryId: row.dwpEntryId === undefined ? 3000 + i : row.dwpEntryId,
        CenterId: 2514
      };
    })
  });
}

const HEADER = ['Name', 'Current', 'Pink', '', 'Loaded', 'Queue', '', '', '', '', '', '', 'Archive'];
const C = { NAME: 1, CURRENT: 2, PINK: 3, LOADED: 5, QUEUE: 6, ARCHIVE: 13 };

// The Deck List's first 3 rows carry no student: row 1 is the header and
// rows 2-3 are a legend. Tests that care about row numbers put these ahead of
// any real data so the numbering matches a real sheet.
const DECK_FILLER_ROWS = [
  ['LEGEND', '', '', '', '', '', '', '', '', '', '', ''],
  ['(instructions)', '', '', '', '', '', '', '', '', '', '', '']
];

// These two run first, and on the source text rather than on behaviour: a
// mistyped config path takes down whatever runs next, and a stack trace
// from three files away is a poor way to learn the name of the typo.
// 0a. Every config path the code reads actually exists.
//
//      CONFIG.RADIUS.CACHE_TTL_SECONDS was read for weeks while the key lived
//      on CONFIG, one level up. JavaScript hands back undefined for that and
//      says nothing, so it surfaced as an Apps Script signature error at the
//      very last step of a run. This is the cheap way to never repeat it.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);

  const source = SOURCES.map(f => fs.readFileSync(f, 'utf8')).join('\n');
  const missing = [];
  const seen = {};

  (source.match(/CONFIG(?:\.[A-Z_]+)+/g) || []).forEach(function (path) {
    if (seen[path]) return;
    seen[path] = true;
    let node = api.CONFIG;
    path.split('.').slice(1).forEach(function (key) {
      node = (node && typeof node === 'object' && key in node) ? node[key] : undefined;
    });
    if (node === undefined) missing.push(path);
  });

  check('config: every path the code reads is defined', missing, []);
  checkTruthy('config: the check is actually looking at something',
    Object.keys(seen).length > 20);

  // Stop here rather than carry on. An undefined config value takes down
  // whatever reads it, and that crash ends the run before the summary is ever
  // printed -- so the one line naming the typo would never be seen.
  if (missing.length) {
    console.error('\nUndefined config path(s): ' + missing.join(', '));
    process.exit(1);
  }
}

// 0b. Nothing is left defined but unreachable.
//
//      Removals across this project have twice orphaned a function: one when
//      EOD stopped calling the import, one when a matcher was replaced. Dead
//      code is not harmful in itself, but it is read as live when the next
//      change comes along.
{
  const menu = fs.readFileSync('Menu.gs', 'utf8');
  const sources = SOURCES.map(f => fs.readFileSync(f, 'utf8')).join('\n');

  const dead = (sources.match(/^function\s+([A-Za-z0-9_$]+)/gm) || [])
    .map(m => m.replace(/^function\s+/, ''))
    .filter(function (name) {
      if (name === 'onOpen') return false;                  // the entry point
      if (menu.indexOf("'" + name + "'") !== -1) return false;  // a menu action
      const uses = sources.match(new RegExp('\\b' + name + '\\b', 'g')) || [];
      return uses.length <= 1;                              // its own definition
    });

  check('no function is defined without a caller', dead, []);

  // A menu entry naming a function that no longer exists looks perfectly fine
  // until somebody clicks it, and then fails in front of them.
  const actions = (menu.match(/addItem\('[^']*', '([^']*)'\)/g) || [])
    .map(m => m.replace(/^.*', '/, '').replace(/'\)$/, ''));
  const unresolved = actions.filter(function (name) {
    return !new RegExp('function\\s+' + name + '\\s*\\(').test(sources);
  });
  check('every menu entry names a function that exists', unresolved, []);
  checkTruthy('menu: the check found the entries at all', actions.length >= 8);

  // The menus are split by what an entry does to the sheet, not by which
  // feature wrote it. SOD and EOD are the day's work and fill the sheet in;
  // Tools is the checks and the Radius sign-in, none of which touches a
  // student's data. An auth or diagnostic entry drifting into EOD would put a
  // sign-in box in the middle of somebody's end-of-day run.
  const menus = {};
  menu.split(/ui\.createMenu\(/).slice(1).forEach(function (block) {
    const name = (block.match(/^'([^']+)'/) || [])[1];
    if (!name) return;
    menus[name] = (block.match(/addItem\('[^']*', '([^']*)'\)/g) || [])
      .map(m => m.replace(/^.*', '/, '').replace(/'\)$/, ''));
  });

  const belongsInTools = ['setRadiusCookie', 'testRadiusConnection', 'checkSheetSetup'];
  const belongsInEod = ['importRadiusData', 'importSeatingChart', 'processWopToDeck'];

  check('auth and checks live under Tools',
    belongsInTools.filter(n => (menus.Tools || []).indexOf(n) === -1), []);
  check('and nowhere else',
    belongsInTools.filter(function (n) {
      return (menus.SOD || []).indexOf(n) !== -1 || (menus.EOD || []).indexOf(n) !== -1;
    }), []);
  check('the day\'s transfers live under EOD',
    belongsInEod.filter(n => (menus.EOD || []).indexOf(n) === -1), []);
  check('Tools writes no student data',
    (menus.Tools || []).filter(n => belongsInEod.indexOf(n) !== -1), []);

  // Apps Script's document lock is not reentrant. A tool that takes it and
  // then calls another that does the same gets tryLock returning false and
  // tells the user "another run is in progress" about itself -- which is a
  // baffling thing to be told. EOD used to call the import and only avoided
  // this because the import deliberately took no lock of its own.
  const bodies = sources.split(/^function\s+/m).slice(1);
  const locking = bodies.filter(b => b.indexOf('tryLock') !== -1)
    .map(b => b.match(/^([A-Za-z0-9_$]+)/)[1]);
  const nested = [];
  bodies.forEach(function (body) {
    const name = body.match(/^([A-Za-z0-9_$]+)/)[1];
    if (locking.indexOf(name) === -1) return;
    locking.forEach(function (other) {
      if (other === name) return;
      if (new RegExp('\\b' + other + '\\s*\\(').test(body)) {
        nested.push(name + ' calls ' + other);
      }
    });
  });
  check('no tool takes the document lock inside another', nested, []);
  checkTruthy('lock: the check found the tools at all', locking.length >= 5);

  if (dead.length || unresolved.length || nested.length) {
    if (dead.length) console.error('\nUnreachable function(s): ' + dead.join(', '));
    if (unresolved.length) {
      console.error('\nMenu entries with no such function: ' + unresolved.join(', '));
    }
    if (nested.length) console.error('\nNested document lock: ' + nested.join(', '));
    process.exit(1);
  }
}

// 1. Single Y advances one task.
{
  const s = scenario(
    [HEADER, ['Jane Doe', 'T1', '', '', 'T2, T3', '', '', '', '', '', '', '', '']],
    [{ name: '10:30 AM Jane Doe', status: 'Y' }],
    { start: 1, rows: 1 });
  s.api.processWopToDeck();
  check('EOD single Y: B', s.deckCell(2, C.CURRENT), 'T2');
  check('EOD single Y: E', s.deckCell(2, C.LOADED), 'T3');
  check('EOD single Y: M', s.deckCell(2, C.ARCHIVE), 'T1 08/22');
  check('EOD single Y: K text', s.wopStatus(0), 'Y');
  check('EOD single Y: K green', s.wopStatusBg(0), '#00ff00');
}

// 2. Two Y's advance twice.
{
  const s = scenario(
    [HEADER, ['Jane Doe', 'T1', '', '', 'T2, T3', '', '', '', '', '', '', '', 'OLD 01/01']],
    [{ name: 'Jane Doe', status: 'YY' }],
    { start: 1, rows: 1 });
  s.api.processWopToDeck();
  check('EOD YY: B', s.deckCell(2, C.CURRENT), 'T3');
  check('EOD YY: E', s.deckCell(2, C.LOADED), '');
  check('EOD YY: M', s.deckCell(2, C.ARCHIVE), 'OLD 01/01 | T1 08/22 | T2 08/22');
  check('EOD YY: K green', s.wopStatusBg(0), '#00ff00');
}

// 3. THE FIX: B empty with "YYP" preserves the instruction and applies nothing.
{
  const s = scenario(
    [HEADER, ['Jane Doe', '', '', '', 'T2', '', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe', status: 'YYP' }],
    { start: 1, rows: 1 });
  s.api.processWopToDeck();
  check('EOD B-empty: K preserves letters', s.wopStatus(0), 'YYP - B empty?');
  check('EOD B-empty: K yellow', s.wopStatusBg(0), '#ffff00');
  check('EOD B-empty: pink NOT applied', s.deckCell(2, C.PINK), '');
  check('EOD B-empty: E untouched', s.deckCell(2, C.LOADED), 'T2');
  check('EOD B-empty: M untouched', s.deckCell(2, C.ARCHIVE), '');
}

// 4. Recovery re-run of case 3 does the full original job.
{
  const s = scenario(
    [HEADER, ['Jane Doe', 'T1', '', '', 'T2, T3', '', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe', status: 'YYP - B empty?', statusBg: '#ffff00' }],
    { start: 1, rows: 1 });
  s.api.processWopToDeck();
  check('EOD recovery: advanced twice', s.deckCell(2, C.CURRENT), 'T3');
  check('EOD recovery: archive has both', s.deckCell(2, C.ARCHIVE), 'T1 08/22 | T2 08/22');
  check('EOD recovery: pink applied', s.deckCell(2, C.PINK), 'pink');
  check('EOD recovery: K green', s.wopStatusBg(0), '#00ff00');
  check('EOD recovery: K normalised', s.wopStatus(0), 'YYP');
}

// 5. THE OTHER FIX: running out records the REMAINING work, not the completed work.
{
  const s = scenario(
    [HEADER, ['Jane Doe', 'T1', '', '', 'T2', '', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe', status: 'YYY' }],
    { start: 1, rows: 1 });
  s.api.processWopToDeck();
  check('EOD ran out: archived 2', s.deckCell(2, C.ARCHIVE), 'T1 08/22 | T2 08/22');
  check('EOD ran out: B empty', s.deckCell(2, C.CURRENT), '');
  check('EOD ran out: K shows 1 remaining', s.wopStatus(0), 'Y (2 of 3 done, ran out)');
  check('EOD ran out: K yellow', s.wopStatusBg(0), '#ffff00');
}

// 5b. Re-running that row after topping up does exactly 1 more, not 2.
{
  const s = scenario(
    [HEADER, ['Jane Doe', 'T3', '', '', 'T4', '', '', '', '', '', '', '', 'T1 08/22 | T2 08/22']],
    [{ name: 'Jane Doe', status: 'Y (2 of 3 done, ran out)', statusBg: '#ffff00' }],
    { start: 1, rows: 1 });
  s.api.processWopToDeck();
  check('EOD ran-out re-run: only one more archived',
    s.deckCell(2, C.ARCHIVE), 'T1 08/22 | T2 08/22 | T3 08/22');
  check('EOD ran-out re-run: B advanced once', s.deckCell(2, C.CURRENT), 'T4');
  check('EOD ran-out re-run: K green', s.wopStatusBg(0), '#00ff00');
}

// 6. Multiple P's apply one pink and warn.
{
  const s = scenario(
    [HEADER, ['Jane Doe', 'T1', '', '', '', '', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe', status: 'YPP' }],
    { start: 1, rows: 1 });
  s.api.processWopToDeck();
  check('EOD multi-P: one pink', s.deckCell(2, C.PINK), 'pink');
  check('EOD multi-P: K green', s.wopStatusBg(0), '#00ff00');
  checkTruthy('EOD multi-P: warned in report',
    lastDialog(s).html.includes('only one pink was applied'));
}

// 7. Unknown name is flagged red and changes nothing.
{
  const s = scenario(
    [HEADER, ['Jane Doe', 'T1', '', '', '', '', '', '', '', '', '', '', '']],
    [{ name: 'John Smith', status: 'Y' }],
    { start: 1, rows: 1 });
  s.api.processWopToDeck();
  check('EOD unknown name: K red', s.wopStatusBg(0), '#ffcccc');
  check('EOD unknown name: deck untouched', s.deckCell(2, C.CURRENT), 'T1');
}

// 8. Duplicate names are refused rather than guessed at.
{
  const s = scenario(
    [HEADER,
     ['Jane Doe', 'T1', '', '', '', '', '', '', '', '', '', '', ''],
     ['Jane Doe', 'T9', '', '', '', '', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe', status: 'Y' }],
    { start: 1, rows: 1 });
  s.api.processWopToDeck();
  check('EOD duplicate: K red', s.wopStatusBg(0), '#ffcccc');
  check('EOD duplicate: first row untouched', s.deckCell(2, C.CURRENT), 'T1');
  check('EOD duplicate: second row untouched', s.deckCell(3, C.CURRENT), 'T9');
  checkTruthy('EOD duplicate: explained',
    lastDialog(s).html.includes('more than once'));
}

// 9. Rows already green are skipped.
{
  const s = scenario(
    [HEADER, ['Jane Doe', 'T1', '', '', 'T2', '', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe', status: 'Y', statusBg: '#00FF00' }],
    { start: 1, rows: 1 });
  s.api.processWopToDeck();
  check('EOD green row: untouched', s.deckCell(2, C.CURRENT), 'T1');
}

// 10. Same student twice in one selection advances twice (write-through cache).
{
  const s = scenario(
    [HEADER, ['Jane Doe', 'T1', '', '', 'T2, T3', '', '', '', '', '', '', '', '']],
    [{ name: '9:00 AM Jane Doe', status: 'Y' },
     { name: '2:00 PM Jane Doe', status: 'Y' }],
    { start: 1, rows: 2 });
  s.api.processWopToDeck();
  check('EOD twice in selection: B', s.deckCell(2, C.CURRENT), 'T3');
  check('EOD twice in selection: M', s.deckCell(2, C.ARCHIVE), 'T1 08/22 | T2 08/22');
  check('EOD twice in selection: both green',
    [s.wopStatusBg(0), s.wopStatusBg(1)], ['#00ff00', '#00ff00']);
}

// 11. P only, no Y, leaves the task columns alone.
{
  const s = scenario(
    [HEADER, ['Jane Doe', 'T1', '', '', 'T2', '', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe', status: 'P' }],
    { start: 1, rows: 1 });
  s.api.processWopToDeck();
  check('EOD P only: pink set', s.deckCell(2, C.PINK), 'pink');
  check('EOD P only: B untouched', s.deckCell(2, C.CURRENT), 'T1');
  check('EOD P only: M untouched', s.deckCell(2, C.ARCHIVE), '');
}

// 12. Archive column beyond the populated data range still writes a real value.
{
  const narrowDeck = [['Name', 'Current'], ['Jane Doe', 'T1']];
  const deck = new FakeSheet('Deck List', narrowDeck.map(r => {
    const row = r.slice(); while (row.length < 13) row.push(''); return row;
  }));
  // Simulate getDataRange() stopping at column B by shrinking the reported grid.
  deck.getDataRange = function () {
    const FakeRangeCtor = Object.getPrototypeOf(this.getRange(1, 1, 1, 1)).constructor;
    return new FakeRangeCtor(this, 1, 1, this.values.length, 2);
  };
  const wopValues = [['Jane Doe', '', '', '', '', '', '', '', '', '', 'Y']];
  const wop = new FakeSheet('Daily WOP', wopValues, makeGrid(1, 11, '#ffffff'));
  wop.setSelection(1, 1);
  const context = vm.createContext({ console, Buffer, JSON, Math,
    Date: fixedDate('2026-08-22'), String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(context, [deck, wop], 'Daily WOP');
  const api = loadScript(context);
  api.processWopToDeck();
  check('EOD narrow deck: archive written cleanly',
    String(deck.values[1][12]), 'T1 08/22');
  // Everything between where the read stopped and the archive column had to be
  // padded to get there. Padding with undefined would write the word.
  check('EOD narrow deck: no "undefined" leaked into the padded cells',
    deck.values[1].slice(2, 12).join('|'), '|||||||||');
}

// 12a. A history column that has run out of room stops that student rather
//      than risking a write that throws partway through the batch.
{
  const full = 'OLD 01/01'.padEnd(49500, 'x');
  const s = scenario(
    [HEADER, ['Jane Doe', 'T1', '', '', 'T2, T3', '', '', '', '', '', '', '', full],
             ['John Roe', 'S1', '', '', 'S2', '', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe', status: 'YP' },
     { name: 'John Roe', status: 'Y' }],
    { start: 1, rows: 2 });
  s.api.processWopToDeck();

  check('EOD full history: the task is not advanced',
    s.deckCell(2, C.CURRENT), 'T1');
  check('EOD full history: the queue is left alone',
    s.deckCell(2, C.LOADED), 'T2, T3');
  check('EOD full history: the history is left alone',
    s.deckCell(2, C.ARCHIVE), full);
  // The pink is part of the same instruction, so it waits with the rest.
  check('EOD full history: the pink waits too', s.deckCell(2, C.PINK), '');
  checkTruthy('EOD full history: column K keeps the whole instruction',
    s.wopStatus(0).indexOf('YP') === 0);
  check('EOD full history: and is flagged as needing attention',
    s.wopStatusBg(0), s.api.CONFIG.COLOR.ERROR);
  checkTruthy('EOD full history: the reason names the column and says what to do',
    s.said().includes('run out of room'));

  // One student's full history must not cost everybody else their run.
  check('EOD full history: the next student is unaffected',
    [s.deckCell(3, C.CURRENT), s.deckCell(3, C.ARCHIVE)], ['S2', 'S1 08/22']);
}

// 12b. The history goes down before the column that moves the student off it.
//      A flush that fails partway can then only ever repeat a task, never lose
//      one from the record.
{
  const s = scenario(
    [HEADER, ['Jane Doe', 'T1', '', '', 'T2', '', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe', status: 'Y' }],
    { start: 1, rows: 1 });
  const order = [];
  const realGetRange = s.deck.getRange.bind(s.deck);
  s.deck.getRange = function (row, col, numRows, numCols) {
    if (order.indexOf(col) === -1) order.push(col);
    return realGetRange(row, col, numRows, numCols);
  };
  s.api.processWopToDeck();
  checkTruthy('EOD flush order: the archive column is written first',
    order.length > 1 && order[0] === C.ARCHIVE);
  checkTruthy('EOD flush order: the current column is written after it',
    order.indexOf(C.CURRENT) > order.indexOf(C.ARCHIVE));
}

// ==========================================================================
// SOD
// ==========================================================================

// 13. Single queue item moves automatically.
{
  const s = scenario(
    [HEADER, ['Jane Doe', '', 'pink', '', '', 'Q1', '', '', '', '', '', '', '']],
    [{ name: '10:30 AM Jane Doe' }],
    { start: 1, rows: 1 });
  s.api.processSodPinks();
  check('SOD single: E', s.deckCell(2, C.LOADED), 'Q1');
  check('SOD single: F emptied', s.deckCell(2, C.QUEUE), '');
  check('SOD single: pink cleared', s.deckCell(2, C.PINK), '');
  check('SOD single: A green', s.wopNameBg(0), '#00ff00');
}

// 14. Two or more SD items move up to and including the first SD, no prompt.
{
  const s = scenario(
    [HEADER, ['Jane Doe', '', 'pink', '', '', 'A, SD1, B, SD2', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe' }],
    { start: 1, rows: 1 });
  s.api.processSodPinks();
  check('SOD multi-SD: E', s.deckCell(2, C.LOADED), 'A, SD1');
  check('SOD multi-SD: F', s.deckCell(2, C.QUEUE), 'B, SD2');
  check('SOD multi-SD: no prompt', s.harness.dialogs[0].title, 'SOD Complete');
}

// 15. Ambiguous queue prompts, and writes nothing until the dialog is answered.
{
  const s = scenario(
    [HEADER, ['Jane Doe', '', 'pink', '', '', 'A, B, C', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe' }],
    { start: 1, rows: 1 });
  s.api.processSodPinks();
  check('SOD prompt: dialog shown', s.harness.dialogs[0].title, 'Action Required');
  check('SOD prompt: nothing written yet', s.deckCell(2, C.QUEUE), 'A, B, C');
  check('SOD prompt: pink still set', s.deckCell(2, C.PINK), 'pink');
  check('SOD prompt: row not green', s.wopNameBg(0), '#ffffff');

  s.api.executeSodOperations_FromUI({ token: 'uuid-1', move_0: '2' });
  check('SOD prompt: E after answer', s.deckCell(2, C.LOADED), 'A, B');
  check('SOD prompt: F after answer', s.deckCell(2, C.QUEUE), 'C');
  check('SOD prompt: pink cleared', s.deckCell(2, C.PINK), '');
  check('SOD prompt: A green', s.wopNameBg(0), '#00ff00');
}

// 16. THE FIX: a zero or negative count can no longer empty Column E.
{
  const s = scenario(
    [HEADER, ['Jane Doe', '', 'pink', '', '', 'A, B, C', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe' }],
    { start: 1, rows: 1 });
  s.api.processSodPinks();
  s.api.executeSodOperations_FromUI({ token: 'uuid-1', move_0: '0' });
  check('SOD zero clamped to 1: E', s.deckCell(2, C.LOADED), 'A');
  check('SOD zero clamped to 1: F', s.deckCell(2, C.QUEUE), 'B, C');
}

// 17. A count above the queue length is clamped down.
{
  const s = scenario(
    [HEADER, ['Jane Doe', '', 'pink', '', '', 'A, B', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe' }],
    { start: 1, rows: 1 });
  s.api.processSodPinks();
  s.api.executeSodOperations_FromUI({ token: 'uuid-1', move_0: '99' });
  check('SOD over-count clamped: E', s.deckCell(2, C.LOADED), 'A, B');
  check('SOD over-count clamped: F', s.deckCell(2, C.QUEUE), '');
}

// 18. Column E already occupied is refused.
{
  const s = scenario(
    [HEADER, ['Jane Doe', '', 'pink', '', 'ALREADY', 'Q1', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe' }],
    { start: 1, rows: 1 });
  s.api.processSodPinks();
  check('SOD E occupied: A red', s.wopNameBg(0), '#ffcccc');
  check('SOD E occupied: E untouched', s.deckCell(2, C.LOADED), 'ALREADY');
  check('SOD E occupied: pink kept', s.deckCell(2, C.PINK), 'pink');
}

// 19. Empty Column F queue is refused.
{
  const s = scenario(
    [HEADER, ['Jane Doe', '', 'pink', '', '', '', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe' }],
    { start: 1, rows: 1 });
  s.api.processSodPinks();
  check('SOD empty queue: A red', s.wopNameBg(0), '#ffcccc');
  checkTruthy('SOD empty queue: explained',
    lastDialog(s).html.includes('queue is empty'));
}

// 20. A student who is not pink is skipped and counted, not flagged.
{
  const s = scenario(
    [HEADER, ['Jane Doe', '', '', '', '', 'Q1', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe' }],
    { start: 1, rows: 1 });
  s.api.processSodPinks();
  check('SOD not pink: F untouched', s.deckCell(2, C.QUEUE), 'Q1');
  check('SOD not pink: not flagged red', s.wopNameBg(0), '#ffffff');
  checkTruthy('SOD not pink: reported',
    s.harness.alerts.length === 1 && s.harness.alerts[0].includes('not marked pink'));
}

// 21. A Deck List row that shifted while the dialog was open is refused.
{
  const s = scenario(
    [HEADER, ['Jane Doe', '', 'pink', '', '', 'A, B, C', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe' }],
    { start: 1, rows: 1 });
  s.api.processSodPinks();
  // Someone renames the row out from under the pending dialog.
  s.deck.values[1][0] = 'Someone Else';
  s.api.executeSodOperations_FromUI({ token: 'uuid-1', move_0: '2' });
  check('SOD stale row: queue untouched', s.deckCell(2, C.QUEUE), 'A, B, C');
  checkTruthy('SOD stale row: explained',
    s.harness.dialogs[1].html.includes('Deck List changed'));
}

// 22. An expired dialog fails loudly instead of writing anything.
{
  const s = scenario(
    [HEADER, ['Jane Doe', '', 'pink', '', '', 'A, B, C', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe' }],
    { start: 1, rows: 1 });
  s.api.processSodPinks();
  let threw = '';
  try {
    s.api.executeSodOperations_FromUI({ token: 'no-such-token', move_0: '2' });
  } catch (e) { threw = e.message; }
  checkTruthy('SOD expired dialog: throws', threw.includes('expired'));
  check('SOD expired dialog: nothing written', s.deckCell(2, C.QUEUE), 'A, B, C');
}

// 23. Names carrying HTML are escaped in the report.
{
  const s = scenario(
    [HEADER, ['Jane <b>Doe</b>', '', 'pink', '', '', 'Q1', '', '', '', '', '', '', '']],
    [{ name: 'Jane <b>Doe</b>' }],
    { start: 1, rows: 1 });
  s.api.processSodPinks();
  const html = lastDialog(s).html;
  checkTruthy('SOD escaping: name escaped', html.includes('Jane &lt;b&gt;Doe&lt;/b&gt;'));
  checkTruthy('SOD escaping: no raw tag injected', !html.includes('Jane <b>Doe</b>'));
}

// 24. A whole-column selection is clamped to rows that hold data.
{
  const deckValues = [HEADER, ['Jane Doe', 'T1', '', '', 'T2', '', '', '', '', '', '', '', '']]
    .map(r => { const row = r.slice(); while (row.length < 14) row.push(''); return row; });
  const wopValues = [];
  for (let i = 0; i < 500; i++) wopValues.push(makeGrid(1, 11, '')[0]);
  wopValues[0][0] = 'Jane Doe';
  wopValues[0][10] = 'Y';
  const deck = new FakeSheet('Deck List', deckValues);
  const wop = new FakeSheet('Daily WOP', wopValues, makeGrid(500, 11, '#ffffff'));
  wop.setSelection(1, 500);
  const context = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(context, [deck, wop], 'Daily WOP');
  const api = loadScript(context);
  wop.writeCount = 0;
  deck.writeCount = 0;
  api.processWopToDeck();
  check('Clamped selection: processed the one real row', String(deck.values[1][1]), 'T2');
  checkTruthy('Clamped selection: writes stay small (got ' + wop.writeCount + ')',
    wop.writeCount <= 2);
}

// 25. Batching: a 40-student EOD run stays in single-digit write calls.
{
  const deckValues = [HEADER];
  const wopRows = [];
  for (let i = 1; i <= 40; i++) {
    const row = [`Student ${i}`, `T${i}a`, '', '', `T${i}b`, '', '', '', '', '', '', '', ''];
    deckValues.push(row);
    wopRows.push({ name: `Student ${i}`, status: 'Y' });
  }
  const s = scenario(deckValues, wopRows, { start: 1, rows: 40 });
  s.deck.writeCount = 0;
  s.wop.writeCount = 0;
  s.api.processWopToDeck();
  check('Batched EOD: last student advanced', s.deckCell(41, C.CURRENT), 'T40b');
  checkTruthy('Batched EOD: all 40 green',
    s.wop.backgrounds.slice(0, 40).every(r => r[10] === '#00ff00'));
}

// 26. A formula anywhere in the write span blocks the bulk write.
{
  const deckValues = [HEADER];
  const wopRows = [];
  for (let i = 1; i <= 8; i++) {
    deckValues.push([`Student ${i}`, `T${i}a`, '', '', `T${i}b`, '', '', '', '', '', '', '', '']);
    wopRows.push({ name: `Student ${i}`, status: 'Y' });
  }
  // Row 5 of the deck holds a formula in the Current column that must survive.
  const s = scenario(deckValues, wopRows, { start: 1, rows: 8 });
  s.deck.formulas = { '5:2': '=SOMETHING()' };
  s.deck.values[4][1] = 'FORMULA RESULT';
  s.api.processWopToDeck();
  check('Formula guard: formula row was written by cell, not span',
    s.deckCell(5, C.CURRENT), 'T4b');
  checkTruthy('Formula guard: span was checked', s.deck.formulaReads > 0);
  check('Formula guard: neighbours still advanced', s.deckCell(2, C.CURRENT), 'T1b');
  check('Formula guard: last student advanced', s.deckCell(9, C.CURRENT), 'T8b');
}

// 27. With no formulas present, a dense column collapses into one write.
{
  const deckValues = [HEADER];
  const wopRows = [];
  for (let i = 1; i <= 8; i++) {
    deckValues.push([`Student ${i}`, `T${i}a`, '', '', `T${i}b`, '', '', '', '', '', '', '', '']);
    wopRows.push({ name: `Student ${i}`, status: 'Y' });
  }
  const s = scenario(deckValues, wopRows, { start: 1, rows: 8 });
  s.api.processWopToDeck();
  check('Dense span: all advanced', s.deckCell(9, C.CURRENT), 'T8b');
  check('Dense span: untouched header intact', s.deckCell(1, C.CURRENT), 'Current');
}

// 28. Column letters.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  check('columnLetter 1', api.columnLetter_(1), 'A');
  check('columnLetter 13', api.columnLetter_(13), 'M');
  check('columnLetter 14', api.columnLetter_(14), 'N');
  check('columnLetter 26', api.columnLetter_(26), 'Z');
  check('columnLetter 27', api.columnLetter_(27), 'AA');
  check('archive column is M', api.CONFIG.DECK_COL.ARCHIVE, 13);
}

// 45b. Check setup lists every column the script touches, and reads a
//      heading from row 2 when row 1 has been left blank as a spacer.
{
  function setupDialog(wopHeaderRows) {
    const deck = new FakeSheet('Deck List',
      [HEADER, ['Jane Doe', 'T1', '', '', '', '', '', '', '', '', '', '', '']]);
    const wopRows = wopHeaderRows.map(r => {
      const row = r.slice(); while (row.length < 26) row.push(''); return row;
    });
    wopRows.push(new Array(26).fill(''));
    const wop = new FakeSheet('Daily WOP', wopRows, makeGrid(wopRows.length, 26, '#ffffff'));
    wop.setSelection(1, 1);
    const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
      Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
    const h = install(ctx, [deck, wop], 'Daily WOP');
    loadScript(ctx).checkSheetSetup();
    return h.dialogs[h.dialogs.length - 1].html;
  }

  // Row 1 carries every heading.
  // Deliberately unlike the config labels, so finding one in the dialog proves
  // the sheet was read rather than the label echoed back.
  const named = [];
  named[0] = 'HDR-Student'; named[5] = 'HDR-POTW';  named[6] = 'HDR-Mastery';
  named[7] = 'HDR-Pages';   named[9] = 'HDR-Final'; named[10] = 'HDR-Deck';
  named[11] = 'HDR-In';     named[12] = 'HDR-Out';  named[14] = 'HDR-Summary';
  named[15] = 'HDR-Internal';
  const full = setupDialog([Array.from(named, v => v === undefined ? '' : v)]);

  // Every Daily WOP column the import writes has to appear, not just the two
  // that EOD uses. A column missing here is a column nobody is checking.
  ['F', 'G', 'H', 'J', 'K', 'L', 'M', 'O', 'P'].forEach(function (letter) {
    checkTruthy('check setup: lists column ' + letter,
      full.includes('<b>' + letter + '</b>'));
  });
  checkTruthy('check setup: lists the name column', full.includes('<b>A</b>'));
  checkTruthy('check setup: shows the headings found from the sheet',
    full.includes('HDR-Pages') && full.includes('HDR-Summary'));

  // K is configured twice -- once by EOD, once by the import -- and is one
  // column, so it gets one row naming both uses.
  check('check setup: K appears once', (full.match(/<b>K<\/b>/g) || []).length, 1);
  checkTruthy('check setup: K names both of its uses',
    full.includes('Deck update / paperwork') && full.includes('Deck update (Y)'));

  // Row 1 left blank as a spacer: the heading is really in row 2.
  const spacer = setupDialog([
    new Array(26).fill(''),
    Array.from(named, v => v === undefined ? '' : v)
  ]);
  checkTruthy('check setup: falls back to row 2 for a heading',
    spacer.includes('HDR-Pages'));
  checkTruthy('check setup: says which row it read',
    spacer.includes('(row 2)'));
  checkTruthy('check setup: does not call a row-2 heading missing',
    !spacer.includes('no heading in row 1 or 2'));

  // Blank in both rows is worth saying plainly.
  const bare = setupDialog([new Array(26).fill(''), new Array(26).fill('')]);
  checkTruthy('check setup: blank in both rows is reported',
    bare.includes('no heading in row 1 or 2'));
}

// 45c. The column plan is built from the config, not written out by hand.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);

  const plan = api.wopColumnPlan_();
  const columns = plan.map(e => e.column);

  check('plan: in sheet order', columns.slice().sort((a, b) => a - b), columns);
  check('plan: one entry per column', new Set(columns).size, columns.length);
  api.CONFIG.RADIUS.FIELDS.forEach(function (field) {
    checkTruthy('plan: covers ' + field.label, columns.indexOf(field.column) !== -1);
  });
  checkTruthy('plan: covers the name column',
    columns.indexOf(api.CONFIG.WOP_COL.NAME) !== -1);

  // A blank cell is not a heading, and neither is a whitespace-only one.
  check('header: row 1 wins when it has text',
    api.headerFor_([['Pages'], ['Ignored']], 1), { text: 'Pages', row: 1 });
  check('header: blank row 1 defers to row 2',
    api.headerFor_([['   '], ['Pages']], 1), { text: 'Pages', row: 2 });
  check('header: blank in both is no heading',
    api.headerFor_([[''], ['']], 1), { text: '', row: 0 });
  check('header: a single header row still works',
    api.headerFor_([['Pages']], 1), { text: 'Pages', row: 1 });
}

// 45c2. Getting to the right row on a day log.
{
  function day(rows, options) {
    const opts = options || {};
    const values = rows.map(function (r) {
      const row = new Array(26).fill('');
      if (typeof r === 'string') row[0] = r;
      else Object.keys(r).forEach(function (k) { row[Number(k) - 1] = r[k]; });
      return row;
    });
    if (!values.length) values.push(new Array(26).fill(''));
    const bg = makeGrid(values.length, 26, '#ffffff');
    (opts.fills || []).forEach(function (f) { bg[f[0] - 1][f[1] - 1] = f[2]; });

    const wop = new FakeSheet('Daily WOP', values, bg);
    const deck = new FakeSheet('Deck List',
      [HEADER, ['Jane Doe', 'T1', '', '', '', '', '', '', '', '', '', '', '']]);
    const ctx = vm.createContext({ console, Buffer, JSON, Math,
      Date: fixedDate(opts.today || '2026-09-17'), String, Number, Object,
      Array, RegExp, Error, isNaN, parseInt, parseFloat });
    const h = install(ctx, [deck, wop], opts.on || 'Daily WOP');
    return { wop: wop, api: loadScript(ctx), harness: h,
      at: () => wop.activated ? wop.activated.row : 0,
      A: i => String((wop.values[i - 1] || [])[0] || ''),
      said: () => h.alerts.concat(h.dialogs.map(d => d.html)).join(' ') };
  }

  // 17 September 2026 is a Thursday.
  const api0 = day([]).api;
  check('day header: written the way the sheet writes it',
    api0.dayHeaderText_(new Date(2026, 8, 17)), '9/17/2026 Thursday');

  // Read by the date in it, not by matching the text.
  const on = v => api0.parseDayHeader_(v);
  checkTruthy('day header: the sheet\'s own form', on('9/17/2026 Thursday') !== null);
  checkTruthy('day header: zero-padded reads the same',
    on('09/17/2026 Thursday').getTime() === on('9/17/2026 Thursday').getTime());
  checkTruthy('day header: the day name is decoration',
    on('9/17/2026').getTime() === on('9/17/2026 Wednesday').getTime());
  check('day header: a student is not a day', on('7:00 Sharon Yoo'), null);
  check('day header: nor is a note', on('NOTE: Noted to Mr. HR that'), null);
  check('day header: nor a date that does not exist', on('2/31/2026 Tuesday'), null);
  check('day header: nor a bare number', on('899'), null);

  // --- jump to today ----------------------------------------------------
  let d = day(['9/15/2026 Tuesday', '7:00 Ira Morjaria',
               '9/17/2026 Thursday', '7:00 Sharon Yoo']);
  d.api.jumpToToday();
  check('jump: lands on today\'s row', d.at(), 3);
  check('jump: and says nothing when it works', d.said(), '');

  // Not there yet is said, with somewhere to go.
  d = day(['9/15/2026 Tuesday', '7:00 Ira Morjaria']);
  d.api.jumpToToday();
  checkTruthy('jump: a day not opened yet is said',
    d.said().includes('9/17/2026 Thursday') && d.said().includes('Start a new day'));

  // Opened twice: go to the first, then say so -- the day is split in two.
  d = day(['9/17/2026 Thursday', '7:00 Ira Morjaria', '9/17/2026 Thursday']);
  d.api.jumpToToday();
  check('jump: a day opened twice still lands somewhere', d.at(), 1);
  checkTruthy('jump: and names both rows',
    d.said().includes('1, 3') && d.said().includes('split'));

  // --- start a new day --------------------------------------------------
  d = day(['9/15/2026 Tuesday', '7:00 Ira Morjaria'],
    { fills: [[1, 1, '#ff9999']] });
  d.api.startNewDay();
  check('new day: opened under the last populated row', d.A(3), '9/17/2026 Thursday');
  check('new day: and the cursor is on it', d.at(), 3);
  check('new day: wearing the last day\'s colour',
    String(d.wop.backgrounds[2][0]), '#ff9999');
  check('new day: nothing above it was touched',
    [d.A(1), d.A(2)], ['9/15/2026 Tuesday', '7:00 Ira Morjaria']);

  // Already open: go there, add nothing. Two headers for one day would split
  // the day's students between them and nothing downstream would notice.
  d = day(['9/17/2026 Thursday', '7:00 Sharon Yoo']);
  d.api.startNewDay();
  check('new day: today already open adds nothing', d.A(3), '');
  check('new day: and takes you to the one that is there', d.at(), 1);
  checkTruthy('new day: saying as much', d.said().includes('already open'));

  // A day further ahead already started: adding today below it would put the
  // log out of order, so it refuses and says where the problem is.
  d = day(['9/15/2026 Tuesday', '9/20/2026 Sunday']);
  d.api.startNewDay();
  check('new day: refuses to open today under a later day', d.A(3), '');
  checkTruthy('new day: and names the row that is ahead',
    d.said().includes('9/20/2026') && d.said().includes('out of order'));

  // An empty sheet has no day to copy the look of, and says so.
  d = day([]);
  d.api.startNewDay();
  check('new day: the first day of all still opens', d.A(1), '9/17/2026 Thursday');
  checkTruthy('new day: and admits it could not copy a colour',
    d.said().includes('no earlier day'));

  // Reached from another tab, both entries bring you over.
  d = day(['9/17/2026 Thursday'], { on: 'Deck List' });
  d.api.jumpToToday();
  checkTruthy('jump: switches tab when you were looking elsewhere',
    d.harness.activatedSheets.indexOf('Daily WOP') !== -1);
}

// 45d. The seating chart, read from the real sample layout.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);

  const BLOCK = JSON.parse(fs.readFileSync('tests/fixtures/seating-block.json', 'utf8'));
  const clone = () => BLOCK.map(r => r.slice());

  // A seat still showing its printed label is an empty seat. Nobody is
  // sitting in "1C" until somebody's name is written over it.
  check('seating: a printed label is not a student',
    api.parseSeatingChart_(clone()).length, 0);

  // Write a name into every labelled seat, and the seat each one comes back as
  // has to equal the label it replaced. That is the whole premise: once a
  // student is written over the label, position is all there is left to read.
  const written = clone();
  const wasLabelled = {};
  written.forEach(function (row, r) {
    row.forEach(function (cell, c) {
      if (!/^\d+[A-C]$/.test(String(cell))) return;
      const name = 'Student ' + r + '-' + c;
      wasLabelled[name] = String(cell);
      written[r][c] = name;
    });
  });

  const labelled = api.parseSeatingChart_(written);
  check('seating: found every seat that had a label',
    labelled.length, Object.keys(wasLabelled).length);
  check('seating: found the twenty-three the sample has', labelled.length, 23);
  check('seating: every derived seat matches the label it replaced',
    labelled.filter(e => e.seat !== wasLabelled[e.occupant]), []);
  check('seating: this sample names its rows from the side markers',
    labelled.filter(e => e.letterFrom !== 'marker'), []);

  const seatOf = name => labelled.filter(e => e.seat === name)[0] || {};
  check('seating: 1C is read from table 1 and row C', seatOf('1C').seat, '1C');
  // The instructors are the pod's, for that hour -- not one per seat row.
  check('seating: 1C takes every instructor of its pod',
    seatOf('1C').instructors, ['IN3', 'IN2', 'IN1']);
  check('seating: and so does row A of the same pod',
    seatOf('1A').instructors, ['IN3', 'IN2', 'IN1']);
  check('seating: a different pod has its own',
    seatOf('8C').instructors, ['IN3', 'IN2', 'IN1']);
  check('seating: the far table reads its own number', seatOf('8C').seat, '8C');

  // 8A is empty on the sample, and an empty seat is not a seating.
  check('seating: an empty seat is skipped',
    labelled.filter(e => e.seat === '8A').length, 0);

  // The footer row carries text but no row letter, so it is not a row of seats.
  checkTruthy('seating: the rest room row is not read as seats',
    !labelled.some(e => String(e.occupant).indexOf('Rest Room') !== -1));

  // Now the live case: a name written over the label.
  const live = clone();
  live[3][15] = 'Amalie L';        // P4, the cell printed as 1C
  const seated = api.parseSeatingChart_(live);
  const amalie = seated.filter(e => e.occupant === 'Amalie L')[0];
  check('seating: a name over the label still resolves to that seat',
    [amalie.seat, amalie.instructors.join(' ')], ['1C', 'IN3 IN2 IN1']);
}

// 45d2. The chart as it is actually drawn: no seat labels, no side markers,
//       and three of the four header rows missing the middle pod.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);

  const LIVE = JSON.parse(fs.readFileSync('tests/fixtures/seating-live-layout.json', 'utf8'));
  const live = () => LIVE.map(r => r.slice());

  const seats = api.parseSeatingChart_(live());
  const of = name => seats.filter(e => e.occupant === name)[0] || {};

  check('live chart: everybody on it is found', seats.length, 5);
  check('live chart: nobody is invented', seats.map(e => e.occupant).sort(),
    ['April V', 'Audrina S', 'Luca B', 'Neil D', 'Sharon Y']);

  // Tables 4 and 3 are named only in the very top header row. Reading each
  // block on its own header left these five students at no table at all.
  check('live chart: a table named only once still names its column',
    [of('Neil D').seat, of('Audrina S').seat], ['4C', '3C']);
  check('live chart: down the rows in order',
    [of('Sharon Y').seat, of('Luca B').seat, of('April V').seat],
    ['4B', '3B', '3A']);

  // Nothing on this chart says which row is which, so position decides, and
  // the parser records that it did.
  check('live chart: the rows were named from position',
    seats.filter(e => e.letterFrom !== 'position'), []);

  // The two instructors are one line apart in the wall column. Per row, the
  // middle of the pod would have had nobody.
  check('live chart: everyone in the pod gets both instructors',
    seats.map(e => (e.instructors || []).join(' ')),
    ['AZ HR', 'AZ HR', 'AZ HR', 'AZ HR', 'AZ HR']);

  check('live chart: the hour comes off the left of the block',
    seats.map(e => e.hour), ['7:00', '7:00', '7:00', '7:00', '7:00']);

  // The empty hours are empty, not full of the decoration around them.
  checkTruthy('live chart: no seat is a time or a wall',
    !seats.some(e => /^\d+:\d\d$|^Wall$/.test(e.occupant)));

  // The headers on this chart differ by omission, which is not a disagreement.
  check('live chart: a header missing a table is not a conflict',
    seats.conflicts, []);

  // Moving a table between hours is, and is said rather than resolved.
  const moved = live();
  moved[7][1] = 6;        // the 5:00 header calls column B table 6, not 8
  const after = api.parseSeatingChart_(moved);
  check('live chart: a table that moved between hours is reported',
    after.conflicts.length, 1);
  check('live chart: and the report says which column and what to what',
    after.conflicts.length ? [after.conflicts[0].was, after.conflicts[0].now] : [],
    [8, 6]);

  // On this chart the complete header happens to be the first one. The rule is
  // not "the first header wins" but "every header together", so the same has
  // to hold when the complete drawing is further down.
  const late = live();
  late[2][9] = '';    // take tables 4 and 3 off the top header
  late[2][11] = '';
  late[7][9] = 4;     // and give them to the five o'clock one instead
  late[7][11] = 3;
  const fromLater = api.parseSeatingChart_(late);
  check('live chart: a header further down names the columns just as well',
    fromLater.map(e => e.seat).sort(), ['3A', '3B', '3C', '4B', '4C']);

  // And with the tables named nowhere at all, those students are not guessed
  // into a seat -- the chart genuinely does not say which table they are at.
  const never = live();
  never[2][9] = '';
  never[2][11] = '';
  const nameless = api.parseSeatingChart_(never);
  check('live chart: a column no header names seats nobody', nameless.length, 0);

  // A unit check on the merge itself, so it is not resting on one fixture.
  const layout = api.seatingLayout_(
    [['', 8, '', '', '', 6], ['', 8, '', 7, '', 6]],
    [{ row: 0, columns: [1, 5] }, { row: 1, columns: [1, 3, 5] }]);
  check('layout: a column named only by the later header is still known',
    layout.tableOf[3], 7);
  check('layout: the columns come back in order', layout.columns, [1, 3, 5]);
  check('layout: agreeing headers are not a conflict', layout.conflicts, []);
}

// 45d3. Which chart, and which document it is in.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  const h = install(ctx, [], null);
  const api = loadScript(ctx);

  // Monday to Friday is the weekday chart; Saturday has its own.
  const on = iso => api.seatingSheetName_(new Date(iso + 'T12:00:00Z'));
  check('which chart: a Wednesday', on('2026-08-19'), 'weekdays');
  check('which chart: a Monday', on('2026-08-17'), 'weekdays');
  check('which chart: a Friday', on('2026-08-21'), 'weekdays');
  check('which chart: a Saturday', on('2026-08-22'), 'saturday');

  // Sunday names no chart, and that is an answer rather than a gap -- reading
  // Saturday's on a Sunday would seat everybody where they sat yesterday.
  check('which chart: a Sunday has none', on('2026-08-23'), '');

  // The link, however it arrives.
  const ID = '1AbC-dEf_GhIjKlMnOpQrStUvWxYz0123456789';
  check('link: a whole address bar',
    api.spreadsheetIdFromLink_('https://docs.google.com/spreadsheets/d/' + ID +
      '/edit#gid=0'), ID);
  check('link: without the tail',
    api.spreadsheetIdFromLink_('https://docs.google.com/spreadsheets/d/' + ID), ID);
  check('link: a bare id, for somebody who has done this before',
    api.spreadsheetIdFromLink_(ID), ID);
  check('link: with spaces round it', api.spreadsheetIdFromLink_('  ' + ID + ' '), ID);
  check('link: a link to something else is not half-understood',
    api.spreadsheetIdFromLink_('https://docs.google.com/document/d/' + ID + '/edit'), '');
  check('link: prose is not a link',
    api.spreadsheetIdFromLink_('the one in my drive'), '');
  check('link: nothing is nothing', api.spreadsheetIdFromLink_(''), '');

  // Setting it: what it says back is what it can actually see.
  h.addBook('BOOKOK_00000000000000000000',
    [new FakeSheet('weekdays', [['']]), new FakeSheet('saturday', [['']])],
    'Centre charts');
  h.promptAnswer.next = 'https://docs.google.com/spreadsheets/d/BOOKOK_00000000000000000000/edit';
  api.setSeatingSource();
  check('link: stored', api.seatingSpreadsheetId_(), 'BOOKOK_00000000000000000000');
  checkTruthy('link: and it says what it found',
    h.alerts.join(' ').includes('Centre charts') &&
    h.alerts.join(' ').includes('Both charts are there'));

  // A document missing one of the tabs is saved, and said so.
  h.addBook('BOOKHALF_0000000000000000000', [new FakeSheet('weekdays', [['']])], 'Half a chart');
  h.promptAnswer.next = 'BOOKHALF_0000000000000000000';
  api.setSeatingSource();
  check('link: a half-right document is still stored',
    api.seatingSpreadsheetId_(), 'BOOKHALF_0000000000000000000');
  checkTruthy('link: with the missing tab named',
    h.alerts.join(' ').includes('No tab named saturday'));

  // Rubbish is refused and changes nothing.
  h.promptAnswer.next = 'thats the one on my desktop';
  api.setSeatingSource();
  check('link: rubbish leaves the old link alone',
    api.seatingSpreadsheetId_(), 'BOOKHALF_0000000000000000000');
  checkTruthy('link: and says what one looks like',
    h.alerts.join(' ').includes('/spreadsheets/d/'));

  // An empty box is not an instruction to forget the link.
  h.promptAnswer.next = '   ';
  api.setSeatingSource();
  check('link: an empty box leaves it alone', api.seatingSpreadsheetId_(), 'BOOKHALF_0000000000000000000');
}

// 45e. Matching a hurried chart name to a Daily WOP name.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  const m = (a, b) => api.seatingMatchRank_(a, b) > 0;

  checkTruthy('name: exact', m('Amalie Laz', 'Amalie Laz'));
  checkTruthy('name: shortened surname', m('Amalie L', 'Amalie Laz'));
  checkTruthy('name: case and spacing', m('  amalie   l ', 'Amalie Laz'));
  checkTruthy('name: last-comma-first on the chart', m('Laz, Amalie', 'Amalie Laz'));
  checkTruthy('name: first name alone', m('Amalie', 'Amalie Laz'));

  checkTruthy('name: a different surname does not match',
    !m('Amalie Roe', 'Amalie Laz'));
  checkTruthy('name: a different first name does not match',
    !m('Amelia L', 'Amalie Laz'));
  checkTruthy('name: an empty chart cell matches nobody', !m('', 'Amalie Laz'));

  // A name written out in full beats one that merely starts the same way.
  // Without this "Student 11" reads as an abbreviation of "Student 1".
  const roll = ['Student 1', 'Student 11', 'Student 12'];
  check('candidates: an exact name wins outright',
    api.seatingCandidates_('Student  11', roll), ['Student 11']);
  check('candidates: an abbreviation still finds its student',
    api.seatingCandidates_('Amalie L', ['Amalie Laz', 'Bo Peep']), ['Amalie Laz']);
  check('candidates: two students behind one abbreviation is an ambiguity',
    api.seatingCandidates_('Amalie L', ['Amalie Laz', 'Amalie Lee']),
    ['Amalie Laz', 'Amalie Lee']);
  check('candidates: nobody is nobody',
    api.seatingCandidates_('Ghost', ['Amalie Laz']), []);

  // A special spelling settles what the name alone cannot.
  vm.runInContext(
    'CONFIG.SEATING.ALIASES = { "Amalie L": "Amalie Lee" };', ctx);
  check('candidates: an alias overrides the abbreviation rule',
    api.seatingCandidates_('Amalie L', ['Amalie Laz', 'Amalie Lee']), ['Amalie Lee']);
  vm.runInContext('CONFIG.SEATING.ALIASES = {};', ctx);

  // Formatting, including a student who moved between hours.
  check('format: one seat, one instructor',
    api.formatSeating_([{ seat: '1C', instructors: ['IN3'] }]), '1C | IN3');
  check('format: two hours, same seat, two instructors',
    api.formatSeating_([{ seat: '1C', instructors: ['IN3'] },
                        { seat: '1C', instructors: ['IN2'] }]), '1C | IN3 IN2');
  check('format: moved seats',
    api.formatSeating_([{ seat: '1C', instructors: ['IN3'] },
                        { seat: '2A', instructors: ['IN1'] }]), '1C, 2A | IN3 IN1');
  check('format: a seat with no instructor beside it',
    api.formatSeating_([{ seat: '1C', instructors: [] }]), '1C');
  check('format: nothing found is nothing written', api.formatSeating_([]), '');
}

// 45f. The seating chart reaching the Daily WOP.
{
  function run(options) {
    const opts = options || {};
    const BLOCK = JSON.parse(fs.readFileSync('tests/fixtures/seating-block.json', 'utf8'));
    const chart = BLOCK.map(r => r.slice());
    (opts.place || [[3, 15, 'Amalie L']]).forEach(p => { chart[p[0]][p[1]] = p[2]; });

    const deck = new FakeSheet('Deck List',
      [HEADER, ['Jane Doe', 'T1', '', '', '', '', '', '', '', '', '', '', '']]);
    const wopRows = (opts.students || ['Amalie Laz']).map(name => {
      const row = [name];
      while (row.length < 26) row.push('');
      if (opts.existing) row[13] = opts.existing;
      return row;
    });
    const wop = new FakeSheet('Daily WOP', wopRows,
      makeGrid(wopRows.length, 26, '#ffffff'));
    wop.setSelection(1, wopRows.length);
    const seating = new FakeSheet('weekdays', chart,
      makeGrid(chart.length, chart[0].length, '#ffffff'));

    const ctx = vm.createContext({ console, Buffer, JSON, Math,
      Date: fixedDate('2026-08-19'), String, Number,
      Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
    const h = opts.separate
      ? install(ctx, [deck, wop], 'Daily WOP')
      : install(ctx, [deck, wop, seating], 'Daily WOP');
    const api = loadScript(ctx);
    if (opts.separate) {
      h.addBook('chart-id-123', [seating]);
      vm.runInContext('CONFIG.SEATING.SPREADSHEET_ID = "chart-id-123";', ctx);
    }
    api.importSeatingChart();
    return { wop, harness: h,
      N: i => String(wop.values[i][13]),
      said: () => h.alerts.concat(h.dialogs.map(d => d.html)).join(' ') };
  }

  let r = run();
  check('seating sheet: seat and instructor land in column N', r.N(0), '1C | IN3 IN2 IN1');

  // The chart can live in its own document.
  r = run({ separate: true });
  check('seating sheet: a chart in another spreadsheet works the same',
    r.N(0), '1C | IN3 IN2 IN1');

  // A student nobody sat: said out loud, not silently skipped.
  r = run({ students: ['Ghost Student'] });
  check('seating sheet: an unseated student is not written', r.N(0), '');
  checkTruthy('seating sheet: and is reported',
    r.said().includes('not found on the seating chart'));

  // Two hours in different seats.
  r = run({ place: [[3, 15, 'Amalie L'], [5, 13, 'Amalie L']] });
  check('seating sheet: a student who moved gets both seats',
    r.N(0), '1C, 2A | IN3 IN2 IN1');

  // "Amalie L" cannot be resolved when two Amalie L-somethings are selected.
  r = run({ students: ['Amalie Laz', 'Amalie Lee'] });
  check('seating sheet: an ambiguous name writes nothing to either',
    [r.N(0), r.N(1)], ['', '']);
  checkTruthy('seating sheet: and says who it could have been',
    r.said().includes('Amalie Laz or Amalie Lee'));

  // Replacing something already in N is reported rather than done quietly.
  r = run({ existing: '9Z | someone' });
  check('seating sheet: a stale seat is corrected', r.N(0), '1C | IN3 IN2 IN1');
  checkTruthy('seating sheet: and the replacement is named',
    r.said().includes('replaced') && r.said().includes('9Z | someone'));

  // Running it twice changes nothing the second time.
  r = run({ existing: '1C | IN3 IN2 IN1' });
  check('seating sheet: an already correct cell is left alone',
    r.N(0), '1C | IN3 IN2 IN1');
  checkTruthy('seating sheet: and is not counted as a replacement',
    !r.said().includes('replaced'));
}

// 45g. The start-of-day organiser, against the populated sample chart.
{
  const POPULATED = 'tests/fixtures/seating-populated.json';

  function organise(options) {
    const opts = options || {};
    const chart = JSON.parse(fs.readFileSync(POPULATED, 'utf8')).map(r => r.slice());
    (opts.edit || []).forEach(e => { chart[e[0]][e[1]] = e[2]; });

    const wopRows = (opts.students !== undefined ? opts.students
      : ['Student 1', 'Student 2', 'Student 3', 'Student 4', 'Student 5',
         'Student 6', 'Student 7', 'Student 8', 'Student 9', 'Student 10',
         'Student 11', 'Student 12']).map(name => {
      const row = [name];
      while (row.length < 26) row.push('');
      return row;
    });
    (opts.dirty || []).forEach(d => { wopRows[d[0]][d[1]] = d[2]; });
    // Rows put above the students, for the day-log case: a previous day and
    // today's own header.
    (opts.above || []).slice().reverse().forEach(function (text) {
      const row = [text];
      while (row.length < 26) row.push('');
      wopRows.unshift(row);
    });
    if (!wopRows.length) wopRows.push(new Array(26).fill(''));

    const deck = new FakeSheet('Deck List',
      [HEADER, ['Jane Doe', 'T1', '', '', '', '', '', '', '', '', '', '', '']]);
    const wop = new FakeSheet('Daily WOP', wopRows,
      makeGrid(wopRows.length, 26, '#ffffff'));
    const seating = new FakeSheet('weekdays', chart,
      makeGrid(chart.length, chart[0].length, '#ffffff'));

    const ctx = vm.createContext({ console, Buffer, JSON, Math,
      Date: fixedDate('2026-08-19'), String, Number,
      Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
    const h = install(ctx, [deck, wop, seating], 'Daily WOP');
    const api = loadScript(ctx);
    if (opts.aliases) {
      vm.runInContext('CONFIG.SEATING.ALIASES = ' + JSON.stringify(opts.aliases) + ';', ctx);
    }
    api.organizeSeatingRows();
    return { wop, harness: h, api,
      A: i => String(wop.values[i][0]),
      B: i => String(wop.values[i][1]),
      Bfill: i => String(wop.backgrounds[i][1]),
      Bfont: i => String(wop.fontColors[i][1]),
      Afill: i => String(wop.backgrounds[i][0]),
      said: () => h.alerts.concat(h.dialogs.map(d => d.html)).join(' ') };
  }

  const r = organise();

  // Twelve students at 12:00 and twelve at 1:00.
  check('organise: a row per seating', r.wop.values.filter(v => v[0]).length, 24);

  // The hour leads, and the earlier hour comes first.
  checkTruthy('organise: the first row is the earlier hour',
    r.A(0).indexOf('12:00 ') === 0);
  checkTruthy('organise: the later hour follows', r.A(12).indexOf('1:00 ') === 0);

  // Pod 1 is tables 1 and 2: students 1 to 6 at 12:00, alphabetically.
  const firstHour = [];
  for (let i = 0; i < 12; i++) firstHour.push(r.A(i).replace('12:00 ', ''));
  check('organise: pod 1 holds students 1-6',
    firstHour.slice(0, 6).slice().sort(),
    ['Student 1', 'Student 2', 'Student 3', 'Student 4', 'Student 5', 'Student 6']);
  check('organise: pod 1 is alphabetical within itself',
    firstHour.slice(0, 6), firstHour.slice(0, 6).slice().sort());
  check('organise: pod 2 follows, holding students 7-10',
    firstHour.slice(6, 10).slice().sort(),
    ['Student 10', 'Student 7', 'Student 8', 'Student 9']);
  check('organise: pod 3 last, holding students 11-12',
    firstHour.slice(10, 12).slice().sort(), ['Student 11', 'Student 12']);

  // The instructors of a pod, joined, against every student in it.
  check('organise: pod 1 carries both of its instructors', r.B(0), 'AA/BB');
  check('organise: pod 2 carries its own', r.B(6), 'CC/DD');
  check('organise: a single-instructor pod is not padded', r.B(10), 'EE');

  // Colour: the pod on column B, the hour on column A.
  check('organise: pod 1 fill', r.Bfill(0), '#efefef');
  check('organise: pod 2 fill', r.Bfill(6), '#cfe2f3');
  check('organise: pod 3 fill', r.Bfill(10), '#9fc5e8');
  check('organise: initials alternate colour between neighbouring pods',
    [r.Bfont(0), r.Bfont(6)], ['#0000ff', '#ff0000']);
  check('organise: the hour shade alternates', [r.Afill(0), r.Afill(12)],
    ['#ffffff', '#d9d9d9']);
}

// 45g2. The organiser on a sheet that keeps a day per block.
{
  const POPULATED = 'tests/fixtures/seating-populated.json';

  function log(options) {
    const opts = options || {};
    const chart = JSON.parse(fs.readFileSync(POPULATED, 'utf8')).map(r => r.slice());
    const rows = (opts.rows || []).map(function (text) {
      const row = [text];
      while (row.length < 26) row.push('');
      return row;
    });
    (opts.dirty || []).forEach(d => { rows[d[0]][d[1]] = d[2]; });

    const deck = new FakeSheet('Deck List',
      [HEADER, ['Jane Doe', 'T1', '', '', '', '', '', '', '', '', '', '', '']]);
    const wop = new FakeSheet('Daily WOP', rows, makeGrid(rows.length, 26, '#ffffff'));
    const seating = new FakeSheet('weekdays', chart,
      makeGrid(chart.length, chart[0].length, '#ffffff'));
    const ctx = vm.createContext({ console, Buffer, JSON, Math,
      Date: fixedDate('2026-08-19'), String, Number, Object, Array, RegExp,
      Error, isNaN, parseInt, parseFloat });
    const h = install(ctx, [deck, wop, seating], 'Daily WOP');
    loadScript(ctx).organizeSeatingRows();
    return { wop: wop,
      A: i => String(wop.values[i - 1][0]),
      said: () => h.alerts.concat(h.dialogs.map(d => d.html)).join(' ') };
  }

  // Yesterday's block is history. Only today's is organised, and yesterday is
  // left exactly as it was -- read from row one this would shuffle every
  // student who has ever been in.
  let r = log({ rows: [
    '8/18/2026 Tuesday', '9:00 Student 7', '10:00 Student 8',
    '8/19/2026 Wednesday', 'Student 1', 'Student 2', 'Student 3'] });
  check('day log: yesterday is left alone',
    [r.A(1), r.A(2), r.A(3)],
    ['8/18/2026 Tuesday', '9:00 Student 7', '10:00 Student 8']);
  check('day log: today\'s header is left alone', r.A(4), '8/19/2026 Wednesday');
  checkTruthy('day log: and today\'s block is organised under it',
    r.A(5).indexOf('12:00 ') === 0);

  // Yesterday's filled-in columns are not this morning's pinned data.
  r = log({ rows: [
    '8/18/2026 Tuesday', '9:00 Student 7',
    '8/19/2026 Wednesday', 'Student 1', 'Student 2'],
    dirty: [[1, 10, 'Y'], [1, 13, '1C | AA']] });
  checkTruthy('day log: yesterday\'s own data does not block today',
    r.A(4).indexOf('12:00 ') === 0);
  checkTruthy('day log: and nothing was refused', !r.said().includes('nothing has'));

  // A day already started below today's -- somebody made tomorrow's block
  // early -- stops today's block where it should stop.
  r = log({ rows: [
    '8/19/2026 Wednesday', 'Student 1', 'Student 2',
    '8/20/2026 Thursday', '9:00 Student 7', '10:00 Student 8'] });
  check('day log: tomorrow\'s block is not overwritten with today\'s',
    [r.A(4), r.A(5), r.A(6)],
    ['8/20/2026 Thursday', '9:00 Student 7', '10:00 Student 8']);
  check('day log: and today\'s is left as it was too',
    [r.A(2), r.A(3)], ['Student 1', 'Student 2']);
  checkTruthy('day log: with the rows it would need spelled out',
    r.said().includes('Insert 16 more rows above row 4'));

  // Room enough, and it fills the block without touching what is below.
  const roomy = ['8/19/2026 Wednesday'];
  for (let i = 0; i < 24; i++) roomy.push('Student ' + ((i % 12) + 1));
  roomy.push('8/20/2026 Thursday', '9:00 Student 7');
  r = log({ rows: roomy });
  checkTruthy('day log: a block with room is organised',
    r.A(2).indexOf('12:00 ') === 0);
  check('day log: right up to its last row', r.A(25).indexOf('1:00 ') === 0, true);
  check('day log: and the day below is untouched',
    [r.A(26), r.A(27)], ['8/20/2026 Thursday', '9:00 Student 7']);

  // Today not opened yet: organising would write today's students into
  // yesterday's block, so it refuses and says how to open today.
  r = log({ rows: ['8/18/2026 Tuesday', '9:00 Student 7', 'Student 1'] });
  check('day log: today not opened means nothing is organised',
    [r.A(1), r.A(3)], ['8/18/2026 Tuesday', 'Student 1']);
  checkTruthy('day log: and it says to open today first',
    r.said().includes('Start a new day') &&
    r.said().includes('8/19/2026 Wednesday'));
}

// 45h. What the organiser refuses, and what it is told.
{
  const POPULATED = 'tests/fixtures/seating-populated.json';

  function organise(options) {
    const opts = options || {};
    const chart = JSON.parse(fs.readFileSync(POPULATED, 'utf8')).map(r => r.slice());
    (opts.edit || []).forEach(e => { chart[e[0]][e[1]] = e[2]; });
    const wopRows = (opts.students || ['Student 1']).map(name => {
      const row = [name];
      while (row.length < 26) row.push('');
      return row;
    });
    (opts.dirty || []).forEach(d => { wopRows[d[0]][d[1]] = d[2]; });

    const deck = new FakeSheet('Deck List',
      [HEADER, ['Jane Doe', 'T1', '', '', '', '', '', '', '', '', '', '', '']]);
    const wop = new FakeSheet('Daily WOP', wopRows,
      makeGrid(wopRows.length, 26, '#ffffff'));
    const seating = new FakeSheet('weekdays', chart,
      makeGrid(chart.length, chart[0].length, '#ffffff'));
    const ctx = vm.createContext({ console, Buffer, JSON, Math,
      Date: fixedDate('2026-08-19'), String, Number,
      Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
    const h = install(ctx, [deck, wop, seating], 'Daily WOP');
    const api = loadScript(ctx);
    if (opts.aliases) {
      vm.runInContext('CONFIG.SEATING.ALIASES = ' + JSON.stringify(opts.aliases) + ';', ctx);
    }
    api.organizeSeatingRows();
    return { wop, said: () => h.alerts.concat(h.dialogs.map(d => d.html)).join(' ') };
  }

  // Session data is tied to its row by position alone. Reordering the names
  // under it would hand one student's pages to another, silently.
  let r = organise({ dirty: [[0, 7, '33']] });   // column H
  check('organise: refuses once session data is on the sheet',
    String(r.wop.values[0][0]), 'Student 1');
  checkTruthy('organise: and names the column that stopped it',
    r.said().includes('column H'));

  // Column B is the organiser's own, so yesterday's instructors are no reason
  // to stop.
  r = organise({ dirty: [[0, 1, 'ZZ']] });
  checkTruthy('organise: yesterday\'s instructors do not block it',
    !r.said().includes('would leave that data'));

  // A chart name with nobody to match on the Daily WOP is still listed, and
  // said out loud rather than dropped.
  r = organise({ students: ['Student 1'] });
  checkTruthy('organise: an unknown chart name is still placed',
    r.wop.values.filter(v => String(v[0]).indexOf('Student  7') !== -1).length > 0);
  checkTruthy('organise: and is reported',
    r.said().includes('not on the Daily WOP'));

  // A student on the Daily WOP that the chart never mentions must not be
  // deleted by a rebuild of the list. Losing the one name nobody remembered to
  // seat is the worst thing this could do.
  r = organise({ students: ['Student  1', 'Walk In Kid'] });
  const column = r.wop.values.map(v => String(v[0])).filter(Boolean);
  checkTruthy('organise: an unseated student survives the rebuild',
    column.some(v => v === 'Walk In Kid'));
  check('organise: and is put at the end', column[column.length - 1], 'Walk In Kid');
  checkTruthy('organise: with no hour attached',
    column[column.length - 1].indexOf(':') === -1);
  checkTruthy('organise: and is reported',
    r.said().includes('not on the seating chart'));
  check('organise: marked rather than left looking seated',
    String(r.wop.backgrounds[column.length - 1][1]), '#ffff00');

  // Special spellings settle what the name alone cannot.
  r = organise({ students: ['Amalie Lazeration'],
                 aliases: { 'Student  7': 'Amalie Lazeration' } });
  checkTruthy('organise: an alias puts the real name on the sheet',
    r.wop.values.some(v => String(v[0]).indexOf('Amalie Lazeration') !== -1));
}

// 45i. A session from another day is refused.
//
//      The roster hands back a student's most recent session whether or not it
//      is today's, so on a quiet day a link on today's roster opens last
//      week's page. Importing that writes a session the student never had.
{
  function importOn(pageDate, options) {
    const opts = options || {};
    const s = scenario([HEADER, ...DECK_FILLER_ROWS,
      ['Amalie Laz', '', '', '', '', '', '', '', '', '', '', '', '']],
      [{ name: 'Amalie Laz' }], { start: 1, rows: 1 }, '2026-08-22');
    s.harness.scriptProps.RADIUS_COOKIE = 'session=abc';
    vm.runInContext(
      'CONFIG.RADIUS.ROSTER_URL = "https://radius.mathnasium.com/IM"; ' +
      'CONFIG.RADIUS.TOKEN_PAGE_URL = "";', s.context);
    if (opts.allowAnyDay) {
      vm.runInContext('CONFIG.RADIUS.REQUIRE_SESSION_TODAY = false;', s.context);
    }
    let page = dwp('complete', pageDate);
    if (opts.stripDate) {
      page = page.replace(/<span id="SessionDate">[^<]*<\/span>/, '');
    }
    s.harness.fetchHandler.value = url => ({ code: 200, body:
      url.indexOf('/IM') !== -1 ? rosterReply(['Amalie Laz']) : page });
    confirmRadiusImport(s);
    return { s: s, H: () => String(s.wop.values[0][7]),
      said: () => s.harness.alerts.concat(
        s.harness.dialogs.map(d => d.html)).join(' ') };
  }

  // Today's session imports as it always did.
  let r = importOn('8/22/2026');
  check('session date: today imports', r.H(), '33');

  // Last week's does not, and says which day it actually found.
  r = importOn('8/15/2026');
  check('session date: another day writes nothing', r.H(), '');
  checkTruthy('session date: and names the day it found',
    r.said().includes('8/15/2026'));
  checkTruthy('session date: and says it is not today',
    r.said().includes('not today'));

  // Same day, differently padded, is still the same day.
  r = importOn('08/22/2026');
  check('session date: a padded date is the same date', r.H(), '33');

  // Tomorrow is no more today than last week is.
  r = importOn('8/23/2026');
  check('session date: a later day is refused too', r.H(), '');

  // A page that states no date cannot be vouched for, so it is not guessed at.
  r = importOn('8/22/2026', { stripDate: true });
  check('session date: an undated page writes nothing', r.H(), '');
  checkTruthy('session date: and says the page did not state one',
    r.said().includes('does not state a session date'));

  // Turned off to backfill a past day, the old behaviour is back.
  r = importOn('8/15/2026', { allowAnyDay: true });
  check('session date: the check can be turned off for a backfill', r.H(), '33');
}

// 45l. A student who was not in today, and one the row already accounts for.
{
  function run(options) {
    const opts = options || {};
    const wopRow = { name: 'Amalie Laz' };
    const s = scenario([HEADER, ...DECK_FILLER_ROWS,
      ['Amalie Laz', '', '', '', '', '', '', '', '', '', '', '', '']],
      [wopRow], { start: 1, rows: 1 }, '2026-08-22');
    if (opts.rowNote) s.wop.values[0][opts.rowNoteColumn || 16] = opts.rowNote;
    if (opts.signedIn) s.wop.values[0][11] = opts.signedIn;
    s.mode = opts.mode || 'overwrite';
    s.harness.scriptProps.RADIUS_COOKIE = 'session=abc';
    vm.runInContext(
      'CONFIG.RADIUS.ROSTER_URL = "https://radius.mathnasium.com/IM"; ' +
      'CONFIG.RADIUS.TOKEN_PAGE_URL = "";', s.context);

    const page = dwp('complete', opts.pageDate || '8/22/2026');
    s.harness.fetchHandler.value = url => {
      if (url.indexOf('/IM') !== -1) {
        return { code: 200, body: rosterReply(
          opts.onRoster === false ? ['Someone Else'] : ['Amalie Laz']) };
      }
      return opts.dwpFails ? { code: 500, body: 'boom' } : { code: 200, body: page };
    };
    confirmRadiusImport(s, { mode: opts.mode || 'overwrite' });
    return { s: s,
      L: () => String(s.wop.values[0][11]), M: () => String(s.wop.values[0][12]),
      H: () => String(s.wop.values[0][7]),
      dwpFetches: () => s.harness.fetchLog.filter(
        c => String(c.url).indexOf('/DWP/') !== -1).length,
      said: () => s.harness.alerts.concat(
        s.harness.dialogs.map(d => d.html)).join(' ') };
  }

  // Their most recent session is from another day: they were not in.
  let r = run({ pageDate: '8/15/2026' });
  check('absent: sign-in and sign-out are marked', [r.L(), r.M()], ['?', '?']);
  check('absent: nothing else is written', r.H(), '');
  checkTruthy('absent: the report says why', r.said().includes('not today'));

  // Not on the roster at all is the same kind of fact.
  r = run({ onRoster: false });
  check('absent: an unrostered student is marked too', [r.L(), r.M()], ['?', '?']);

  // A row that already records the cancellation is left entirely alone, and
  // Radius is not asked a question somebody has already answered.
  r = run({ rowNote: 'LM cancel, mum called at 3' });
  check('not coming: nothing written', [r.L(), r.M(), r.H()], ['', '', '']);
  check('not coming: the DWP is never fetched', r.dwpFetches(), 0);
  checkTruthy('not coming: the report says which words stopped it',
    r.said().includes('LM cancel'));

  r = run({ rowNote: 'NO SHOW' });
  check('not coming: matched whatever the case', [r.L(), r.M()], ['', '']);
  r = run({ rowNote: 'no show', rowNoteColumn: 14 });
  check('not coming: found in any column of the row', [r.L(), r.M()], ['', '']);

  // The distinction that matters: a failure to find out is not an absence.
  // Marking it "?" would put a confident answer where nobody knows one.
  r = run({ dwpFails: true });
  check('unknown: a fetch failure marks nothing', [r.L(), r.M()], ['', '']);
  checkTruthy('unknown: and is reported as a failure',
    r.said().includes('HTTP 500'));

  // The preview has to say why, or two lone question marks read as a glitch.
  r = run({ pageDate: '8/15/2026' });
  checkTruthy('absent: the preview marks them as not in',
    r.said().includes('not in today'));
  checkTruthy('absent: and gives the reason there too',
    r.said().includes('8/15/2026'));

  // A mixed selection: one in, one not coming, both accounted for.
  r = (function () {
    const s = scenario([HEADER, ...DECK_FILLER_ROWS,
      ['Amalie Laz', '', '', '', '', '', '', '', '', '', '', '', ''],
      ['John Roe', '', '', '', '', '', '', '', '', '', '', '', '']],
      [{ name: 'Amalie Laz' }, { name: 'John Roe' }],
      { start: 1, rows: 2 }, '2026-08-22');
    s.wop.values[1][16] = 'no show';
    s.harness.scriptProps.RADIUS_COOKIE = 'session=abc';
    vm.runInContext(
      'CONFIG.RADIUS.ROSTER_URL = "https://radius.mathnasium.com/IM"; ' +
      'CONFIG.RADIUS.TOKEN_PAGE_URL = "";', s.context);
    const page = dwp('complete', '8/22/2026');
    s.harness.fetchHandler.value = url => ({ code: 200, body:
      url.indexOf('/IM') !== -1
        ? rosterReply(['Amalie Laz', 'John Roe']) : page });
    confirmRadiusImport(s);
    return { s: s, said: () => s.harness.alerts.concat(
      s.harness.dialogs.map(d => d.html)).join(' ') };
  })();
  check('mixed: the student who came is imported',
    String(r.s.wop.values[0][7]), '33');
  check('mixed: the one already marked not coming is untouched',
    [String(r.s.wop.values[1][7]), String(r.s.wop.values[1][11])], ['', '']);
  checkTruthy('mixed: and the preview accounts for them',
    r.said().includes('not coming'));

  // A time already in the sign-in column says a person was here to write it.
  // The absent mark is our own note that there was no session to read, so it
  // fills an empty cell or stays out of the way -- under every mode. Appending
  // gave "10:48 AM | ?", a cell claiming both at once.
  ['append', 'overwrite', 'skip'].forEach(function (mode) {
    const t = run({ pageDate: '8/15/2026', signedIn: '10:48 AM', mode: mode });
    check('absent (' + mode + '): the time written by a person stands',
      t.L(), '10:48 AM');
  });
  r = run({ pageDate: '8/15/2026', signedIn: '10:48 AM' });
  checkTruthy('absent: and the contradiction is reported',
    r.said().includes('says they were here'));
  check('absent: the empty column beside it is still marked', r.M(), '?');
}

// 45m. Edge cases that had no rule, and now do.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  const r = (a, b) => api.reviewSessionTiming_(a, b);

  // Signed out before signed in. Wrapping round the clock made 5:00 PM to
  // 4:00 PM a 23 hour session, shaded, with nothing said about it.
  check('backwards: no duration is claimed', r('5:00 PM', '4:00 PM').durationMinutes, null);
  check('backwards: says what is wrong', r('5:00 PM', '4:00 PM').notes,
    ['signed out before signed in — check the times']);
  checkTruthy('backwards: still shaded', r('5:00 PM', '4:00 PM').shade);
  check('backwards: a late evening pair is not a real session either',
    r('11:00 PM', '12:30 AM').notes,
    ['signed out before signed in — check the times']);

  // In and out on the same minute is a slip, not an early departure.
  check('same minute: named for what it is', r('4:00 PM', '4:00 PM').notes,
    ['signed in and out at the same time']);
  check('same minute: duration is zero, not an hour',
    r('4:00 PM', '4:00 PM').durationMinutes, 0);

  // One minute is a real, if daft, duration, and is measured normally.
  check('one minute: measured against the end of the slot',
    r('4:00 PM', '4:01 PM').notes, ['left 59 minutes early']);

  // Markers match as whole phrases. "no show" lives inside "Juno Showalter".
  check('marker: a name containing the letters is not a marker',
    api.rowSaysNotComing_(['Juno Showalter', '']), '');
  check('marker: the phrase itself still matches',
    api.rowSaysNotComing_(['', 'no show']), 'no show');
  check('marker: punctuation around it is fine',
    api.rowSaysNotComing_(['(no show)']), 'no show');
  check('marker: mid-sentence is fine',
    api.rowSaysNotComing_(['mum rang, no show today']), 'no show');
  check('marker: numbers in the row do not break it',
    api.rowSaysNotComing_([1, 2, 'LM cancel']), 'LM cancel');
  check('marker: a longer word it starts is not a match',
    api.rowSaysNotComing_(['no showing up ever']), '');
}

// 45n. A student seated at a table no pod covers.
{
  const chart = JSON.parse(fs.readFileSync('tests/fixtures/seating-populated.json', 'utf8'))
    .map(row => row.slice());
  chart[2][1] = '9.0';          // table 8 renumbered to one no pod claims
  chart[3][1] = 'Stray Kid';    // with somebody sitting at it

  const wopRows = [['Stray Kid']].map(row => {
    const r = row.slice(); while (r.length < 26) r.push(''); return r;
  });
  const deck = new FakeSheet('Deck List',
    [HEADER, ['Jane Doe', 'T1', '', '', '', '', '', '', '', '', '', '', '']]);
  const wop = new FakeSheet('Daily WOP', wopRows, makeGrid(1, 26, '#ffffff'));
  const seating = new FakeSheet('weekdays', chart,
    makeGrid(chart.length, chart[0].length, '#ffffff'));
  const ctx = vm.createContext({ console, Buffer, JSON, Math,
      Date: fixedDate('2026-08-19'), String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  const h = install(ctx, [deck, wop, seating], 'Daily WOP');
  loadScript(ctx).organizeSeatingRows();

  const said = h.alerts.concat(h.dialogs.map(d => d.html)).join(' ');
  const column = wop.values.map(v => String(v[0])).filter(Boolean);

  checkTruthy('unpodded: the student is not lost',
    column.some(v => v === 'Stray Kid'));
  checkTruthy('unpodded: the reason names the table',
    said.includes('table 9') && said.includes('not in any pod'));
  checkTruthy('unpodded: and does not claim they are missing from the chart',
    !said.includes('Stray Kid</b> is on the Daily WOP but not on the seating chart'));
  checkTruthy('unpodded: points at the setting to fix',
    said.includes('CONFIG.SEATING.PODS'));
}

// 45o. One student, several rows, one session.
//
//      The SOD organiser writes a row per student per hour, so the same name
//      in the selection twice is ordinary. Radius offers only their most
//      recent session, and it used to be written into every one of those rows
//      -- the noon row receiving the afternoon's pages, times and notes, with
//      nothing to say it had happened.
{
  function run(names) {
    const wopRows = names.map(function (n) {
      const row = [n]; while (row.length < 26) row.push(''); return row;
    });
    const deck = new FakeSheet('Deck List',
      [HEADER, ['Jane Doe', 'T1', '', '', '', '', '', '', '', '', '', '', '']]);
    const wop = new FakeSheet('Daily WOP', wopRows,
      makeGrid(names.length, 26, '#ffffff'));
    wop.setSelection(1, names.length);
    const ctx = vm.createContext({ console, Buffer, JSON, Math,
      Date: fixedDate('2026-08-22'), String, Number, Object, Array, RegExp,
      Error, isNaN, parseInt, parseFloat });
    const h = install(ctx, [deck, wop], 'Daily WOP');
    h.scriptProps.RADIUS_COOKIE = 'session=abc';
    const api = loadScript(ctx);
    vm.runInContext('CONFIG.RADIUS.ROSTER_URL = ' +
      '"https://radius.mathnasium.com/IM"; CONFIG.RADIUS.TOKEN_PAGE_URL = "";', ctx);
    const page = dwp('complete', '8/22/2026');   // signs in at 10:48 AM
    h.fetchHandler.value = url => ({ code: 200, body:
      url.indexOf('/IM') !== -1 ? rosterReply(['Amalie Laz']) : page });

    api.importRadiusData();
    const preview = h.dialogs[h.dialogs.length - 1];
    if (preview && preview.title === 'Confirm Radius import') {
      const token = (preview.html.match(/name="token" value="([^"]+)"/) || [])[1];
      const form = { token: token, mode: 'overwrite' };
      (preview.html.match(/name="pick_(\d+)"/g) || []).forEach(function (m) {
        form['pick_' + m.match(/\d+/)[0]] = 'on';
      });
      api.applyRadiusPlan_FromUI(form);
    }
    return { wop: wop, pages: i => String(wop.values[i][7]),
      said: () => h.alerts.concat(h.dialogs.map(d => d.html)).join(' ') };
  }

  // Signed in at 10:48: nearer the 11:00 slot than the 10:00 one.
  let r = run(['10:00 Amalie Laz', '11:00 Amalie Laz']);
  check('one session: it goes to the hour it belongs to',
    [r.pages(0), r.pages(1)], ['', '33']);
  checkTruthy('one session: the empty row is explained',
    r.said().includes('only their most recent session'));

  // Order on the sheet does not decide it; the hour does.
  r = run(['11:00 Amalie Laz', '2:00 Amalie Laz']);
  check('one session: the nearer hour wins wherever it sits',
    [r.pages(0), r.pages(1)], ['33', '']);

  // No hours to tell the rows apart: a guess would write one hour's work
  // against another, so nothing is written and the reason is given.
  r = run(['Amalie Laz', 'Amalie Laz']);
  check('one session: without hours, neither row is filled',
    [r.pages(0), r.pages(1)], ['', '']);
  checkTruthy('one session: and it says why',
    r.said().includes('no hours to tell them apart'));

  // A single row for a student is untouched by any of this.
  r = run(['10:00 Amalie Laz']);
  check('one session: a lone row still imports', r.pages(0), '33');
}

// 45p. Column K holding something EOD cannot read.
//
//      "YU" for "YY" used to be skipped in silence, and the report then said
//      nothing in the selection needed processing -- which whoever typed it
//      would have every reason to believe.
{
  function run(status) {
    const s = scenario(
      [HEADER, ['Jane Doe', 'T1', '', '', 'T2', '', '', '', '', '', '', '', '']],
      [{ name: 'Jane Doe', status: status }], { start: 1, rows: 1 });
    s.api.processWopToDeck();
    return { s: s, B: () => s.deckCell(2, C.CURRENT),
      K: () => s.wopStatus(0), Kbg: () => s.wopStatusBg(0),
      said: () => s.harness.alerts.concat(
        s.harness.dialogs.map(d => d.html)).join(' ') };
  }

  let r = run('YU');
  check('typo: nothing is applied', r.B(), 'T1');
  check('typo: the cell is left as typed', r.K(), 'YU');
  checkTruthy('typo: the cell is marked', r.Kbg().toLowerCase() === '#ffcccc');
  checkTruthy('typo: and it is named in the report',
    r.said().includes('YU') && r.said().includes('not a Y/P instruction'));
  checkTruthy('typo: the report no longer claims there was nothing to do',
    !r.said().includes('Nothing in the highlighted selection needed processing'));

  // A blank cell is a row with nothing to do, and stays quiet.
  r = run('');
  check('blank: left alone', [r.B(), r.K()], ['T1', '']);
  checkTruthy('blank: not marked', r.Kbg().toLowerCase() === '#ffffff');
  checkTruthy('blank: nothing said about it', !r.said().includes('not a Y/P'));

  // EOD writes its own markers into K, and must still read them back.
  r = run('Y (2 of 3 done, ran out)');
  check('marker: EOD reads its own note back', r.B(), 'T2');
  r = run('YYP - B empty?');
  checkTruthy('marker: the B-empty note is understood too',
    !r.said().includes('not a Y/P instruction'));

  // Lower case and stray spaces are people, not typos.
  check('case: a lower-case y still works', run('y').B(), 'T2');
  check('spacing: padding still works', run('  Y  ').B(), 'T2');
}

// 45q. A chart that seats one student twice in the same hour.
{
  function organise(edits, names) {
    const chart = JSON.parse(fs.readFileSync('tests/fixtures/seating-populated.json', 'utf8'))
      .map(row => row.slice());
    edits.forEach(e => { chart[e[0]][e[1]] = e[2]; });
    const wopRows = names.map(function (n) {
      const r = [n]; while (r.length < 26) r.push(''); return r;
    });
    const deck = new FakeSheet('Deck List',
      [HEADER, ['Jane Doe', 'T1', '', '', '', '', '', '', '', '', '', '', '']]);
    const wop = new FakeSheet('Daily WOP', wopRows,
      makeGrid(names.length, 26, '#ffffff'));
    const seating = new FakeSheet('weekdays', chart,
      makeGrid(chart.length, chart[0].length, '#ffffff'));
    const ctx = vm.createContext({ console, Buffer, JSON, Math,
      Date: fixedDate('2026-08-19'), String, Number,
      Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
    const h = install(ctx, [deck, wop, seating], 'Daily WOP');
    loadScript(ctx).organizeSeatingRows();
    return { wop: wop,
      column: () => wop.values.map(v => String(v[0])).filter(Boolean),
      said: () => h.alerts.concat(h.dialogs.map(d => d.html)).join(' ') };
  }

  // 1C and 1B at noon: the same student, twice, in one hour.
  let r = organise([[3, 15, 'Twin'], [4, 15, 'Twin']], ['Twin']);
  check('double booked: listed once, not twice',
    r.column().filter(v => v.indexOf('Twin') !== -1), ['12:00 Twin']);
  checkTruthy('double booked: both seats are named',
    r.said().includes('1C') && r.said().includes('1B'));
  checkTruthy('double booked: and the chart is what gets blamed',
    r.said().includes('fix the chart'));

  // The same student at two different hours is ordinary, and stays two rows.
  r = organise([[3, 15, 'Twin'], [8 + 1, 15, 'Twin']], ['Twin']);
  check('two hours: still two rows',
    r.column().filter(v => v.indexOf('Twin') !== -1).length, 2);

  // A block with no time beside it: the students keep their place but the
  // missing label is said out loud rather than left to be noticed.
  r = organise([[4, 0, '']], ['Student  1']);
  checkTruthy('unlabelled hour: reported',
    r.said().includes('no time beside it'));
}

// 45r. A task sitting in the queue twice.
{
  function sod(queue) {
    const s = scenario(
      [HEADER, ['Jane Doe', 'T1', 'pink', '', '', queue, '', '', '', '', '', '', '']],
      [{ name: 'Jane Doe' }], { start: 1, rows: 1 });
    s.api.processSodPinks();
    const dialog = s.harness.dialogs[s.harness.dialogs.length - 1];
    const token = (dialog.html.match(/name="token" value="([^"]+)"/) || [])[1];
    const form = { token: token };
    (dialog.html.match(/name="(move_\d+)"/g) || []).forEach(function (m) {
      form[m.match(/"([^"]+)"/)[1]] = '1';
    });
    s.api.executeSodOperations_FromUI(form);
    return { s: s, E: () => s.deckCell(2, C.LOADED), F: () => s.deckCell(2, C.QUEUE),
      said: () => s.harness.alerts.concat(
        s.harness.dialogs.map(d => d.html)).join(' ') };
  }

  // Printed now and still waiting: the student works it twice and EOD archives
  // it twice, and neither run looks wrong from the inside.
  let r = sod('T2, , T2, T3');
  check('repeat: the task is printed', r.E(), 'T2');
  check('repeat: and is still in the queue', r.F(), 'T2, T3');
  checkTruthy('repeat: which is said out loud',
    r.said().includes('more than once'));

  // An ordinary queue says nothing about repeats.
  r = sod('T2, T3');
  check('no repeat: printed and gone from the queue', [r.E(), r.F()], ['T2', 'T3']);
  checkTruthy('no repeat: nothing said', !r.said().includes('more than once'));

  // Blanks in the queue are dropped without comment -- they are not a repeat.
  r = sod('T2, , T3');
  check('blanks: ignored', [r.E(), r.F()], ['T2', 'T3']);
  checkTruthy('blanks: not reported as a repeat', !r.said().includes('more than once'));
}

// 45s. A selection longer than six minutes allows.
//
//      Apps Script stops a run at six minutes, so a long selection is fetched
//      as far as it gets. The preview used to say only how many students it
//      had, which leaves the rest looking done -- and the report afterwards
//      counts what was written, agrees with itself, and never mentions the
//      rows nobody ever asked about.
{
  const names = [];
  for (let n = 0; n < 6; n++) names.push('Student ' + n);

  const wopRows = names.map(function (n) {
    const row = [n]; while (row.length < 26) row.push(''); return row;
  });
  const deck = new FakeSheet('Deck List',
    [HEADER, ['Jane Doe', 'T1', '', '', '', '', '', '', '', '', '', '', '']]);
  const wop = new FakeSheet('Daily WOP', wopRows, makeGrid(6, 26, '#ffffff'));
  wop.setSelection(1, 6);

  // Two minutes pass on every reading of the clock, so the run gives up partway.
  const ctx = vm.createContext({ console, Buffer, JSON, Math,
    Date: fixedDate('2026-08-22', 120000), String, Number, Object, Array,
    RegExp, Error, isNaN, parseInt, parseFloat });
  const h = install(ctx, [deck, wop], 'Daily WOP');
  h.scriptProps.RADIUS_COOKIE = 'session=abc';
  const api = loadScript(ctx);
  vm.runInContext('CONFIG.RADIUS.ROSTER_URL = "https://radius.mathnasium.com/IM"; ' +
    'CONFIG.RADIUS.TOKEN_PAGE_URL = "";', ctx);
  // Each page has to name the student it was asked for, or the mislinked-page
  // guard turns every row into a problem and there is no plan to preview.
  const page = dwp('complete');
  h.fetchHandler.value = url => {
    if (url.indexOf('/IM') !== -1) return { code: 200, body: rosterReply(names) };
    const id = Number((url.match(/studentId=(\d+)/) || [])[1]);
    const who = names[id - 1000] || names[0];
    return { code: 200, body:
      page.replace(/<title>[^<]*<\/title>/, '<title>' + who + '</title>') };
  };

  api.importRadiusData();
  const preview = h.dialogs[h.dialogs.length - 1];

  checkTruthy('ceiling: the preview says the run stopped early',
    preview.html.includes('This run stopped early'));
  checkTruthy('ceiling: and how many rows went unasked',
    /row\(s\) from row \d+ down were never asked about/.test(preview.html));
  checkTruthy('ceiling: it does not simply report a smaller success',
    preview.html.indexOf('stopped early') < preview.html.indexOf('Confirm changes for all'));

  // Confirming what was fetched must not make the report look complete.
  const token = (preview.html.match(/name="token" value="([^"]+)"/) || [])[1];
  const form = { token: token, mode: 'overwrite' };
  (preview.html.match(/name="pick_(\d+)"/g) || []).forEach(function (m) {
    form['pick_' + m.match(/\d+/)[0]] = 'on';
  });
  api.applyRadiusPlan_FromUI(form);

  const report = h.dialogs[h.dialogs.length - 1].html;
  checkTruthy('ceiling: the report says so too',
    report.includes('Run stopped early'));
  checkTruthy('ceiling: and tells you what to do about it',
    report.includes('Highlight the rest and run again'));
}

// 45t. The seating import against rows the organiser wrote.
//
//      The organiser heads each row with an hour and gives a student who came
//      twice two rows. Counting rows rather than people then made every one of
//      their seats look like it could belong to two different students, so the
//      ambiguity guard fired and nothing at all was written -- for the
//      commonest arrangement there is.
{
  function go(names, edits) {
    const chart = JSON.parse(fs.readFileSync('tests/fixtures/seating-populated.json', 'utf8'))
      .map(row => row.slice());
    (edits || []).forEach(e => { chart[e[0]][e[1]] = e[2]; });
    const wopRows = names.map(function (n) {
      const r = [n]; while (r.length < 26) r.push(''); return r;
    });
    const deck = new FakeSheet('Deck List',
      [HEADER, ['Jane Doe', 'T1', '', '', '', '', '', '', '', '', '', '', '']]);
    const wop = new FakeSheet('Daily WOP', wopRows,
      makeGrid(names.length, 26, '#ffffff'));
    wop.setSelection(1, names.length);
    // Pinned to a Saturday, so this block reads the Saturday tab throughout.
    const seating = new FakeSheet('saturday', chart,
      makeGrid(chart.length, chart[0].length, '#ffffff'));
    const ctx = vm.createContext({ console, Buffer, JSON, Math,
      Date: fixedDate('2026-08-22'), String, Number, Object, Array, RegExp,
      Error, isNaN, parseInt, parseFloat });
    const h = install(ctx, [deck, wop, seating], 'Daily WOP');
    loadScript(ctx).importSeatingChart();
    return { N: i => String(wop.values[i][13]),
      said: () => h.alerts.concat(h.dialogs.map(d => d.html)).join(' ') };
  }

  // Sat at 1C at noon and 3A at one o'clock: each row gets its own hour.
  const twice = [[3, 15, 'Amalie L'], [10, 11, 'Amalie L']];
  let r = go(['12:00 Amalie Laz', '1:00 Amalie Laz'], twice);
  check('per hour: the noon row gets the noon seat', r.N(0), '1C | AA BB');
  check('per hour: the one o\'clock row gets its own', r.N(1), '3A | CC DD');
  checkTruthy('per hour: not reported as an ambiguity',
    !r.said().includes('could be'));

  // A row with no hour on it still gets everywhere they sat, as before.
  r = go(['Amalie Laz'], twice);
  check('no hour: every seat of the day', r.N(0), '1C, 3A | AA BB CC DD');

  // A row headed at an hour they were not there is not given someone else's
  // seat, and says which hour it looked for.
  r = go(['2:00 Amalie Laz'], [[3, 15, 'Amalie L']]);
  check('wrong hour: nothing written', r.N(0), '');
  checkTruthy('wrong hour: and it names the hour',
    r.said().includes('not seated at 2:00'));

  // Two genuinely different students behind one chart name is still refused.
  r = go(['12:00 Amalie Laz', '12:00 Amalie Lee'], [[3, 15, 'Amalie L']]);
  check('still ambiguous: neither is written', [r.N(0), r.N(1)], ['', '']);
  checkTruthy('still ambiguous: and both are named',
    r.said().includes('Amalie Laz or Amalie Lee'));
}

// 45u. SOD against the rows the organiser writes.
//
//      One student, a row per hour, one pink flag. Planning a move for each
//      row printed the first and then reported that the flag had been "cleared
//      while the dialog was open" -- true only in the sense that this script
//      cleared it a move earlier. A red error every morning that nobody can
//      act on is how a report stops being read.
{
  function sod(wopNames, queue) {
    const s = scenario(
      [HEADER, ['Amalie Laz', 'T1', 'pink', '', '', queue || 'T2, T3',
        '', '', '', '', '', '', '']],
      wopNames.map(function (n) { return { name: n }; }),
      { start: 1, rows: wopNames.length });
    s.api.processSodPinks();
    const dialog = s.harness.dialogs[s.harness.dialogs.length - 1];
    const token = (dialog.html.match(/name="token" value="([^"]+)"/) || [])[1];
    const form = { token: token };
    (dialog.html.match(/name="(move_\d+)"/g) || []).forEach(function (m) {
      form[m.match(/"([^"]+)"/)[1]] = '1';
    });
    s.api.executeSodOperations_FromUI(form);
    return { s: s, E: () => s.deckCell(2, C.LOADED), F: () => s.deckCell(2, C.QUEUE),
      pink: () => s.deckCell(2, C.PINK),
      said: () => s.harness.alerts.concat(
        s.harness.dialogs.map(d => d.html)).join(' ') };
  }

  let r = sod(['12:00 Amalie Laz', '1:00 Amalie Laz']);
  check('two rows: one task printed, not two', [r.E(), r.F()], ['T2', 'T3']);
  check('two rows: the pink flag is spent once', r.pink(), '');
  checkTruthy('two rows: nobody is blamed for clearing the flag',
    !r.said().includes('cleared while the dialog was open'));
  checkTruthy('two rows: counted as one student, not two',
    /Students with pinks[^0-9]*1/.test(r.said().replace(/<[^>]*>/g, ' ')));

  // Three sessions in a day is no different.
  r = sod(['9:00 Amalie Laz', '10:00 Amalie Laz', '11:00 Amalie Laz'], 'T2, T3, T4');
  check('three rows: still one move', [r.E(), r.F()], ['T2', 'T3, T4']);

  // A single row behaves exactly as it always did.
  r = sod(['Amalie Laz']);
  check('one row: unchanged', [r.E(), r.F()], ['T2', 'T3']);
  checkTruthy('one row: no complaint', !r.said().includes('cleared while'));
}

// 45v. EOD against the same rows: two sessions really are two advances.
{
  const s = scenario(
    [HEADER, ['Amalie Laz', 'T1', '', '', 'T2, T3', '', '', '', '', '', '', '', '']],
    [{ name: '12:00 Amalie Laz', status: 'Y' },
     { name: '1:00 Amalie Laz', status: 'Y' }],
    { start: 1, rows: 2 }, '2026-08-22');
  s.api.processWopToDeck();

  // Unlike the pink flag, a Y is a fact about a session, so two of them are
  // two tasks finished and both belong in the history.
  check('two sessions: advanced twice', s.deckCell(2, C.CURRENT), 'T3');
  check('two sessions: both archived', s.deckCell(2, C.ARCHIVE), 'T1 08/22 | T2 08/22');
  check('two sessions: both rows marked done',
    [s.wopStatusBg(0), s.wopStatusBg(1)], ['#00ff00', '#00ff00']);
}

// 45w. The Deck Changelog: described, not yet written to.
{
  function setup(withChangelog) {
    const deck = new FakeSheet('Deck List',
      [HEADER, ['Jane Doe', 'T1', '', '', '', '', '', '', '', '', '', '', '']]);
    const wop = new FakeSheet('Daily WOP', [new Array(26).fill('')],
      makeGrid(1, 26, '#ffffff'));
    const sheets = [deck, wop];
    if (withChangelog) {
      const head = ['Date assessment done', 'Test student', 'Day of week',
        'Next attendance', 'Most recent assessment'];
      while (head.length < 20) head.push('');
      sheets.push(new FakeSheet('Deck Changelog', [head, new Array(20).fill('')],
        makeGrid(2, 20, '#ffffff')));
    }
    const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
      Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
    const h = install(ctx, sheets, 'Daily WOP');
    loadScript(ctx).checkSheetSetup();
    return h.dialogs[h.dialogs.length - 1].html;
  }

  // Nobody has built the sheet yet. A check that nags about something that
  // does not exist is a check people learn to skip.
  const without = setup(false);
  checkTruthy('changelog: not mentioned while the sheet is absent',
    !without.includes('Deck Changelog'));
  checkTruthy('changelog: and no missing-sheet complaint',
    !without.includes('No sheet named "Deck Changelog"'));

  // Once it exists, the columns are checked like any other sheet.
  const withIt = setup(true);
  checkTruthy('changelog: listed once the sheet is there',
    withIt.includes('Deck Changelog'));
  checkTruthy('changelog: reads the headings off it',
    withIt.includes('Date assessment done'));
  checkTruthy('changelog: covers the far end of the row',
    withIt.includes("What&#39;s next") || withIt.includes("What's next"));
}

// 45x. The changelog layout describes itself honestly.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  const columns = api.CONFIG.CHANGELOG.COLUMNS;

  check('layout: one entry per column, in order',
    columns.map(c => c.column), columns.map((c, i) => i + 1));
  check('layout: every column says who fills it',
    columns.filter(c => ['script', 'radius', 'person', 'blank']
      .indexOf(c.fill) === -1), []);

  // Spacer columns are the only ones allowed to have no label.
  check('layout: only a spacer may be unlabelled',
    columns.filter(c => !c.label && c.fill !== 'blank'), []);

  // The plan drops spacers -- there is nothing to check in an empty column.
  const plan = api.changelogColumnPlan_();
  check('plan: spacers left out',
    plan.length, columns.filter(c => c.fill !== 'blank').length);

  // Most of this sheet is somebody's judgement. If that ever stops being true
  // it should be a decision, not a drift.
  checkTruthy('layout: still mostly human',
    columns.filter(c => c.fill === 'person').length > columns.length / 2);
}

// 45y. The changelog arithmetic, which is the part specified exactly.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);

  // Sheets keeps 85% as 0.85; a typed "85" stays 85. Both land in one column.
  check('percent: a typed number', api.percentValue_('85'), 85);
  check('percent: with a sign', api.percentValue_('85%'), 85);
  check('percent: a sheet fraction', api.percentValue_(0.85), 85);
  check('percent: full marks as a fraction', api.percentValue_(1), 100);
  check('percent: full marks typed', api.percentValue_(100), 100);
  check('percent: nothing there', api.percentValue_(''), null);
  check('percent: not a number', api.percentValue_('n/a'), null);
  check('percent: zero is a grade, not a blank', api.percentValue_(0), 0);

  // Stars are half the questions answered right.
  check('stars: 85% of 20 questions', api.starsFor_(85, 20), 8.5);
  check('stars: full marks', api.starsFor_(100, 20), 10);
  check('stars: none right', api.starsFor_(0, 20), 0);
  check('stars: rounds to the half', api.starsFor_(33, 20), 3.5);
  check('stars: no question count means no stars', api.starsFor_(85, 0), null);
  check('stars: no grade means no stars', api.starsFor_(null, 20), null);

  // On a repeat, the stars are earned on what is new since last time, so a
  // second sitting cannot collect the same stars twice.
  check('stars: a 20 point gain over 20 questions', api.starsFor_(20, 20), 2);
  check('stars: going backwards is not hidden', api.starsFor_(-10, 20), -1);

  // The m/dd column has no year in it, so this only ever orders two rows.
  checkTruthy('m/dd: later in the month sorts after',
    api.monthDayValue_('8/22') > api.monthDayValue_('8/01'));
  checkTruthy('m/dd: a later month sorts after',
    api.monthDayValue_('9/01') > api.monthDayValue_('8/22'));
  check('m/dd: a blank is not a date', api.monthDayValue_(''), null);
  check('m/dd: prose is not a date', api.monthDayValue_('next week'), null);
  check('m/dd: an impossible month is not a date', api.monthDayValue_('13/01'), null);
  checkTruthy('m/dd: a real Date works too',
    api.monthDayValue_(new Date(2026, 7, 22)) === api.monthDayValue_('8/22'));
}

// 45z. Finding the sitting to compare against.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  const C2 = api.CONFIG.CHANGELOG.COL;

  function row(index, student, assessment, percent) {
    const values = new Array(20).fill('');
    values[C2.STUDENT - 1] = student;
    values[C2.ASSESSMENT - 1] = assessment;
    values[C2.PERCENT - 1] = percent;
    return { index: index, sheetRow: index + 1, values: values };
  }

  const rows = [
    row(1, 'Amalie Laz', 'Checkup 6', '60'),
    row(2, 'Amalie Laz', 'Checkup 7', '70'),
    row(3, 'John Roe', 'Checkup 6', '50'),
    row(4, 'Amalie Laz', 'Checkup 6', '80'),
    row(5, 'Amalie Laz', 'Checkup 6', '')
  ];

  const found = api.previousAssessment_(rows, rows[3]);
  check('compare: the same student and the same assessment',
    found && found.index, 1);

  check('compare: a different assessment is not a comparison',
    api.previousAssessment_(rows, rows[1]), null);
  check('compare: another student\'s sitting is not a comparison',
    api.previousAssessment_(rows, rows[2]), null);
  check('compare: the first sitting has nothing before it',
    api.previousAssessment_(rows, rows[0]), null);

  // A row below is the future as far as the row being graded is concerned.
  check('compare: never looks downwards',
    api.previousAssessment_(rows, rows[0]), null);

  // An ungraded earlier row is not something to measure against.
  const ungraded = [row(1, 'Amalie Laz', 'Checkup 6', ''),
                    row(2, 'Amalie Laz', 'Checkup 6', '80')];
  check('compare: an ungraded sitting is skipped',
    api.previousAssessment_(ungraded, ungraded[1]), null);

  // Two earlier sittings: the most recent one is what counts.
  const thrice = [row(1, 'Amalie Laz', 'Checkup 6', '40'),
                  row(2, 'Amalie Laz', 'Checkup 6', '60'),
                  row(3, 'Amalie Laz', 'Checkup 6', '80')];
  check('compare: takes the latest of several',
    api.previousAssessment_(thrice, thrice[2]).index, 2);

  // Spelling and case are people, not different students.
  const loose = [row(1, 'amalie  laz', 'checkup 6', '60'),
                 row(2, 'Amalie Laz', 'Checkup 6', '80')];
  checkTruthy('compare: forgiving about case and spacing',
    api.previousAssessment_(loose, loose[1]) !== null);
}

// 45aa. The three stages against a sheet.
{
  function book(rows, options) {
    const opts = options || {};
    const head = new Array(20).fill('');
    head[1] = 'Student';
    const values = [head].concat(rows.map(function (r) {
      const row = new Array(20).fill('');
      Object.keys(r).forEach(function (k) { row[Number(k) - 1] = r[k]; });
      return row;
    }));
    const log = new FakeSheet('Deck Changelog', values,
      makeGrid(values.length, 20, '#ffffff'));
    const deck = new FakeSheet('Deck List',
      [HEADER, ['Jane Doe', 'T1', '', '', '', '', '', '', '', '', '', '', '']]);
    const wop = new FakeSheet('Daily WOP', [new Array(26).fill('')],
      makeGrid(1, 26, '#ffffff'));
    const ctx = vm.createContext({ console, Buffer, JSON, Math,
      Date: fixedDate(opts.today || '2026-08-19'), String, Number, Object,
      Array, RegExp, Error, isNaN, parseInt, parseFloat });
    const h = install(ctx, [deck, wop, log], 'Deck Changelog');
    if (opts.events) {
      h.addCalendar('own@example.com', 'My calendar', opts.events, true);
    }
    (opts.calendars || []).forEach(function (c) {
      h.addCalendar(c.id, c.name, c.events, false);
    });
    if (opts.calendarIds) {
      vm.runInContext('PropertiesService.getScriptProperties().setProperty(' +
        JSON.stringify('CHANGELOG_CALENDAR_IDS') + ', ' +
        JSON.stringify(opts.calendarIds) + ');', ctx);
    }
    const api = loadScript(ctx);
    if (opts.counts) {
      vm.runInContext('CONFIG.CHANGELOG.QUESTION_COUNTS = ' +
        JSON.stringify(opts.counts) + ';', ctx);
    }
    return { log: log, api: api,
      cell: (r, c) => String(log.values[r][c - 1]),
      said: () => h.alerts.concat(h.dialogs.map(d => d.html)).join(' ') };
  }

  const C3 = { DATE_DONE: 1, STUDENT: 2, DAY: 3, NEXT: 4, ASSESSMENT: 5,
    PERCENT: 8, STARS: 9, CHANGE: 10, LP_DATE: 15, BOOK: 18, LP_COUNT: 19 };

  // --- creation ---------------------------------------------------------
  const at = (iso, hour) => new Date(iso + 'T' + (hour || '16') + ':00:00');

  // The next session comes off the calendar. 24 August 2026 is a Monday.
  let b = book([{ 2: 'Amalie Laz' }], {
    events: [{ title: 'Amalie Laz', start: at('2026-08-24') }]
  });
  b.api.changelogCreate();
  check('create: today goes in', b.cell(1, C3.DATE_DONE), '8/19');
  check('create: the day and date come off the calendar',
    [b.cell(1, C3.DAY), b.cell(1, C3.NEXT)], ['M', '8/24']);

  // Nothing on the calendar is said as nothing, not guessed at.
  b = book([{ 2: 'Amalie Laz' }]);
  b.api.changelogCreate();
  check('create: no calendar, no date invented',
    [b.cell(1, C3.DAY), b.cell(1, C3.NEXT)], ['?', '?/?']);
  check('create: the row is still dated today', b.cell(1, C3.DATE_DONE), '8/19');
  checkTruthy('create: and the report says so',
    b.said().includes('question marks') || b.said().includes('calendar'));

  // Strictly after today: an assessment done this morning is followed up next
  // time they are in, not this afternoon.
  b = book([{ 2: 'Amalie Laz' }], {
    events: [{ title: 'Amalie Laz', start: at('2026-08-19', '18') },
             { title: 'Amalie Laz', start: at('2026-08-21') }]
  });
  b.api.changelogCreate();
  check('create: today\'s own session is not "next time"',
    [b.cell(1, C3.DAY), b.cell(1, C3.NEXT)], ['F', '8/21']);

  // The earliest of several is the one that counts.
  b = book([{ 2: 'Amalie Laz' }], {
    events: [{ title: 'Amalie Laz', start: at('2026-09-02') },
             { title: 'Amalie Laz', start: at('2026-08-20') },
             { title: 'Amalie Laz', start: at('2026-08-26') }]
  });
  b.api.changelogCreate();
  check('create: the soonest session wins', b.cell(1, C3.NEXT), '8/20');

  // A name buried in a longer title is still that student.
  b = book([{ 2: 'Amalie Laz' }], {
    events: [{ title: '4:00 Amalie Laz — session', start: at('2026-08-20') }]
  });
  b.api.changelogCreate();
  check('create: a name inside a longer title is found', b.cell(1, C3.NEXT), '8/20');

  // A guest on an event nobody named in the title.
  b = book([{ 2: 'Amalie Laz' }], {
    events: [{ title: 'Tutoring', start: at('2026-08-20'),
               guests: [{ name: 'Amalie Laz', email: 'amalie@example.com' }] }]
  });
  b.api.changelogCreate();
  check('create: a guest counts as being named', b.cell(1, C3.NEXT), '8/20');

  // A calendar that will not hand over its guest list still yields its titles.
  b = book([{ 2: 'Amalie Laz' }], {
    events: [{ title: 'Amalie Laz', start: at('2026-08-20'), guestsThrow: true }]
  });
  b.api.changelogCreate();
  check('create: a refused guest list does not lose the event',
    b.cell(1, C3.NEXT), '8/20');

  // Somebody else's session is not theirs.
  b = book([{ 2: 'Amalie Laz' }], {
    events: [{ title: 'John Roe', start: at('2026-08-20') }]
  });
  b.api.changelogCreate();
  check('create: another student\'s session is not taken',
    [b.cell(1, C3.DAY), b.cell(1, C3.NEXT)], ['?', '?/?']);

  // Nor is a different child who happens to share a first name.
  b = book([{ 2: 'Amalie Laz' }], {
    events: [{ title: 'Amalie Bourne', start: at('2026-08-20') }]
  });
  b.api.changelogCreate();
  check('create: a shared first name is not a match',
    b.cell(1, C3.NEXT), '?/?');

  // Beyond the lookahead is as good as not there, and says so rather than
  // reaching further than it was told to.
  b = book([{ 2: 'Amalie Laz' }], {
    events: [{ title: 'Amalie Laz', start: at('2026-11-02') }]
  });
  b.api.changelogCreate();
  check('create: a session past the lookahead is not found',
    b.cell(1, C3.NEXT), '?/?');
  checkTruthy('create: and the report says how far it looked',
    b.said().includes('28 days'));

  // Shorthand on the calendar: taken when it can only be one person.
  b = book([{ 2: 'Amalie Laz' }], {
    events: [{ title: 'Amalie L', start: at('2026-08-20') }]
  });
  b.api.changelogCreate();
  check('create: an abbreviation with one owner is taken',
    b.cell(1, C3.NEXT), '8/20');

  // ...and refused when it could be either of two.
  b = book([{ 2: 'Amalie L' }], {
    events: [{ title: 'Amalie Laz', start: at('2026-08-20') },
             { title: 'Amalie Lee', start: at('2026-08-21') }]
  });
  b.api.changelogCreate();
  check('create: shorthand that could be two children is refused',
    [b.cell(1, C3.DAY), b.cell(1, C3.NEXT)], ['?', '?/?']);

  // A named calendar is used in place of the account's own.
  b = book([{ 2: 'Amalie Laz' }], {
    events: [{ title: 'Amalie Laz', start: at('2026-08-20') }],
    calendars: [{ id: 'centre@example.com', name: 'Centre',
                  events: [{ title: 'Amalie Laz', start: at('2026-08-25') }] }],
    calendarIds: 'centre@example.com'
  });
  b.api.changelogCreate();
  check('create: the named calendar is the one read', b.cell(1, C3.NEXT), '8/25');

  // A calendar id nothing answers to is said, not silently empty.
  b = book([{ 2: 'Amalie Laz' }], { calendarIds: 'nobody@example.com' });
  b.api.changelogCreate();
  check('create: an unreachable calendar leaves question marks',
    b.cell(1, C3.NEXT), '?/?');
  checkTruthy('create: and names the calendar it could not open',
    b.said().includes('nobody@example.com'));

  // A row somebody already dated is left exactly as it is.
  b = book([{ 1: '8/01', 2: 'Amalie Laz', 3: 'F', 4: '8/07' }]);
  b.api.changelogCreate();
  check('create: an existing row is not re-dated',
    [b.cell(1, C3.DATE_DONE), b.cell(1, C3.NEXT)], ['8/01', '8/07']);

  // --- grading ----------------------------------------------------------
  // A first sitting: no comparison, and the stars come off the whole grade.
  b = book([{ 2: 'Amalie Laz', 5: 'Checkup 6', 8: '85' }],
    { counts: { 'Checkup 6': 20 } });
  b.api.changelogGrade();
  check('grade: no previous sitting is said, not left blank',
    b.cell(1, C3.CHANGE), 'NA');
  check('grade: stars off the whole grade', b.cell(1, C3.STARS), '8.5');

  // A repeat: the change drives the stars, so the same ground is not paid for
  // twice. 60% then 80% over 20 questions is four new questions, two stars.
  b = book([{ 2: 'Amalie Laz', 5: 'Checkup 6', 8: '60' },
            { 2: 'Amalie Laz', 5: 'Checkup 6', 8: '80' }],
    { counts: { 'Checkup 6': 20 } });
  b.api.changelogGrade();
  check('grade: the change is written', b.cell(2, C3.CHANGE), '+20%');
  check('grade: stars on what is new', b.cell(2, C3.STARS), '2');
  check('grade: the first sitting keeps its own answer',
    [b.cell(1, C3.CHANGE), b.cell(1, C3.STARS)], ['NA', '6']);

  // Going backwards is recorded rather than tidied away.
  b = book([{ 2: 'Amalie Laz', 5: 'Checkup 6', 8: '80' },
            { 2: 'Amalie Laz', 5: 'Checkup 6', 8: '70' }],
    { counts: { 'Checkup 6': 20 } });
  b.api.changelogGrade();
  check('grade: a drop is shown as a drop', b.cell(2, C3.CHANGE), '-10%');
  check('grade: and the stars follow it down', b.cell(2, C3.STARS), '-1');

  // An assessment nobody has given a question count to: the change still
  // lands, the stars are left for a person, and the report says which.
  b = book([{ 2: 'Amalie Laz', 5: 'Checkup 9', 8: '85' }]);
  b.api.changelogGrade();
  check('grade: the change is still worked out', b.cell(1, C3.CHANGE), 'NA');
  check('grade: but the stars are left alone', b.cell(1, C3.STARS), '');
  checkTruthy('grade: and the reason names the assessment',
    b.said().includes('Checkup 9') && b.said().includes('QUESTION_COUNTS'));

  // A row with no grade yet is skipped and said out loud.
  b = book([{ 2: 'Amalie Laz', 5: 'Checkup 6' }], { counts: { 'Checkup 6': 20 } });
  b.api.changelogGrade();
  check('grade: an ungraded row is untouched',
    [b.cell(1, C3.CHANGE), b.cell(1, C3.STARS)], ['', '']);
  checkTruthy('grade: and is reported', b.said().includes('no grade'));

  // A row somebody has already marked done is theirs, not the script's.
  b = book([{ 2: 'Amalie Laz', 5: 'Checkup 6', 8: '60' },
            { 2: 'Amalie Laz', 5: 'Checkup 6', 8: '80', 9: '5', 10: 'by hand',
              12: 'x' }],
    { counts: { 'Checkup 6': 20 } });
  b.api.changelogGrade();
  check('grade: a row marked done keeps what a person put in it',
    [b.cell(2, C3.CHANGE), b.cell(2, C3.STARS)], ['by hand', '5']);

  // Rows out of date order still get graded, but the doubt is said out loud.
  b = book([{ 1: '8/20', 2: 'Amalie Laz', 5: 'Checkup 6', 8: '60' },
            { 1: '8/12', 2: 'Amalie Laz', 5: 'Checkup 6', 8: '80' }],
    { counts: { 'Checkup 6': 20 } });
  b.api.changelogGrade();
  check('grade: an out-of-order sheet is still graded on row order',
    b.cell(2, C3.CHANGE), '+20%');
  checkTruthy('grade: and the doubt about it is reported',
    b.said().includes('out of order'));

  // In the ordinary case there is nothing to complain about.
  b = book([{ 1: '8/12', 2: 'Amalie Laz', 5: 'Checkup 6', 8: '60' },
            { 1: '8/20', 2: 'Amalie Laz', 5: 'Checkup 6', 8: '80' }],
    { counts: { 'Checkup 6': 20 } });
  b.api.changelogGrade();
  checkTruthy('grade: rows in order are not complained about',
    !b.said().includes('out of order'));

  // --- learning plan ----------------------------------------------------
  b = book([{ 2: 'Amalie Laz', 5: 'Checkup 6', 15: '8/01' },
            { 2: 'Amalie Laz', 5: 'Checkup 7' }]);
  b.api.changelogLearningPlan();
  check('lp: dated today', b.cell(2, C3.LP_DATE), '8/19');
  check('lp: counted as their second', b.cell(2, C3.LP_COUNT), '2');
  check('lp: the earlier row is left alone', b.cell(1, C3.LP_DATE), '8/01');
  checkTruthy('lp: the workout book is asked for, not invented',
    b.said().includes('workout book'));
  check('lp: and that column is left empty', b.cell(2, C3.BOOK), '');

  // A book already written in is not nagged about.
  b = book([{ 2: 'Amalie Laz', 18: 'WOB 3' }]);
  b.api.changelogLearningPlan();
  checkTruthy('lp: a book already there is left in peace',
    !b.said().includes('workout book'));

  // --- what the three stages between them touch -------------------------
  // CONFIG says which columns are the script's and which are somebody's
  // judgement. Run all three stages over one row and see: the columns that
  // change must be exactly the ones marked 'script'. A stage that later starts
  // writing an initials column fails here rather than quietly taking it over.
  b = book([{ 2: 'Amalie Laz', 5: 'Checkup 6', 8: '85' }],
    { counts: { 'Checkup 6': 20 } });
  const beforeRun = b.log.values[1].slice();
  b.api.changelogCreate();
  b.api.changelogGrade();
  b.api.changelogLearningPlan();
  const touched = [];
  b.log.values[1].forEach(function (value, i) {
    if (String(value) !== String(beforeRun[i])) touched.push(i + 1);
  });
  check('stages: write exactly the columns CONFIG calls the script\'s',
    touched,
    b.api.CONFIG.CHANGELOG.COLUMNS
      .filter(c => c.fill === 'script').map(c => c.column));
}

// 45aa2. Saying which calendar, given what Google Calendar actually hands you.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  const h = install(ctx, [], null);
  const api = loadScript(ctx);

  const ID = 'c_9a8b7c@group.calendar.google.com';
  const from = t => api.calendarIdFromLink_(t);

  // The Calendar ID itself, which is the one string nobody copies first.
  check('cal id: the bare id', from(ID), ID);
  check('cal id: a personal calendar', from('someone@gmail.com'),
    'someone@gmail.com');
  check('cal id: your own', from('primary'), 'primary');
  check('cal id: with spaces round it', from('  ' + ID + '  '), ID);

  // The iCal address, which is what "Integrate calendar" offers first.
  check('cal id: the secret iCal address',
    from('https://calendar.google.com/calendar/ical/' +
      encodeURIComponent(ID) + '/private-3f2a9/basic.ics'), ID);
  check('cal id: the public iCal address',
    from('https://calendar.google.com/calendar/ical/' +
      encodeURIComponent(ID) + '/public/basic.ics'), ID);

  // The embed address, and the whole embed code pasted in one go.
  check('cal id: the embed address',
    from('https://calendar.google.com/calendar/embed?src=' +
      encodeURIComponent(ID) + '&ctz=America%2FNew_York'), ID);
  check('cal id: the entire embed code',
    from('<iframe src="https://calendar.google.com/calendar/embed?src=' +
      encodeURIComponent(ID) + '&ctz=America%2FNew_York" width="800"></iframe>'),
    ID);

  // The share link, which carries the id base64'd behind cid=.
  check('cal id: the share link',
    from('https://calendar.google.com/calendar/u/0?cid=' +
      Buffer.from(ID, 'utf8').toString('base64')), ID);
  check('cal id: a share link with the padding stripped',
    from('https://calendar.google.com/calendar/r?cid=' +
      Buffer.from(ID, 'utf8').toString('base64').replace(/=+$/, '')), ID);

  // Things that are not calendars come back empty rather than being handed
  // to Google as an id and reported as a calendar that does not exist.
  check('cal id: a link to something else', from('https://example.com/x'), '');
  check('cal id: a link with an address buried in its path',
    from('https://example.com/share/someone@x.com'), '');
  check('cal id: a spreadsheet link',
    from('https://docs.google.com/spreadsheets/d/abc/edit'), '');
  check('cal id: prose', from('the one Sharon shares with me'), '');
  check('cal id: nothing', from(''), '');

  // --- the picker -------------------------------------------------------
  h.addCalendar('own@example.com', 'My calendar', [], true);
  h.addCalendar(ID, 'Centre sessions', []);

  api.setSessionCalendar();
  const shown = h.dialogs[h.dialogs.length - 1];
  checkTruthy('cal picker: it lists what the account can see',
    shown.html.includes('Centre sessions') && shown.html.includes('My calendar'));
  checkTruthy('cal picker: with a box for one that is not listed',
    shown.html.includes('iCal address') && shown.html.includes('embed code'));

  // Ticking one.
  const save = form => {
    try { api.saveSessionCalendar_FromUI(form); return ''; }
    catch (e) { return e.message; }
  };
  check('cal picker: ticking one is not refused', save({ pick: ID }), '');
  check('cal picker: a ticked calendar is stored',
    vm.runInContext('PropertiesService.getScriptProperties()' +
      '.getProperty("CHANGELOG_CALENDAR_IDS")', ctx), ID);
  checkTruthy('cal picker: and it says which, by name',
    h.alerts.join(' ').includes('Centre sessions'));

  // Ticking two.
  check('cal picker: ticking two is not refused',
    save({ pick: [ID, 'own@example.com'] }), '');
  check('cal picker: two ticked are both stored',
    vm.runInContext('PropertiesService.getScriptProperties()' +
      '.getProperty("CHANGELOG_CALENDAR_IDS")', ctx),
    ID + ', own@example.com');

  // Pasting a link instead of ticking -- the case that was broken.
  check('cal picker: a pasted iCal address is not refused', save({ pasted:
    'https://calendar.google.com/calendar/ical/' + encodeURIComponent(ID) +
    '/private-3f2a9/basic.ics' }), '');
  check('cal picker: a pasted iCal address is understood',
    vm.runInContext('PropertiesService.getScriptProperties()' +
      '.getProperty("CHANGELOG_CALENDAR_IDS")', ctx), ID);

  // Something that is not a calendar is refused, and nothing is saved.
  let refused = '';
  try { api.saveSessionCalendar_FromUI({ pasted: 'https://example.com/x' }); }
  catch (e) { refused = e.message; }
  checkTruthy('cal picker: a link that is not a calendar is refused',
    refused.includes('not a calendar address'));
  check('cal picker: and the old choice is left alone',
    vm.runInContext('PropertiesService.getScriptProperties()' +
      '.getProperty("CHANGELOG_CALENDAR_IDS")', ctx), ID);

  // A calendar id nothing answers to is refused too, with the likely reason.
  refused = '';
  try { api.saveSessionCalendar_FromUI({ pasted: 'nobody@example.com' }); }
  catch (e) { refused = e.message; }
  checkTruthy('cal picker: an id nothing answers to is refused',
    refused.includes('nobody@example.com') && refused.includes('sharing'));

  // Ticking nothing goes back to the account's own calendar.
  check('cal picker: ticking nothing is not refused', save({}), '');
  check('cal picker: nothing ticked means your own calendar',
    vm.runInContext('PropertiesService.getScriptProperties()' +
      '.getProperty("CHANGELOG_CALENDAR_IDS")', ctx), null);

  // The first run of all, before Google has been asked for permission.
  vm.runInContext('__calendarsThrow = true;', ctx);
  api.setSessionCalendar();
  checkTruthy('cal picker: no permission yet is named for what it is',
    h.alerts.join(' ').includes('accept the permission'));
  vm.runInContext('__calendarsThrow = false;', ctx);
}

// 45ab. Drafting a progress report.
{
  // A drafter on whichever sheet you happen to be looking at.
  function pr(options) {
    const opts = options || {};
    const deckRows = [HEADER].concat(opts.deck || []);
    const deck = new FakeSheet('Deck List', deckRows.map(r => {
      const row = r.slice(); while (row.length < 13) row.push(''); return row;
    }));

    // A plain string is a name in column A; an object can also put something
    // in another column, so a row can exist with no name on it.
    const wopValues = (opts.wop || []).map(entry => {
      const row = new Array(26).fill('');
      if (entry && typeof entry === 'object') {
        row[0] = entry.name || '';
        row[4] = entry.note || '';
      } else {
        row[0] = entry;
      }
      return row;
    });
    const wop = new FakeSheet('Daily WOP',
      wopValues.length ? wopValues : [new Array(26).fill('')],
      makeGrid(Math.max(wopValues.length, 1), 26, '#ffffff'));

    const logValues = [new Array(20).fill('')].concat((opts.changelog || [])
      .map(name => { const row = new Array(20).fill(''); row[1] = name; return row; }));
    const changelog = new FakeSheet('Deck Changelog', logValues,
      makeGrid(logValues.length, 20, '#ffffff'));

    const on = opts.on || 'Daily WOP';
    const sheets = { 'Daily WOP': wop, 'Deck List': deck,
      'Deck Changelog': changelog };
    const target = sheets[on] || wop;
    target.setSelection(opts.start || 1, opts.rows || 1);

    const ctx = vm.createContext({ console, Buffer, JSON, Math,
      Date: fixedDate('2026-08-22'), String, Number, Object, Array, RegExp,
      Error, isNaN, parseInt, parseFloat });
    const h = install(ctx, [deck, wop, changelog], on);
    const api = loadScript(ctx);
    if (opts.assessmentUrl) {
      vm.runInContext('CONFIG.PROGRESS.ASSESSMENT_URL = ' +
        JSON.stringify(opts.assessmentUrl) + ';', ctx);
    }
    return { api: api, harness: h,
      draft: () => {
        const last = h.dialogs[h.dialogs.length - 1];
        if (!last) return '';
        const box = last.html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/);
        return box ? box[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'") : '';
      },
      said: () => h.alerts.concat(h.dialogs.map(d => d.html)).join(' ') };
  }

  // Four topics waiting is a full upcoming list, in the order they meet them.
  let p = pr({ deck: [['Jane Doe', 'T1', '', '', 'T2, T3', 'T4, T5']],
    wop: ['10:30 AM Jane Doe'] });
  p.api.draftProgressReport();
  check('PR: the upcoming topics, in queue order',
    p.draft().split('Working on next:')[1].trim().split('\n')
      .map(l => l.trim()).join(','),
    '- T1,- T2,- T3,- T4');
  checkTruthy('PR: the name is the student, not the time on the row',
    p.draft().indexOf('Jane Doe') === 0);
  checkTruthy('PR: nothing was written to the Deck List',
    p.api.CONFIG.PROGRESS.TOPIC_COUNT === 4);

  // A task sitting in two columns at once is one topic, not two.
  p = pr({ deck: [['Jane Doe', 'T1', '', '', 'T1, T2', 'T3, T4']],
    wop: ['Jane Doe'] });
  p.api.draftProgressReport();
  check('PR: a topic in two columns is listed once',
    p.draft().split('Working on next:')[1].trim().split('\n')
      .map(l => l.trim()).join(','),
    '- T1,- T2,- T3,- T4');

  // Short of four, the draft says so in the text rather than looking finished.
  p = pr({ deck: [['Jane Doe', 'T1', '', '', 'T2', '']], wop: ['Jane Doe'] });
  p.api.draftProgressReport();
  const shortDraft = p.draft().split('Working on next:')[1];
  checkTruthy('PR: a short list is marked short in the draft itself',
    shortDraft.includes('2 more upcoming topic(s)'));
  checkTruthy('PR: and the note says how short', p.said().includes('2 short'));

  // The mastered half has no source yet, so the whole of it is marked.
  p = pr({ deck: [['Jane Doe', 'T1', '', '', 'T2, T3, T4', '']],
    wop: ['Jane Doe'] });
  p.api.draftProgressReport();
  checkTruthy('PR: the mastered half is marked missing, not left out',
    p.draft().split('Working on next:')[0].includes('4 more mastered topic(s)'));
  checkTruthy('PR: and the reason names what is needed',
    p.said().includes('ASSESSMENT_URL'));
  checkTruthy('PR: the deck history is not passed off as mastered topics',
    !p.draft().split('Working on next:')[0].includes('T1'));

  // A student with no deck row gets a draft with both halves marked.
  p = pr({ deck: [['John Roe', 'S1', '', '', '', '']], wop: ['Jane Doe'] });
  p.api.draftProgressReport();
  checkTruthy('PR: no deck row is said, not guessed at',
    p.said().includes('is not on the Deck List'));
  checkTruthy('PR: and the draft is still produced, fully marked',
    p.draft().includes('4 more upcoming topic(s)'));

  // One student on two hourly rows is one report.
  p = pr({ deck: [['Jane Doe', 'T1', '', '', 'T2, T3, T4', '']],
    wop: ['9:00 AM Jane Doe', '2:00 PM Jane Doe'], rows: 2 });
  p.api.draftProgressReport();
  check('PR: a student highlighted twice gets one draft',
    p.draft().split('Jane Doe').length - 1, 1);

  // Two students get two drafts, separated.
  p = pr({ deck: [['Jane Doe', 'T1', '', '', '', ''],
                  ['John Roe', 'S1', '', '', '', '']],
    wop: ['Jane Doe', 'John Roe'], rows: 2 });
  p.api.draftProgressReport();
  checkTruthy('PR: two students, two drafts',
    p.draft().includes('Jane Doe') && p.draft().includes('John Roe'));
  checkTruthy('PR: with something between them',
    p.draft().includes('------'));

  // The name is looked for wherever that sheet keeps it.
  p = pr({ on: 'Deck List', deck: [['Jane Doe', 'T1', '', '', 'T2', '']],
    start: 2 });
  p.api.draftProgressReport();
  checkTruthy('PR: run from the Deck List, the name is column A',
    p.draft().indexOf('Jane Doe') === 0);

  p = pr({ on: 'Deck Changelog', deck: [['Jane Doe', 'T1', '', '', 'T2', '']],
    changelog: ['Jane Doe'], start: 2 });
  p.api.draftProgressReport();
  checkTruthy('PR: run from the changelog, the name is column B',
    p.draft().indexOf('Jane Doe') === 0);

  // A sheet with no name column is refused with somewhere to go.
  const api0 = pr({}).api;
  check('PR: a sheet with no name column has no name column',
    api0.nameColumnFor_('Some Other Tab'), 0);

  p = pr({ wop: [''] });
  p.api.draftProgressReport();
  check('PR: an empty selection is refused, not drafted', p.said(),
    'The highlighted selection does not contain any rows with data.');

  // A row that exists but carries no name is refused by name, not drafted for
  // nobody. Guessing which student an unnamed row belongs to is exactly the
  // sort of help that puts the wrong child's topics in a parent's hands.
  p = pr({ deck: [['Jane Doe', 'T1', '', '', 'T2', '']],
    wop: [{ note: 'came in late' }] });
  p.api.draftProgressReport();
  checkTruthy('PR: a row with no name in it is refused',
    p.said().includes('No student name'));
  check('PR: and nothing was drafted', p.draft(), '');
}

// 45ac. Signing in: the instructions, and what comes back from the paste box.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  const h = install(ctx, [], null);
  const api = loadScript(ctx);

  // The instructions are in the dialog, because that is where somebody is
  // standing when they need them.
  api.setRadiusCookie();
  const dialog = h.dialogs[h.dialogs.length - 1];
  const shown = dialog.html;
  checkTruthy('cookie help: it is a dialog, not a one-line prompt',
    dialog.title === 'Radius: sign in');
  checkTruthy('cookie help: says which site to sign in to',
    shown.includes('radius.mathnasium.com'));
  checkTruthy('cookie help: names the key to press', shown.includes('F12'));
  checkTruthy('cookie help: names the Network tab', shown.includes('Network'));
  checkTruthy('cookie help: names the header to copy',
    shown.includes('Request Headers') && shown.includes('Cookie:'));
  checkTruthy('cookie help: warns off document.cookie',
    shown.includes('document.cookie') && shown.includes('HttpOnly'));
  checkTruthy('cookie help: covers Firefox too', shown.includes('Firefox'));
  checkTruthy('cookie help: says it expires and what that looks like',
    shown.includes('signs you out'));
  checkTruthy('cookie help: says where it is kept and not to spread it',
    shown.includes('not in the spreadsheet') && shown.includes('screenshot'));

  // A paste straight out of DevTools brings furniture with it.
  check('cookie tidy: a leading header name',
    api.normalizeCookieString_('Cookie: a=1; b=2'), 'a=1; b=2');
  check('cookie tidy: the quotes from "Copy value"',
    api.normalizeCookieString_('"a=1; b=2"'), 'a=1; b=2');
  check('cookie tidy: a paste that wrapped over lines',
    api.normalizeCookieString_('a=1;\n  b=2'), 'a=1; b=2');
  check('cookie tidy: nothing at all', api.normalizeCookieString_('   '), '');
  check('cookie tidy: a real one is left alone',
    api.normalizeCookieString_('.AspNet.ApplicationCookie=xyz'),
    '.AspNet.ApplicationCookie=xyz');

  // What is wrong with it, said in words.
  checkTruthy('cookie check: prose is not a cookie string',
    api.cookieComplaint_('I could not find it').includes('no "=" in it'));
  check('cookie check: a sign-in cookie passes quietly',
    api.cookieComplaint_('.AspNet.ApplicationCookie=xyz; __RequestVerificationToken=abc'),
    '');
  check('cookie check: the newer ASP.NET Core name passes too',
    api.cookieComplaint_('.AspNetCore.Identity.Application=xyz'), '');
  checkTruthy('cookie check: a document.cookie paste is named for what it is',
    api.cookieComplaint_('ai_user=1; _ga=GA1.2.3')
      .includes('document.cookie'));
  checkTruthy('cookie check: and says which way round to do it instead',
    api.cookieComplaint_('ai_user=1; _ga=GA1.2.3').includes('Network tab'));

  // Saving it.
  api.saveRadiusCookie_FromUI({ cookie: 'Cookie: .ASPXAUTH=abc; other=1' });
  check('cookie save: stored tidied up',
    vm.runInContext('PropertiesService.getScriptProperties()' +
      '.getProperty("RADIUS_COOKIE")', ctx),
    '.ASPXAUTH=abc; other=1');

  let refused = '';
  try { api.saveRadiusCookie_FromUI({ cookie: '   ' }); }
  catch (e) { refused = e.message; }
  checkTruthy('cookie save: an empty box is refused', refused.includes('Nothing was pasted'));
  check('cookie save: and the old one is left alone',
    vm.runInContext('PropertiesService.getScriptProperties()' +
      '.getProperty("RADIUS_COOKIE")', ctx),
    '.ASPXAUTH=abc; other=1');

  // A cookie with no recognisable sign-in name is still saved -- Radius may
  // rename it -- but the doubt is put in front of the person.
  api.saveRadiusCookie_FromUI({ cookie: 'mystery=1' });
  check('cookie save: an unrecognised one is still saved',
    vm.runInContext('PropertiesService.getScriptProperties()' +
      '.getProperty("RADIUS_COOKIE")', ctx),
    'mystery=1');
  checkTruthy('cookie save: with the doubt said out loud',
    h.alerts.join(' ').includes('document.cookie'));
  checkTruthy('cookie save: and always points at the next step',
    h.alerts.join(' ').includes('test connection'));
}

// 46. A logged-out response is the sign-in page with a 200, so the status
//     code alone cannot be trusted.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);

  checkTruthy('login detect: form action',
    api.looksLikeLoginPage_('<form action="/Account/Login" method="post">', 'x'));
  checkTruthy('login detect: password + username fields',
    api.looksLikeLoginPage_('<input name="username"><input name="password">', 'x'));
  checkTruthy('login detect: redirected URL',
    api.looksLikeLoginPage_('<html>anything</html>', 'https://radius.mathnasium.com/Account/Login'));
  checkTruthy('login detect: a real DWP page is not a login page',
    !api.looksLikeLoginPage_('<div class="dwp">Student work plan</div>',
      'https://radius.mathnasium.com/DWP/Index?studentId=1'));
}

// 47. Fetch failure modes all explain themselves.
{
  function fetchCase(body, code, cookie) {
    const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
      Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
    const h = install(ctx, [], null);
    const api = loadScript(ctx);
    if (cookie) ctx.PropertiesService.getScriptProperties().setProperty('RADIUS_COOKIE', cookie);
    h.fetchHandler.value = () => ({ code: code, body: body });
    try { api.radiusFetch_('https://radius.mathnasium.com/x'); return null; }
    catch (e) { return e.message; }
  }

  checkTruthy('fetch: no cookie stored says so',
    String(fetchCase('ok', 200, null)).includes('No Radius session cookie'));
  checkTruthy('fetch: 403 says the cookie was rejected',
    String(fetchCase('nope', 403, 'abc=1')).includes('rejected the session cookie'));
  checkTruthy('fetch: 500 reports the status',
    String(fetchCase('boom', 500, 'abc=1')).includes('HTTP 500'));
  checkTruthy('fetch: login page means expired',
    String(fetchCase('<input name="username"><input name="password">', 200, 'abc=1'))
      .includes('expired'));
  check('fetch: a good page returns cleanly', fetchCase('<div>real page</div>', 200, 'abc=1'), null);
}

// 48. Reading the Instruction Manager roster.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);

  const roster = api.parseRoster_(JSON.parse(rosterReply([
    { name: 'Jane Doe', studentId: 2942358, attendanceId: 86722299, dwpEntryId: 21711167 },
    { name: 'John Roe' },
    { name: 'Not Checkedin', attendanceId: null, dwpEntryId: null },
    { name: 'No Dwp Yet', dwpEntryId: null }
  ])));

  check('roster: counts usable links', [roster.withLink, roster.withoutLink], [2, 2]);
  check('roster: link built from the four ids',
    roster.byName['jane doe'].url,
    'https://radius.mathnasium.com/DWP/Index?studentId=2942358' +
    '&attendanceId=86722299&centerId=2514&dwpEntryId=21711167');
  check('roster: display name preserved', roster.byName['jane doe'].name, 'Jane Doe');

  // Two different reasons for having no link, told apart rather than merged.
  check('roster: never checked in has no url',
    roster.byName['not checkedin'].url, null);
  checkTruthy('roster: never checked in is marked as such',
    !roster.byName['not checkedin'].checkedIn);
  check('roster: checked in without a DWP has no url',
    roster.byName['no dwp yet'].url, null);
  checkTruthy('roster: checked in without a DWP is still checked in',
    roster.byName['no dwp yet'].checkedIn);

  // A reply that is not a success is a failure to say out loud.
  let err = '';
  try { api.parseRoster_({ Status: 'Error', Message: 'no centre' }); }
  catch (e) { err = e.message; }
  checkTruthy('roster: a failed reply explains itself', err.includes('no centre'));

  err = '';
  try { api.parseRoster_(null); } catch (e) { err = e.message; }
  checkTruthy('roster: an empty reply explains itself', err.includes('CENTER_ID'));

  // An empty roster is a real answer, not an error.
  const none = api.parseRoster_({ Status: 'Success', DataSource: [] });
  check('roster: nobody checked in is not an error',
    [none.withLink, none.withoutLink], [0, 0]);
}

// 48b. Two students sharing a name cannot be told apart, so neither is used.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);

  const roster = api.parseRoster_(JSON.parse(rosterReply([
    { name: 'Jane Doe', studentId: 1 },
    { name: 'jane  doe', studentId: 2 }
  ])));

  checkTruthy('duplicate: flagged', roster.byName['jane doe'].ambiguous);

  let err = '';
  try { api.lookupRosterEntry_(roster, 'Jane Doe'); } catch (e) { err = e.message; }
  checkTruthy('duplicate: refused rather than guessed',
    err.includes('more than one student'));
}

// 48c. The roster request itself: a signed-in POST carrying the centre.
{
  const TOKEN_PAGE = '<html><body><form action="/Account/LogOff" method="post">' +
    '<input name="__RequestVerificationToken" type="hidden" value="tok-123" />' +
    '</form></body></html>';

  function rosterCase(body, code, tokenPage) {
    const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
      Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
    const h = install(ctx, [], null);
    const api = loadScript(ctx);
    h.scriptProps.RADIUS_COOKIE = 'session=abc';
    h.fetchHandler.value = url => url.indexOf('GetStudentDataSource') === -1
      ? { code: 200, body: tokenPage === undefined ? TOKEN_PAGE : tokenPage }
      : { code: code === undefined ? 200 : code, body: body };
    let err = '';
    try { api.loadRoster_(); } catch (e) { err = e.message; }
    const posts = h.fetchLog.filter(c => c.params.method === 'post');
    return { call: posts[0], gets: h.fetchLog.filter(c => c.params.method === 'get'),
             err: err, api: api, ctx: ctx, harness: h };
  }

  const ok = rosterCase(rosterReply(['Jane Doe']));
  check('roster call: no error', ok.err, '');
  check('roster call: hits the data source', ok.call.url,
    'https://radius.mathnasium.com/AnswerKey/GetStudentDataSource');
  check('roster call: posted', ok.call.params.method, 'post');
  check('roster call: sends the centre',
    JSON.parse(ok.call.params.payload).centers, '2514');
  check('roster call: sends the session cookie',
    ok.call.params.headers.Cookie, 'session=abc');
  checkTruthy('roster call: asks for JSON',
    /json/i.test(String(ok.call.params.contentType)));

  // Radius reaches this endpoint through jQuery. ASP.NET MVC decides whether a
  // request is an AJAX call by looking for these, so a request without them is
  // not the same request the server is written for.
  check('roster call: identifies itself as an AJAX call',
    ok.call.params.headers['X-Requested-With'], 'XMLHttpRequest');
  checkTruthy('roster call: accepts JSON back',
    /application\/json/.test(String(ok.call.params.headers.Accept)));

  // ASP.NET's own error page names the fault, and that is worth quoting.
  const boom = rosterCase(
    '<html><head><title>Error</title></head><body>' +
    "<h1>Server Error in '/' Application.</h1>" +
    '<h2><i>Object reference not set to an instance of an object.</i></h2>' +
    '<script>ignore me</script></body></html>', 500);
  checkTruthy('roster call: a 500 still names the status',
    boom.err.includes('HTTP 500'));
  checkTruthy('roster call: a 500 quotes the exception',
    boom.err.includes('Object reference not set'));
  checkTruthy('roster call: markup is stripped out of the quote',
    !boom.err.includes('<h2>') && !boom.err.includes('ignore me'));

  // A custom error page arrives wearing the normal site layout, which opens
  // with hidden modals about billing dates that sit on every Radius page.
  // Quoting those reads as a real complaint about billing and sends the
  // reader somewhere that has nothing to do with the failure.
  const dressed = rosterCase(
    '<!DOCTYPE html><html><head><title>Instruction Manager</title></head><body>' +
    '<div id="undoDeferBillingDayModal" class="hiddenPartial"><p>This will ' +
    'change the upcoming payment\u2019s charge date back to the original ' +
    'billing date (<span id="originalBillingDay"></span>). Proceed?</p></div>' +
    '</body></html>', 500);
  checkTruthy('dressed 500: names the status', dressed.err.includes('HTTP 500'));
  checkTruthy('dressed 500: does not quote the billing boilerplate',
    !dressed.err.includes('charge date'));
  checkTruthy('dressed 500: says a page came back instead of data',
    dressed.err.includes('web page') && dressed.err.includes('Instruction Manager'));

  // Nothing to quote is not a reason to fail differently.
  checkTruthy('roster call: an empty error body still reports the status',
    rosterCase('', 503).err.includes('HTTP 503'));

  // ASP.NET rejects its antiforgery cookie arriving without the token that is
  // rendered into the page, and does it as a 500 rather than a 403.
  check('token: read from the page and sent with the POST',
    ok.call.params.headers.__RequestVerificationToken, 'tok-123');
  check('token: fetched from a page, once',
    ok.gets.map(c => c.url), ['https://radius.mathnasium.com/AnswerKey/AnswerkeyCheckin']);

  // A page with no token in it may simply mean none is needed. Going ahead
  // without one lets the request answer that; refusing here would not.
  const noToken = rosterCase(rosterReply(['Jane Doe']), 200, '<html><body>hi</body></html>');
  check('token: absent means the header is left off', noToken.err, '');
  checkTruthy('token: absent does not stop the request',
    noToken.call.params.headers.__RequestVerificationToken === undefined);

  // An expired session can land on a page that is not the login form. That is
  // not JSON either, and guessing at it would be worse than saying so.
  checkTruthy('roster call: an HTML reply is reported, not parsed',
    rosterCase('<html><body>Session timed out</body></html>').err.includes('cookie'));
  checkTruthy('roster call: the sign-in page is still caught',
    rosterCase('<form action="/Account/Login"></form>').err.includes('expired'));
  checkTruthy('roster call: a rejected cookie is reported',
    rosterCase('{}', 403).err.includes('rejected'));

  // Without a centre there is nothing to ask for, and no request is made.
  const noCentre = (() => {
    const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
      Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
    const h = install(ctx, [], null);
    const api = loadScript(ctx);
    h.scriptProps.RADIUS_COOKIE = 'session=abc';
    vm.runInContext('CONFIG.RADIUS.CENTER_ID = "";', ctx);
    let err = '';
    try { api.loadRoster_(); } catch (e) { err = e.message; }
    return { err: err, calls: h.fetchLog.length };
  })();
  checkTruthy('roster call: no centre says what to set',
    noCentre.err.includes('CENTER_ID'));
  check('roster call: no centre asks Radius for nothing', noCentre.calls, 0);
}

// 48d. The import must not reach into another feature's file.
//
//      Every .gs file shares one global scope, and this suite loads all of
//      them, so a call across files looks fine here and fails in a project
//      that does not happen to have that file. Radius.gs may use its own
//      helpers and the shared ones, nothing else.
{
  const names = src => (src.match(/^function\s+([A-Za-z0-9_$]+)/gm) || [])
    .map(m => m.replace(/^function\s+/, ''));

  const shared = names(fs.readFileSync('Common.gs', 'utf8'))
    .concat(names(fs.readFileSync('Radius.gs', 'utf8')));

  const radiusSrc = fs.readFileSync('Radius.gs', 'utf8');
  const strays = [];

  ['Setup.gs', 'Sod.gs', 'Eod.gs', 'Menu.gs', 'Seating.gs', 'Changelog.gs'].forEach(function (file) {
    names(fs.readFileSync(file, 'utf8')).forEach(function (name) {
      if (shared.indexOf(name) !== -1) return;
      if (new RegExp('\\b' + name + '\\s*\\(').test(radiusSrc)) {
        strays.push(file + ':' + name);
      }
    });
  });

  check('import calls nothing from another feature file', strays, []);

  // The helper that caught this: it was defined in a feature file, not here.
  checkTruthy('columnLetter_ is shared, not tucked into a feature file',
    names(fs.readFileSync('Common.gs', 'utf8')).indexOf('columnLetter_') !== -1);
}

// 49. Name matching is forgiving about case, spacing and "Last, First".
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);

  check('name: plain', api.normalizeStudentName_('Jane Doe'), 'jane doe');
  check('name: case and padding', api.normalizeStudentName_('  JANE   DOE '), 'jane doe');
  check('name: last-comma-first flipped', api.normalizeStudentName_('Doe, Jane'), 'jane doe');
  check('name: a comma that is not a name flip is left alone',
    api.normalizeStudentName_('Smith, Jane, Jr'), 'smith, jane, jr');

  check('cell text: tags and entities stripped',
    api.htmlCellText_('<td><b>Jane</b>&nbsp;&amp;&nbsp;<i>Doe</i></td>'), 'Jane & Doe');
}

// 50. Roster lookup failures each say something different.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  const roster = api.parseRoster_(JSON.parse(rosterReply([
    { name: 'Jane Doe', studentId: 7, attendanceId: 8, dwpEntryId: 9 },
    { name: 'No Dwp', dwpEntryId: null },
    { name: 'Not In Yet', attendanceId: null, dwpEntryId: null }
  ])));

  check('lookup: found', api.lookupRosterEntry_(roster, 'JANE DOE').url,
    'https://radius.mathnasium.com/DWP/Index?studentId=7&attendanceId=8' +
    '&centerId=2514&dwpEntryId=9');

  let err = '';
  try { api.lookupRosterEntry_(roster, 'Ghost Student'); } catch (e) { err = e.message; }
  checkTruthy('lookup: absent points at check-in or the spelling',
    err.includes('checked in') && err.includes('spelled'));

  err = '';
  try { api.lookupRosterEntry_(roster, 'Not In Yet'); } catch (e) { err = e.message; }
  checkTruthy('lookup: not checked in says so', err.includes('has not checked in'));

  err = '';
  try { api.lookupRosterEntry_(roster, 'No Dwp'); } catch (e) { err = e.message; }
  checkTruthy('lookup: no DWP yet says so', err.includes('no DWP 2.0 yet'));
}

// 51. Extracting from a real DWP page. This one is a live session with
//     nothing filled in, so every field should come back empty rather than
//     throwing -- empty is a real answer here, a missing element is not.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  const LIVE = dwp('live');
  const get = key => api.RADIUS_EXTRACTORS[key](LIVE);

  check('live page: student name read from title', api.pageStudentName_(LIVE), 'Amalie Laz');

  check('live: pages completed is blank, not missing', get('pagesCompleted'), '');
  check('live: deck update switch untouched', get('deckNeedsUpdate'), '');
  check('live: not signed out is blank, not "No"', get('signedOut'), '');
  check('live: not finalized', get('finalized'), 'No');
  check('live: no topics ticked yet', get('topicsWorkedOn'), '');
  check('live: problem of the week untouched', get('problemOfTheWeek'), '');
  check('live: session summary empty', get('sessionSummary'), '');
  check('live: internal notes empty', get('internalNotes'), '');

  // The assignment table is found even though nothing is ticked.
  check('live: assignment rows located', api.dwpAssignmentRows_(LIVE).length, 3);

  // Values that ARE present on this page prove the fields are server-rendered.
  check('live: session length is in the markup',
    api.inputValueById_(LIVE, 'SessionLength'), '60');
  check('live: start time is in the markup',
    api.inputValueById_(LIVE, 'SessionStartTime'), '9:59 AM');

  // A missing element must throw rather than quietly return empty.
  let err = '';
  try { api.RADIUS_EXTRACTORS.pagesCompleted('<html><body>nothing</body></html>'); }
  catch (e) { err = e.message; }
  checkTruthy('missing field throws rather than writing blank',
    err.includes('Pages Completed'));
}

// 52. The same page after an instructor filled it in and finalized it.
//     This is the real thing, not a constructed guess -- it confirms both
//     readings that were previously inferred.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  const FILLED = dwp('filled');
  const get = key => api.RADIUS_EXTRACTORS[key](FILLED);

  check('filled: pages completed', get('pagesCompleted'), '12');
  check('filled: signed out reports the time', get('signedOut'), '11:42 AM');
  check('filled: signed in reports the time', get('signedIn'), '9:59 AM');
  check('filled: finalized', get('finalized'), 'Yes');
  check('filled: deck update answered No', get('deckNeedsUpdate'), 'No');
  check('filled: problem of the week answered No', get('problemOfTheWeek'), 'No');
  check('filled: only ticked topics are listed', get('topicsWorkedOn'),
    'Simplifying Expressions - Pythagorean Identities; ' +
    'Completing Right Triangles; The Unit Circle - Angles as Rotations');
  check('filled: notes left untouched stay empty', get('sessionSummary'), '');
  check('filled: internal notes left untouched stay empty', get('internalNotes'), '');

  // CONFIRMED: the switch value really is the third loadButtons argument, and
  // an answered-No switch renders 0.
  check('switch value is the third loadButtons argument',
    api.tripleSwitchRaw_(FILLED, 'Deck1NeedsUpdate'), '0');
  // A switch left alone on the same page still reads as untouched, so a
  // filled page does not make every switch look answered.
  check('an untouched switch on a filled page still reads empty',
    api.tripleSwitchRaw_(FILLED, 'SchoolworkWorkedOn'), '');
  check('untouched switch yields blank, not No',
    api.tripleSwitchLabel_(api.tripleSwitchRaw_(FILLED, 'SchoolworkWorkedOn')), '');

  // CONFIRMED: a ticked box renders checked="checked", and it sits BEFORE the
  // class attribute -- which is why tag matching cannot rely on position.
  checkTruthy('ticked checkbox found even though checked precedes class',
    api.assignmentCheckboxChecked_(
      api.dwpAssignmentRows_(FILLED)[0], '_WO_checkbox'));
  checkTruthy('unticked box on a row with other ticks is not a false positive',
    !api.assignmentCheckboxChecked_(
      api.dwpAssignmentRows_(FILLED)[0], '_CBNM_checkbox'));
  checkTruthy('a row with nothing ticked stays untouched',
    !api.assignmentCheckboxChecked_(
      api.dwpAssignmentRows_(FILLED)[3], '_WO_checkbox'));

  // The mastery columns are distinct from "worked on" and from each other.
  check('completed & mastered', get('completedMastered'),
    'Simplifying Expressions - Pythagorean Identities');
  check('completed but not mastered', get('completedNotMastered'),
    'The Unit Circle - Angles as Rotations');

  // Spellings the server might use for Yes, which has not been seen yet.
  check('switch: 1', api.tripleSwitchLabel_('1'), 'Yes');
  check('switch: true', api.tripleSwitchLabel_('true'), 'Yes');
  check('switch: True', api.tripleSwitchLabel_('True'), 'Yes');
  check('switch: 0', api.tripleSwitchLabel_('0'), 'No');
  check('switch: False', api.tripleSwitchLabel_('False'), 'No');
  check('switch: null literal', api.tripleSwitchLabel_('null'), '');
  check('switch: anything unrecognised passes through rather than guessing',
    api.tripleSwitchLabel_('maybe'), 'maybe');

  checkTruthy('checkbox: bare checked attribute counts',
    api.assignmentCheckboxChecked_('<input id="1_WO_checkbox x" checked />', '_WO_checkbox'));
  checkTruthy('checkbox: name="woChecked" alone is not a tick',
    !api.assignmentCheckboxChecked_('<input id="1_WO_checkbox x" name="woChecked" />',
      '_WO_checkbox'));
}


// 52b. Mastery scores: completed rows only, as PK code plus a percentage.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  const score = file =>
    api.RADIUS_EXTRACTORS.masteryScores(fs.readFileSync('tests/fixtures/' + file, 'utf8'));

  // On the completed page one row was worked on but never finished, so it is
  // absent from the list even though all seven were worked on.
  check('mastery: completed page, worked-on-only row omitted',
    score('dwp-complete.html'),
    'PK3918(100), PK3902(0), PK3901(0), PK3900(100), PK3910(100), PK3916(0)');
  check('mastery: order follows the learning plan, not mastered-first',
    score('dwp-complete.html').split(', ')[0], 'PK3918(100)');

  check('mastery: partly filled page', score('dwp-filled.html'),
    'PK3909(100), PK3902(0)');
  check('mastery: nothing completed yet', score('dwp-live.html'), '');

  // The page shows PK-3918-00; the sheet wants PK3918.
  check('pk code: revision segment dropped', api.formatPkCode_('PK-3918-00'), 'PK3918');
  check('pk code: another', api.formatPkCode_('PK-3902-00'), 'PK3902');
  check('pk code: padded whitespace', api.formatPkCode_('  PK-3901-00 '), 'PK3901');
  check('pk code: lowercase prefix is normalised', api.formatPkCode_('pk-3901-00'), 'PK3901');
  check('pk code: a different prefix still works', api.formatPkCode_('WOB-77-01'), 'WOB77');
  check('pk code: unrecognised shape is stripped, not dropped',
    api.formatPkCode_('odd ball!'), 'oddball');

  // Both boxes ticked should not happen -- the page disables one when the
  // other is set -- but mastered wins if it ever does.
  const bothTicked =
    '<tbody id="dwpPKsBody"><tr>' +
    '<td><div></div></td><td><div>PK-1234-00</div></td><td><div>Topic</div></td>' +
    '<td><input id="1_WO_checkbox x" checked /></td>' +
    '<td><input id="1_CM_checkbox x" checked /></td>' +
    '<td><input id="1_CBNM_checkbox x" checked /></td>' +
    '</tr></tbody>';
  check('mastery: mastered wins if both are somehow ticked',
    api.RADIUS_EXTRACTORS.masteryScores(bothTicked), 'PK1234(100)');

  // A completed row with no PK code falls back to the topic name rather than
  // emitting a bare "(100)".
  const noCode =
    '<tbody id="dwpPKsBody"><tr>' +
    '<td><div></div></td><td><div></div></td><td><div>Unnamed Topic</div></td>' +
    '<td><input id="2_WO_checkbox x" checked /></td>' +
    '<td><input id="2_CM_checkbox x" checked /></td>' +
    '<td><input id="2_CBNM_checkbox x" /></td>' +
    '</tr></tbody>';
  check('mastery: falls back to the topic name when the PK cell is blank',
    api.RADIUS_EXTRACTORS.masteryScores(noCode), 'Unnamed Topic(100)');
}

// 52c. The Daily WOP column layout, and the values that land in each.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  const DONE = dwp('complete');
  const LIVE = dwp('live');
  const get = (key, html) => api.RADIUS_EXTRACTORS[key](html || DONE);

  // Boolean-ish answers write a bare Y, matching how column K is filled in by
  // hand. A No writes nothing at all rather than the word "No".
  check('flag: problem of the week done', get('problemOfTheWeekFlag'), 'Y');
  check('flag: finalized', get('finalizedFlag'), 'Y');
  // Y: EOD reads this as "advance the student's task".
  check('flag: deck needs update writes Y', get('deckNeedsUpdateFlag'), 'Y');
  check('flag: an answered-No is blank, not "No"',
    api.RADIUS_EXTRACTORS.deckNeedsUpdateFlag(
      dwp('filled')), '');
  check('flag: an untouched switch is blank',
    get('problemOfTheWeekFlag', LIVE), '');
  check('yesFlag: only "yes" counts', [
    api.yesFlag_('Yes'), api.yesFlag_('yes'), api.yesFlag_('No'),
    api.yesFlag_(''), api.yesFlag_('maybe')
  ], ['Y', 'Y', '', '', '']);

  // Times are plain times, blank until they happen -- not the word "No".
  check('time: signed in', get('signedIn'), '10:48 AM');
  check('time: signed out', get('signedOut'), '11:48 AM');
  check('time: signed in on a live session', get('signedIn', LIVE), '9:59 AM');
  check('time: not signed out yet is blank', get('signedOut', LIVE), '');

  // Column G folds the assessment status onto the end of the mastery list.
  check('column G: mastery plus assessment, one comma-separated list',
    get('masteryAndAssessment'),
    'PK3918(100), PK3902(0), PK3901(0), PK3900(100), PK3910(100), PK3916(0), ' +
    'Pre completed');
  check('column G: empty when nothing is finished',
    get('masteryAndAssessment', LIVE), '');
  check('column G: mastery alone when no assessment was given',
    api.RADIUS_EXTRACTORS.masteryAndAssessment(
      dwp('filled')),
    'PK3909(100), PK3902(0)');

  // The layout itself, so a stray edit to Config.gs shows up here.
  const layout = {};
  api.CONFIG.RADIUS.FIELDS.forEach(f => { layout[api.columnLetter_(f.column)] = f.key; });
  check('column layout', layout, {
    F: 'problemOfTheWeekFlag',
    G: 'masteryAndAssessment',
    H: 'pagesCompleted',
    J: 'finalizedFlag',
    K: 'deckNeedsUpdateFlag',
    L: 'signedIn',
    M: 'signedOut',
    O: 'sessionSummary',
    P: 'internalNotes'
  });

  // Column K is shared with EOD, so it must be a merge field -- never a
  // plain overwrite -- and nothing may ever target the name column.
  const statusField = api.CONFIG.RADIUS.FIELDS
    .filter(f => f.column === api.CONFIG.WOP_COL.STATUS)[0];
  check('the EOD status column is written by merge, not overwrite',
    statusField && statusField.merge, 'statusLetters');
  checkTruthy('every other field is a plain write',
    api.CONFIG.RADIUS.FIELDS.filter(f => f.merge).length === 1);
  checkTruthy('nothing targets the name column',
    api.CONFIG.RADIUS.FIELDS.every(f => f.column !== api.CONFIG.WOP_COL.NAME));

  // Every field key the timing review names must actually exist. A typo here
  // does not throw -- the review just sees no times and quietly does nothing.
  const fieldKeys = api.CONFIG.RADIUS.FIELDS.map(f => f.key);
  const timingKeys = [api.CONFIG.RADIUS.TIMING.SIGN_IN_FIELD,
    api.CONFIG.RADIUS.TIMING.SIGN_OUT_FIELD, api.CONFIG.RADIUS.TIMING.NOTE_FIELD]
    .concat(api.CONFIG.RADIUS.TIMING.SHADE_FIELDS);
  check('every timing field key resolves to a real field',
    timingKeys.filter(k => fieldKeys.indexOf(k) === -1), []);
}

// 52d. Column K is shared with the EOD script, so the deck-update P is folded
//      into whatever is already there rather than replacing it.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  const merge = (cur, add) => api.mergeStatusLetters_(cur, add);

  check('merge: into an empty cell', merge('', 'P').value, 'P');
  check('merge: onto a hand-typed Y', merge('Y', 'P').value, 'YP');
  check('merge: onto a multi-Y instruction', merge('YY', 'P').value, 'YYP');
  check('merge: already has a P, left alone', merge('YP', 'P').value, 'YP');
  checkTruthy('merge: already has a P, not rewritten', !merge('YP', 'P').changed);
  check('merge: nothing to add leaves the cell', merge('Y', '').value, 'Y');
  checkTruthy('merge: nothing to add is not a write', !merge('Y', '').changed);

  // EOD's markers record outstanding work; flattening one loses it.
  checkTruthy('merge: refuses a B-empty marker',
    merge('YYP - B empty?', 'P').blocked);
  check('merge: B-empty marker is unchanged',
    merge('YYP - B empty?', 'P').value, 'YYP - B empty?');
  checkTruthy('merge: refuses a ran-out marker',
    merge('Y (2 of 3 done, ran out)', 'P').blocked);
}

// 52e. The import writing into column K for real.
{
  function runImport(existingStatus, statusBg) {
    const s = scenario([HEADER, ...DECK_FILLER_ROWS,
      ['Amalie Laz', '', '', '', '', '', '', '', '', '', '', '', '', '']],
      [{ name: 'Amalie Laz', status: existingStatus, statusBg: statusBg }],
      { start: 1, rows: 1 }, '2026-08-22');
    s.harness.scriptProps.RADIUS_COOKIE = 'session=abc';
    vm.runInContext(
      'CONFIG.RADIUS.ROSTER_URL = "https://radius.mathnasium.com/IM"; CONFIG.RADIUS.TOKEN_PAGE_URL = "";',
      s.context);
    const DONE = dwp('complete');
    s.harness.fetchHandler.value = url => ({ code: 200, body:
      url.indexOf('/IM') !== -1
        ? rosterReply(['Amalie Laz'])
        : DONE });
    confirmRadiusImport(s);
    return s;
  }

  let s = runImport('');
  check('import into K: empty cell gets the Y', s.wopStatus(0), 'Y');
  check('import into K: other columns still land', String(s.wop.values[0][7]), '33');

  s = runImport('P');
  check('import into K: a typed P becomes PY', s.wopStatus(0), 'PY');

  s = runImport('Y');
  check('import into K: an existing Y is not doubled', s.wopStatus(0), 'Y');

  s = runImport('YP');
  check('import into K: a cell already carrying Y is untouched',
    s.wopStatus(0), 'YP');

  // A row EOD has already finished is left exactly as it stands.
  s = runImport('YYP', '#00FF00');
  check('import into K: a green row keeps its text', s.wopStatus(0), 'YYP');
  // Untouched means untouched: the original casing survives too.
  check('import into K: a green row keeps its colour', s.wopStatusBg(0), '#00FF00');
  checkTruthy('import into K: and says why it was skipped',
    lastDialog(s).html.includes('already green'));
  check('import into K: the rest of the row still imports',
    String(s.wop.values[0][7]), '33');

  // An EOD marker is reported rather than flattened.
  s = runImport('YYP - B empty?', '#ffff00');
  check('import into K: marker text survives', s.wopStatus(0), 'YYP - B empty?');
  checkTruthy('import into K: marker is explained',
    lastDialog(s).html.includes('EOD marker'));
}

// 52f. Reading a clock time.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  const t = api.parseClockTime_;

  check('clock: morning', t('10:48 AM'), 648);
  check('clock: afternoon', t('1:05 PM'), 785);
  check('clock: noon stays noon', t('12:30 PM'), 750);
  check('clock: midnight wraps to zero', t('12:30 AM'), 30);
  check('clock: lowercase meridiem', t('9:59 am'), 599);
  check('clock: dotted meridiem', t('9:59 a.m.'), 599);
  check('clock: 24-hour with no meridiem', t('14:05'), 845);
  check('clock: padded', t('  10:48 AM  '), 648);
  check('clock: blank', t(''), null);
  check('clock: not a time', t('No'), null);
  check('clock: impossible minutes', t('10:75 AM'), null);
}

// 52g. Judging how long the session ran.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  const r = (a, b) => api.reviewSessionTiming_(a, b);

  // A normal hour, and the edges of the band.
  check('timing: a real 60 minute session is fine',
    [r('10:48 AM', '11:48 AM').shade, r('10:48 AM', '11:48 AM').notes], [false, []]);
  check('timing: 53 minutes is the bottom of the band',
    r('10:00 AM', '10:53 AM').shade, false);
  check('timing: 52 minutes is not', r('10:00 AM', '10:52 AM').shade, true);
  check('timing: 67 minutes is the top of the band',
    r('10:00 AM', '11:07 AM').shade, false);
  check('timing: 68 minutes is not', r('10:00 AM', '11:08 AM').shade, true);

  // Doubles are fine, and say so.
  check('timing: 106 minutes is the bottom of the double band',
    [r('10:00 AM', '11:46 AM').shade, r('10:00 AM', '11:46 AM').notes],
    [false, ['2 hour session']]);
  check('timing: 134 minutes is the top',
    [r('10:00 AM', '12:14 PM').shade, r('10:00 AM', '12:14 PM').notes],
    [false, ['2 hour session']]);
  check('timing: 105 minutes falls in the gap and is shaded',
    [r('10:00 AM', '11:45 AM').shade, r('10:00 AM', '11:45 AM').notes], [true, []]);
  check('timing: 135 minutes is over and is shaded',
    [r('10:00 AM', '12:15 PM').shade, r('10:00 AM', '12:15 PM').notes], [true, []]);
  check('timing: 80 minutes sits between the bands, shaded, no note',
    [r('10:00 AM', '11:20 AM').shade, r('10:00 AM', '11:20 AM').notes], [true, []]);

  // Short sessions get looked at more closely.
  check('timing: late in', r('10:12 AM', '10:40 AM').notes,
    ['signed in 12 minutes late', 'left 20 minutes early']);
  check('timing: late in only', r('10:12 AM', '10:55 AM').notes,
    ['signed in 12 minutes late']);
  check('timing: early out only', r('10:00 AM', '10:45 AM').notes,
    ['left 15 minutes early']);

  // A late arrival who stays past the top of the hour has not left early: the
  // slot ends on the hour it began in, not on the one after the sign-out.
  check('timing: late in, out just past the hour, not early at all',
    r('5:20 PM', '6:01 PM').notes, ['signed in 20 minutes late']);
  check('timing: late in, out exactly on the hour, still not early',
    r('5:20 PM', '6:00 PM').notes, ['signed in 20 minutes late']);
  check('timing: late in and genuinely early out counts from the hour',
    r('5:20 PM', '5:45 PM').notes,
    ['signed in 20 minutes late', 'left 15 minutes early']);
  check('timing: leaving well past the hour is never early',
    r('5:30 PM', '6:10 PM').notes, ['signed in 30 minutes late']);
  check('timing: exactly 10 minutes late counts',
    r('10:10 AM', '10:50 AM').notes,
    ['signed in 10 minutes late', 'left 10 minutes early']);
  check('timing: 9 minutes either side is not worth a note',
    r('10:09 AM', '10:51 AM').notes, []);

  // A short session can still be shaded with nothing to explain it.
  check('timing: short but punctual is shaded without a note',
    [r('10:00 AM', '10:52 AM').shade, r('10:00 AM', '10:52 AM').notes], [true, []]);

  // Signing out on the hour is not leaving early -- the lateness note still
  // fires, but nothing claims they left 60 minutes early.
  checkTruthy('timing: out exactly on the hour earns no early note',
    r('10:40 AM', '11:00 AM').notes.every(n => n.indexOf('early') === -1));
  check('timing: and the late note still fires',
    r('10:40 AM', '11:00 AM').notes, ['signed in 40 minutes late']);

  // Long sessions are never examined for lateness -- the rule is short only.
  check('timing: a long session gets no late note',
    r('10:48 AM', '12:30 PM').notes, []);

  // A student still in the centre is not late for anything.
  check('timing: no sign-out yet',
    [r('10:30 AM', '').known, r('10:30 AM', '').shade, r('10:30 AM', '').notes],
    [false, false, []]);
  check('timing: no sign-in either', r('', '').known, false);

  check('timing: a session crossing noon',
    r('11:30 AM', '12:30 PM').durationMinutes, 60);
}

// 52h. The timing review reaching the sheet: shading on L and M, notes on P.
{
  function runTiming(signInHtmlTime, signOutHtmlTime) {
    const s = scenario([HEADER, ...DECK_FILLER_ROWS,
      ['Amalie Laz', '', '', '', '', '', '', '', '', '', '', '', '', '']],
      [{ name: 'Amalie Laz' }], { start: 1, rows: 1 }, '2026-08-22');
    s.harness.scriptProps.RADIUS_COOKIE = 'session=abc';
    vm.runInContext(
      'CONFIG.RADIUS.ROSTER_URL = "https://radius.mathnasium.com/IM"; CONFIG.RADIUS.TOKEN_PAGE_URL = "";',
      s.context);

    const page = dwp('complete')
      .replace(/id="SessionStartTime" name="SessionStartTime" type="text" value="[^"]*"/,
               'id="SessionStartTime" name="SessionStartTime" type="text" value="' +
               signInHtmlTime + '"')
      .replace(/id="SessionEndTime" name="SessionEndTime" type="text" value="[^"]*"/,
               'id="SessionEndTime" name="SessionEndTime" type="text" value="' +
               signOutHtmlTime + '"');

    s.harness.fetchHandler.value = url => ({ code: 200, body:
      url.indexOf('/IM') !== -1
        ? rosterReply(['Amalie Laz'])
        : page });
    confirmRadiusImport(s);
    return {
      L: String(s.wop.values[0][11]), Lbg: String(s.wop.backgrounds[0][11]),
      M: String(s.wop.values[0][12]), Mbg: String(s.wop.backgrounds[0][12]),
      P: String(s.wop.values[0][15]),
      html: lastDialog(s).html
    };
  }

  // A normal hour: times written, nothing shaded, the note left as Radius had it.
  let out = runTiming('10:48 AM', '11:48 AM');
  check('sheet: normal session writes both times', [out.L, out.M],
    ['10:48 AM', '11:48 AM']);
  check('sheet: normal session is not shaded', [out.Lbg, out.Mbg],
    ['#ffffff', '#ffffff']);
  check('sheet: normal session appends only the Mathlete score', out.P,
    'ALB: she doesnt shut up big L | MLS (3)');

  // A short, late, early session: shaded and annotated.
  out = runTiming('10:12 AM', '10:40 AM');
  check('sheet: odd length shades sign-in and sign-out',
    [out.Lbg, out.Mbg], ['#ff9900', '#ff9900']);
  check('sheet: notes append in order, score last', out.P,
    'ALB: she doesnt shut up big L | signed in 12 minutes late | ' +
    'left 20 minutes early | MLS (3)');
  checkTruthy('sheet: the report explains the shading',
    out.html.includes('neither about an hour nor about two'));

  // A double: not shaded, but noted.
  out = runTiming('10:00 AM', '11:50 AM');
  check('sheet: a double is not shaded', [out.Lbg, out.Mbg], ['#ffffff', '#ffffff']);
  check('sheet: a double is noted', out.P,
    'ALB: she doesnt shut up big L | 2 hour session | MLS (3)');

  // Odd length with nothing to explain it: shaded, note untouched.
  out = runTiming('10:00 AM', '11:20 AM');
  check('sheet: 80 minutes shades without a timing note',
    [out.Lbg, out.Mbg, out.P],
    ['#ff9900', '#ff9900', 'ALB: she doesnt shut up big L | MLS (3)']);

  // Still in the centre: no sign-out, so nothing is judged.
  out = runTiming('10:30 AM', '');
  check('sheet: no sign-out means no shading and no timing note',
    [out.M, out.Lbg, out.Mbg, out.P],
    ['', '#ffffff', '#ffffff', 'ALB: she doesnt shut up big L | MLS (3)']);
}

// 52h2. The two free-text columns are stamped, column J records a session
//       that finished without being finalised, and neither touches anything
//       else on the row.
{
  function runCase(signIn, signOut, finalizedDate) {
    const s = scenario([HEADER, ...DECK_FILLER_ROWS,
      ['Amalie Laz', '', '', '', '', '', '', '', '', '', '', '', '']],
      [{ name: 'Amalie Laz' }], { start: 1, rows: 1 }, '2026-08-22');
    s.harness.scriptProps.RADIUS_COOKIE = 'session=abc';
    vm.runInContext(
      'CONFIG.RADIUS.ROSTER_URL = "https://radius.mathnasium.com/IM"; ' +
      'CONFIG.RADIUS.TOKEN_PAGE_URL = "";', s.context);

    const page = dwp('complete')
      .replace(/id="SessionStartTime" name="SessionStartTime" type="text" value="[^"]*"/,
               'id="SessionStartTime" name="SessionStartTime" type="text" value="' +
               signIn + '"')
      .replace(/id="SessionEndTime" name="SessionEndTime" type="text" value="[^"]*"/,
               'id="SessionEndTime" name="SessionEndTime" type="text" value="' +
               signOut + '"')
      .replace(/finalizedDate\s*=\s*'[^']*'/, "finalizedDate = '" + finalizedDate + "'");

    s.harness.fetchHandler.value = url => ({ code: 200, body:
      url.indexOf('/IM') !== -1 ? rosterReply(['Amalie Laz']) : page });
    confirmRadiusImport(s);
    return {
      F: String(s.wop.values[0][5]),  G: String(s.wop.values[0][6]),
      H: String(s.wop.values[0][7]),  J: String(s.wop.values[0][9]),
      O: String(s.wop.values[0][14]), P: String(s.wop.values[0][15])
    };
  }

  const done = runCase('10:48 AM', '11:48 AM', '9/12/2026 11:49:00 AM');

  checkTruthy('prefix: the summary column is stamped', done.O.indexOf('ALB: ') === 0);
  checkTruthy('prefix: the notes column is stamped', done.P.indexOf('ALB: ') === 0);
  checkTruthy('prefix: the text survives the stamp',
    done.P.includes('she doesnt shut up big L'));

  // Everything else is a single value read at a glance; a prefix there is noise.
  checkTruthy('prefix: nowhere else', [done.F, done.G, done.H, done.J]
    .every(v => v.indexOf('ALB:') === -1));
  check('prefix: does not disturb the pages count', done.H, '33');

  // Finalised, so column J keeps its plain Y.
  check('finalized: a finalised session writes Y', done.J, 'Y');

  // Signed in and out, never finalised: blank would read like an unfinished
  // session, which is the one thing it is not.
  const unfinalised = runCase('10:48 AM', '11:48 AM', '');
  check('finalized: finished but not finalised writes N', unfinalised.J, 'N');

  // Still in the centre: nothing to say yet either way.
  const open = runCase('10:48 AM', '', '');
  check('finalized: no sign-out leaves J alone', open.J, '');

  // An empty summary or note is left empty. A cell holding nothing but the
  // stamp would claim the bot wrote something when it wrote nothing.
  const blank = (function () {
    const s = scenario([HEADER, ...DECK_FILLER_ROWS,
      ['Amalie Laz', '', '', '', '', '', '', '', '', '', '', '', '']],
      [{ name: 'Amalie Laz' }], { start: 1, rows: 1 }, '2026-08-22');
    s.harness.scriptProps.RADIUS_COOKIE = 'session=abc';
    vm.runInContext(
      'CONFIG.RADIUS.ROSTER_URL = "https://radius.mathnasium.com/IM"; ' +
      'CONFIG.RADIUS.TOKEN_PAGE_URL = "";', s.context);
    const page = dwp('live');
    s.harness.fetchHandler.value = url => ({ code: 200, body:
      url.indexOf('/IM') !== -1 ? rosterReply(['Amalie Laz']) : page });
    confirmRadiusImport(s);
    return { O: String(s.wop.values[0][14]), P: String(s.wop.values[0][15]) };
  })();
  check('prefix: an empty summary stays empty', blank.O, '');
  check('prefix: an empty note stays empty', blank.P, '');

  // Running it twice must not stack the stamp.
  checkTruthy('prefix: re-importing does not double-stamp',
    done.P.indexOf('ALB: ALB:') === -1);
}

// 52h3. A blank note column is left blank rather than stamped with a bare mark.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);

  const prefixed = api.CONFIG.RADIUS.FIELDS.filter(f => f.prefix).map(f => f.key);
  check('prefix: configured on exactly the two note columns',
    prefixed.sort(), ['internalNotes', 'sessionSummary']);
  check('prefix: the unfinalised field is a real field',
    api.CONFIG.RADIUS.FIELDS.filter(
      f => f.key === api.CONFIG.RADIUS.UNFINALIZED_FIELD).length, 1);
}

// 52i. The Mathlete score on the end of the note column.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  check('score: present on the completed page',
    api.RADIUS_EXTRACTORS.mathleteScore(
      dwp('complete')), '3');
  check('score: absent on an untouched page',
    api.RADIUS_EXTRACTORS.mathleteScore(
      dwp('live')), '');
}

// 52j. EOD reaches Radius only when asked. Import and EOD are two clicks now,
//      and running them in order still hands the one's work to the other.
{
  function setUp(status) {
    const s = scenario(
      [HEADER, ...DECK_FILLER_ROWS,
       ['Amalie Laz', 'Task One', '', '', 'Task Two, Task Three', '',
        '', '', '', '', '', '', '']],
      [{ name: 'Amalie Laz', status: status === undefined ? '' : status }],
      { start: 1, rows: 1 }, '2026-08-22');
    s.harness.scriptProps.RADIUS_COOKIE = 'session=abc';
    vm.runInContext(
      'CONFIG.RADIUS.ROSTER_URL = "https://radius.mathnasium.com/IM"; ' +
      'CONFIG.RADIUS.TOKEN_PAGE_URL = "";', s.context);
    const page = dwp('complete');
    s.harness.fetchHandler.value = url => ({ code: 200, body:
      url.indexOf('/IM') !== -1 ? rosterReply(['Amalie Laz']) : page });
    return s;
  }

  // EOD on its own touches nothing outside the spreadsheet, cookie or no.
  let s = setUp();
  s.api.processWopToDeck();
  check('EOD alone: Radius is not contacted', s.harness.fetchLog.length, 0);
  check('EOD alone: column K is not invented', s.wopStatus(0), '');
  check('EOD alone: the student is not advanced', s.deckCell(4, C.CURRENT), 'Task One');
  checkTruthy('EOD alone: nothing it says mentions an import',
    !s.harness.alerts.concat(s.harness.dialogs.map(d => d.html))
      .some(t => String(t).includes('Imported from Radius')));

  // Run deliberately, in order: the import writes the instruction into column
  // K and EOD then acts on it, exactly as it used to in one step.
  s = setUp();
  confirmRadiusImport(s);
  check('import then EOD: the import wrote the Y', s.wopStatus(0), 'Y');
  s.api.processWopToDeck();
  check('import then EOD: EOD marked it done', s.wopStatusBg(0), '#00ff00');
  check('import then EOD: the student was advanced',
    s.deckCell(4, C.CURRENT), 'Task Two');
  check('import then EOD: the finished task was archived',
    s.deckCell(4, C.ARCHIVE), 'Task One 08/22');
  check('import then EOD: the other columns landed too',
    [String(s.wop.values[0][7]), String(s.wop.values[0][11])], ['33', '10:48 AM']);
  check('import then EOD: notes and score reached column P',
    String(s.wop.values[0][15]), 'ALB: she doesnt shut up big L | MLS (3)');

  // A typed P survives the import and acts alongside the imported Y.
  s = setUp('P');
  confirmRadiusImport(s);
  s.api.processWopToDeck();
  check('import then EOD: typed P and imported Y both act',
    [s.deckCell(4, C.CURRENT), s.deckCell(4, C.PINK)], ['Task Two', 'pink']);
}

// 53. A fully completed page. This is the one that exposed the textarea bug
//     and finally showed a switch set to Yes.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  const DONE = dwp('complete');
  const get = key => api.RADIUS_EXTRACTORS[key](DONE);

  check('complete: pages completed', get('pagesCompleted'), '33');
  check('complete: signed out', get('signedOut'), '11:48 AM');
  check('complete: finalized', get('finalized'), 'Yes');

  // CONFIRMED at last: 1 really does mean Yes.
  check('complete: deck needs update reads Yes', get('deckNeedsUpdate'), 'Yes');
  check('complete: problem of the week reads Yes', get('problemOfTheWeek'), 'Yes');
  check('switch raw value for a Yes is 1',
    api.tripleSwitchRaw_(DONE, 'Deck1NeedsUpdate'), '1');

  // A switch reset back to untouched on a page where others are set must stay
  // blank -- neither Yes nor No.
  check('complete: a reset switch is still blank',
    api.tripleSwitchRaw_(DONE, 'Schoolwork'), '');

  // REGRESSION: Radius keeps note text in a value attribute on the textarea
  // rather than between the tags. Reading the inner content returned '' for a
  // note that was plainly there, and '' is a legitimate "nothing written"
  // answer -- so this failed silently rather than loudly.
  check('complete: session summary read from the value attribute',
    get('sessionSummary'), 'She flew so high and so fast');
  check('complete: internal notes read from the value attribute',
    get('internalNotes'), 'she doesnt shut up big L');
  check('textarea: value attribute wins over empty inner content',
    api.textareaContentById_('<textarea id="X" value="from attribute"></textarea>', 'X'),
    'from attribute');
  check('textarea: plain inner content still works',
    api.textareaContentById_('<textarea id="X">from inner text</textarea>', 'X'),
    'from inner text');
  check('textarea: genuinely empty stays empty',
    api.textareaContentById_('<textarea id="X"></textarea>', 'X'), '');
  check('textarea: an empty value attribute is empty, not a fallback',
    api.textareaContentById_('<textarea id="X" value="">ignored</textarea>', 'X'), '');
  check('textarea: missing element is null, not empty',
    api.textareaContentById_('<div>nothing</div>', 'X'), null);

  // Every row is worked on here, but the mastery split differs per row.
  check('complete: all seven topics worked on',
    get('topicsWorkedOn').split('; ').length, 7);
  check('complete: completed & mastered', get('completedMastered'),
    'Completing Right Triangles; Converting Angles - Degrees and Radians; ' +
    'Solving Trigonometric Equations');
  check('complete: completed but not mastered', get('completedNotMastered'),
    'The Unit Circle - Angles as Rotations; Coterminal Angles; ' +
    'Right Triangle Trigonometry - sine, cosine and tangent');

  // Radio groups.
  check('complete: mathlete score', get('mathleteScore'), '3');
  check('complete: assessment status read from its label',
    get('assessmentStatus'), 'Pre completed');

  const LIVE = dwp('live');
  check('untouched page: no mathlete score',
    api.RADIUS_EXTRACTORS.mathleteScore(LIVE), '');
  check('untouched page: no assessment status',
    api.RADIUS_EXTRACTORS.assessmentStatus(LIVE), '');

  check('radio: unticked group yields empty',
    api.checkedRadioValue_('<input name="G" type="radio" value="1" />', 'G'), '');
  check('radio: picks the ticked one, not the first',
    api.checkedRadioValue_(
      '<input name="G" type="radio" value="1" />' +
      '<input name="G" type="radio" value="2" checked />', 'G'), '2');
}

// 52k. The confirmation dialog: what it shows, and what it writes.
{
  function twoStudents(existingP) {
    const s = scenario([HEADER, ...DECK_FILLER_ROWS,
      ['Amalie Laz', 'Task One', '', '', 'Task Two', '', '', '', '', '', '', '', '', ''],
      ['John Roe', 'Task A', '', '', 'Task B', '', '', '', '', '', '', '', '', '']],
      [{ name: 'Amalie Laz' }, { name: 'John Roe' }],
      { start: 1, rows: 2 }, '2026-08-22');

    if (existingP !== undefined) {
      s.wop.values[0][15] = existingP;   // column P on the first row
    }
    s.harness.scriptProps.RADIUS_COOKIE = 'session=abc';
    vm.runInContext(
      'CONFIG.RADIUS.ROSTER_URL = "https://radius.mathnasium.com/IM"; CONFIG.RADIUS.TOKEN_PAGE_URL = "";',
      s.context);

    const page = dwp('complete');
    s.harness.fetchHandler.value = url => ({ code: 200, body:
      url.indexOf('/IM') !== -1
        ? rosterReply([{ name: 'Amalie Laz', studentId: 1 },
                       { name: 'John Roe', studentId: 2 }])
        : page.replace(/<title>[^<]*<\/title>/,
            url.indexOf('studentId=2') !== -1 ? '<title>John Roe</title>'
                                             : '<title>Amalie Laz</title>') });
    return s;
  }

  // The preview lists every student, writes nothing, and offers a checkbox each.
  let s = twoStudents();
  s.api.importRadiusData();
  const preview = s.harness.dialogs[0];
  check('preview: shown instead of writing', preview.title, 'Confirm Radius import');
  checkTruthy('preview: names both students',
    preview.html.includes('Amalie Laz') && preview.html.includes('John Roe'));
  checkTruthy('preview: a checkbox each',
    (preview.html.match(/class="pick"/g) || []).length === 2);
  checkTruthy('preview: a confirm-all button',
    preview.html.includes('Confirm changes for all 2'));
  check('preview: nothing written yet',
    [String(s.wop.values[0][7]), String(s.wop.values[1][7])], ['', '']);
  checkTruthy('preview: shows the values it would write',
    preview.html.includes('33'));

  // Confirming everything writes both rows.
  s = twoStudents();
  confirmRadiusImport(s);
  check('confirm all: both rows written',
    [String(s.wop.values[0][7]), String(s.wop.values[1][7])], ['33', '33']);

  // Ticking one writes only that one.
  s = twoStudents();
  confirmRadiusImport(s, { only: [0] });
  check('confirm one: only the ticked row is written',
    [String(s.wop.values[0][7]), String(s.wop.values[1][7])], ['33', '']);
  checkTruthy('confirm one: the report counts the one left out',
    lastDialog(s).html.includes('Left out'));

  // Ticking nobody is refused rather than silently doing nothing.
  s = twoStudents();
  s.api.importRadiusData();
  const token = (s.harness.dialogs[0].html.match(/name="token" value="([^"]+)"/) || [])[1];
  let err = '';
  try { s.api.applyRadiusPlan_FromUI({ token: token, mode: 'overwrite' }); }
  catch (e) { err = e.message; }
  checkTruthy('confirm none: refused with a reason', err.includes('nothing to write'));
  check('confirm none: nothing written', String(s.wop.values[0][7]), '');

  // An expired plan is refused rather than writing a stale one.
  s = twoStudents();
  s.api.importRadiusData();
  err = '';
  try { s.api.applyRadiusPlan_FromUI({ token: 'gone', mode: 'overwrite', pick_0: 'on' }); }
  catch (e) { err = e.message; }
  checkTruthy('expired plan: refused', err.includes('expired'));
}

// 52l. What happens when a cell already holds something.
{
  function withExisting(mode) {
    const s = scenario([HEADER, ...DECK_FILLER_ROWS,
      ['Amalie Laz', 'Task One', '', '', 'Task Two', '', '', '', '', '', '', '', '', '']],
      [{ name: 'Amalie Laz' }], { start: 1, rows: 1 }, '2026-08-22');
    s.wop.values[0][7] = 'typed by hand';     // column H
    s.harness.scriptProps.RADIUS_COOKIE = 'session=abc';
    vm.runInContext(
      'CONFIG.RADIUS.ROSTER_URL = "https://radius.mathnasium.com/IM"; CONFIG.RADIUS.TOKEN_PAGE_URL = "";',
      s.context);
    const page = dwp('complete');
    s.harness.fetchHandler.value = url => ({ code: 200, body:
      url.indexOf('/IM') !== -1
        ? rosterReply(['Amalie Laz'])
        : page });
    return { s: s, preview: confirmRadiusImport(s, { mode: mode }) };
  }

  // The preview warns before anything happens.
  let out = withExisting('overwrite');
  checkTruthy('conflict: the preview says a cell already holds something',
    out.preview.html.includes('already hold'));
  checkTruthy('conflict: and shows what is in it',
    out.preview.html.includes('typed by hand'));
  checkTruthy('conflict: offers all three choices',
    out.preview.html.includes('value="append"') &&
    out.preview.html.includes('value="overwrite"') &&
    out.preview.html.includes('value="skip"'));

  check('overwrite: replaces what was there', String(out.s.wop.values[0][7]), '33');

  out = withExisting('append');
  check('append: keeps what was there and adds to it',
    String(out.s.wop.values[0][7]), 'typed by hand | 33');

  out = withExisting('skip');
  check('skip: leaves it exactly as it was',
    String(out.s.wop.values[0][7]), 'typed by hand');
  check('skip: still fills the empty cells', String(out.s.wop.values[0][5]), 'Y');
  checkTruthy('skip: the report counts what it left alone',
    lastDialog(out.s).html.includes('Cells left alone'));

  // With no clash there is no choice to make, so the block is not shown.
  const clean = scenario([HEADER, ...DECK_FILLER_ROWS,
    ['Amalie Laz', 'Task One', '', '', 'Task Two', '', '', '', '', '', '', '', '', '']],
    [{ name: 'Amalie Laz' }], { start: 1, rows: 1 }, '2026-08-22');
  clean.harness.scriptProps.RADIUS_COOKIE = 'session=abc';
  vm.runInContext(
    'CONFIG.RADIUS.ROSTER_URL = "https://radius.mathnasium.com/IM"; CONFIG.RADIUS.TOKEN_PAGE_URL = "";',
    clean.context);
  const page = dwp('complete');
  clean.harness.fetchHandler.value = url => ({ code: 200, body:
    url.indexOf('/IM') !== -1
      ? rosterReply(['Amalie Laz'])
      : page });
  clean.api.importRadiusData();
  checkTruthy('no clash: no append-or-overwrite block',
    !clean.harness.dialogs[0].html.includes('already hold'));
}

// 52m. A plan survives the round trip through the cache in one piece.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);

  const long = new Array(400).join('x');   // a note near the real length cap
  const plan = { startRow: 1, numRows: 3, problems: [], stoppedEarly: false,
    students: [
      { index: 0, name: 'Amalie Laz', values: { internalNotes: long },
        existing: {}, conflicts: [], blocked: [], shade: true, durationMinutes: 28 },
      { index: 2, name: 'John Roe', values: { internalNotes: long },
        existing: {}, conflicts: ['internalNotes'], blocked: ['x'],
        shade: false, durationMinutes: 60 }
    ] };

  const token = api.storeRadiusPlan_(plan);
  const back = api.loadRadiusPlan_(token);
  check('cache: both students come back', back.students.length, 2);
  check('cache: indexes preserved',
    back.students.map(s => s.index), [0, 2]);
  check('cache: a long note survives',
    back.students[0].values.internalNotes.length, long.length);
  check('cache: conflicts and blocks survive',
    [back.students[1].conflicts, back.students[1].blocked], [['internalNotes'], ['x']]);
  check('cache: an unknown token yields nothing', api.loadRadiusPlan_('nope'), null);
}

// 53. Every field lands in its configured column, F through P.
{
  const s = scenario([HEADER, ...DECK_FILLER_ROWS,
    ['Amalie Laz', '', '', '', '', '', '', '', '', '', '', '', '', '']],
    [{ name: '9:59 AM Amalie Laz' }], { start: 1, rows: 1 }, '2026-08-22');

  s.harness.scriptProps.RADIUS_COOKIE = 'session=abc';
  vm.runInContext('CONFIG.RADIUS.ROSTER_URL = "https://radius.mathnasium.com/IM"; CONFIG.RADIUS.TOKEN_PAGE_URL = "";',
    s.context);

  const LIVE = dwp('live');
  s.harness.fetchHandler.value = url => ({ code: 200, body:
    url.indexOf('/IM') !== -1
      ? rosterReply(['Amalie Laz'])
      : LIVE });

  confirmRadiusImport(s);

  // F G H J K L M O P, zero-indexed.
  check('configured columns written',
    [5, 6, 7, 9, 10, 11, 12, 14, 15].map(c => String(s.wop.values[0][c])),
    ['', '', '', '', '', '9:59 AM', '', '', '']);
  checkTruthy('import reports every column it wrote',
    lastDialog(s).html.includes('F, G, H, J, K, L, M, O, P'));
}

// 54. A roster link pointing at the wrong student writes nothing.
{
  const s = scenario([HEADER, ...DECK_FILLER_ROWS,
    ['Jane Doe', '', '', '', '', '', '', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe' }], { start: 1, rows: 1 }, '2026-08-22');

  s.harness.scriptProps.RADIUS_COOKIE = 'session=abc';
  vm.runInContext('CONFIG.RADIUS.ROSTER_URL = "https://radius.mathnasium.com/IM"; CONFIG.RADIUS.TOKEN_PAGE_URL = "";',
    s.context);

  const LIVE = dwp('live');
  s.harness.fetchHandler.value = url => ({ code: 200, body:
    url.indexOf('/IM') !== -1
      ? rosterReply(['Jane Doe'])
      : LIVE });  // page is actually Amalie Laz

  confirmRadiusImport(s);
  check('wrong student: nothing written to Q', String(s.wop.values[0][16]), '');
  // Nothing was fetched, so there is no preview to show -- just an alert.
  checkTruthy('wrong student: explained',
    s.harness.alerts.some(a => String(a).includes('instead')));
  check('wrong student: no preview offered', s.harness.dialogs.length, 0);
}


// 53. An unset Instruction Manager URL is reported, not fetched.
{
  const s = scenario([HEADER, ...DECK_FILLER_ROWS,
    ['Jane Doe', '', '', '', '', '', '', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe' }], { start: 1, rows: 1 }, '2026-08-22');
  s.harness.scriptProps.RADIUS_COOKIE = 'session=abc';
  vm.runInContext('CONFIG.RADIUS.ROSTER_URL = "";', s.context);
  confirmRadiusImport(s);
  check('unset roster URL: nothing fetched', s.harness.fetchLog.length, 0);
  checkTruthy('unset roster URL: says what to set',
    s.harness.alerts.some(a => String(a).includes('ROSTER_URL')));
}


// ==========================================================================
console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  failures.forEach(f => console.log('  FAIL ' + f + '\n'));
  process.exit(1);
}
