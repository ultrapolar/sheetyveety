'use strict';
const fs = require('fs');
const vm = require('vm');
const { FakeSheet, makeGrid, install, fixedDate } = require('./fakeSheets.js');

const SOURCES = ['Config.gs', 'Common.gs', 'Sod.gs', 'Eod.gs', 'Repair.gs', 'Radius.gs', 'Menu.gs'];

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
  executeSodOperations_FromUI, repairHistoryColumn, applyHistoryColumnRepair,
  deleteLegacyHistoryColumn, parseEntryMonthDay_, inferEntryDates_,
  splitHistoryEntries_, planHistoryColumnRepair_,
  looksLikeLoginPage_, radiusFetch_, importRadiusData, RADIUS_EXTRACTORS,
  parseInstructionManager_, normalizeStudentName_, htmlCellText_,
  findDwpLink_, lookupRosterEntry_, testRadiusConnection,
  inputValueById_, textareaContentById_, tripleSwitchRaw_, tripleSwitchLabel_,
  dwpAssignmentRows_, assignmentCheckboxChecked_, pageStudentName_,
  extractRadiusFields_, checkedRadioValue_, checkedRadioLabel_, formatPkCode_,
  yesFlag_, CONFIG, mergeStatusLetters_, parseClockTime_, reviewSessionTiming_
};`;
  vm.runInContext(source, context);
  return context.__api;
}

function scenario(deckRows, wopRows, selection, today) {
  const deckValues = deckRows.map(r => {
    const row = r.slice();
    while (row.length < 14) row.push('');
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

  const context = vm.createContext({ console, Buffer, JSON, Math,
    Date: today ? fixedDate(today) : Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  const harness = install(context, [deck, wop], 'Daily WOP');
  const api = loadScript(context);
  return { deck, wop, harness, api, context,
    deckCell: (row, col) => String(deck.values[row - 1][col - 1]),
    wopStatus: i => String(wop.values[selection.start - 1 + i][10]),
    wopStatusBg: i => String(wop.backgrounds[selection.start - 1 + i][10]),
    wopNameBg: i => String(wop.backgrounds[selection.start - 1 + i][0]) };
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
const HEADER = ['Name', 'Current', 'Pink', '', 'Loaded', 'Queue', '', '', '', '', '', '', 'Legacy', 'Archive'];
const C = { NAME: 1, CURRENT: 2, PINK: 3, LOADED: 5, QUEUE: 6, LEGACY: 13, ARCHIVE: 14 };

// The history repair treats the Deck List's first 3 rows as headers (row 1
// is the real header; rows 2-3 are a legend/instructions row that also holds
// no student). Repair tests below insert these two ahead of any real data so
// row numbers line up with a real Deck List.
const REPAIR_FILLER_ROWS = [
  ['LEGEND', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['(instructions)', '', '', '', '', '', '', '', '', '', '', '', '', '']
];

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
    [HEADER, ['Jane Doe', 'T1', '', '', 'T2, T3', '', '', '', '', '', '', '', '', 'OLD 01/01']],
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
    [HEADER, ['Jane Doe', 'T3', '', '', 'T4', '', '', '', '', '', '', '', '', 'T1 08/22 | T2 08/22']],
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
    s.harness.dialogs[0].html.includes('only one pink was applied'));
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
    s.harness.dialogs[0].html.includes('more than once'));
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
    const row = r.slice(); while (row.length < 14) row.push(''); return row;
  }));
  // Simulate getDataRange() stopping at column B by shrinking the reported grid.
  deck.getDataRange = function () {
    const FakeRangeCtor = Object.getPrototypeOf(this.getRange(1, 1, 1, 1)).constructor;
    return new FakeRangeCtor(this, 1, 1, this.values.length, 2);
  };
  const wopValues = [['Jane Doe', '', '', '', '', '', '', '', '', '', 'Y']];
  const wop = new FakeSheet('Daily WOP', wopValues, makeGrid(1, 11, '#ffffff'));
  wop.setSelection(1, 1);
  const context = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(context, [deck, wop], 'Daily WOP');
  const api = loadScript(context);
  api.processWopToDeck();
  check('EOD narrow deck: archive written cleanly',
    String(deck.values[1][13]), 'T1 08/22');
  check('EOD narrow deck: no "undefined" leaked into padded cells',
    String(deck.values[1][12]), '');
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
    s.harness.dialogs[0].html.includes('queue is empty'));
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
  const html = s.harness.dialogs[0].html;
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
  check('archive column is N', api.CONFIG.DECK_COL.ARCHIVE, 14);
}

// 29. Reading the date off an entry.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  const p = e => { const r = api.parseEntryMonthDay_(e); return r ? [r.month, r.day, r.year] : null; };

  check('parseEntry "Fractions 08/20"', p('Fractions 08/20'), [8, 20, null]);
  check('parseEntry single digits "Task 8/2"', p('Task 8/2'), [8, 2, null]);
  check('parseEntry with 2-digit year', p('Task 08/20/26'), [8, 20, 2026]);
  check('parseEntry with 4-digit year', p('Task 08/20/2026'), [8, 20, 2026]);
  check('parseEntry no date', p('Just a task name'), null);
  check('parseEntry impossible month', p('Task 13/40'), null);
  check('parseEntry date not at the end', p('08/20 Task'), null);
}

// 30. Inferring the year: entries run oldest to newest, so reading backwards
//     the dates never move forward. When one does, the year rolls back.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  const TODAY = new Date(2026, 7, 22); // 22 Aug 2026
  const iso = d => d === null ? null :
    d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
  const infer = list => api.inferEntryDates_(list, TODAY).map(r => iso(r.date));

  check('infer: all within this year',
    infer(['a 07/15', 'b 08/02', 'c 08/20']),
    ['2026-07-15', '2026-08-02', '2026-08-20']);

  check('infer: rolls back across the new year',
    infer(['a 11/30', 'b 12/20', 'c 01/15', 'd 08/20']),
    ['2025-11-30', '2025-12-20', '2026-01-15', '2026-08-20']);

  check('infer: newest entry cannot be in the future',
    infer(['a 09/30', 'b 10/05']),
    ['2025-09-30', '2025-10-05']);

  // Same-day repeats are ordinary: a "YY" archives two tasks on one date.
  check('infer: same-day entries stay in the same year',
    infer(['a 08/20', 'b 08/20', 'c 08/20']),
    ['2026-08-20', '2026-08-20', '2026-08-20']);

  // A genuine multi-year gap only rolls back when the date moves forward.
  check('infer: rolls back once per forward jump',
    infer(['a 09/01', 'b 03/01', 'c 09/01', 'd 08/20']),
    ['2024-09-01', '2025-03-01', '2025-09-01', '2026-08-20']);

  check('infer: an explicit year is trusted as given',
    infer(['a 03/01/2024', 'b 08/20']),
    ['2024-03-01', '2026-08-20']);

  check('infer: undated entries come back null',
    infer(['no date here', 'b 08/20']), [null, '2026-08-20']);
}

// 31. Splitting a cell at the cutoff.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  const TODAY = new Date(2026, 7, 22);
  const CUTOFF = new Date(2026, 7, 1); // 1 Aug 2026
  const split = text => {
    const r = api.splitHistoryEntries_(text, CUTOFF, TODAY);
    return [r.keep, r.move, r.undatedKept];
  };

  check('split: everything recent',
    split('a 08/05 | b 08/20'), [[], ['a 08/05', 'b 08/20'], []]);

  check('split: everything old',
    split('a 06/05 | b 07/20'), [['a 06/05', 'b 07/20'], [], []]);

  check('split: mixed, cut at the boundary',
    split('a 07/28 | b 08/01 | c 08/20'),
    [['a 07/28'], ['b 08/01', 'c 08/20'], []]);

  check('split: same day as the cutoff counts as recent',
    split('a 08/01'), [[], ['a 08/01'], []]);

  check('split: last year August is old, not recent',
    split('a 08/15 | b 12/01 | c 08/20'),
    [['a 08/15', 'b 12/01'], ['c 08/20'], []]);

  check('split: undated text left behind is reported',
    split('handwritten note | a 07/01 | b 08/10'),
    [['handwritten note', 'a 07/01'], ['b 08/10'], ['handwritten note']]);

  check('split: empty', split(''), [[], [], []]);
}

// 32. Rows 2-3 are treated as headers, same as row 1, and are never touched
//     -- even when they hold stray text that looks like recent history.
{
  const deckRows = [HEADER,
    ['LEGEND', '', '', '', '', '', '', '', '', '', '', '', 'ignore me 08/10', ''],
    ['(instructions)', '', '', '', '', '', '', '', '', '', '', '', 'also ignore 08/12', ''],
    ['Jane Doe', 'T5', '', '', '', '', '', '', '', '', '', '', 'T1 08/15', '']];
  const s = scenario(deckRows, [{ name: 'Jane Doe' }], { start: 1, rows: 1 }, '2026-08-22');
  s.api.applyHistoryColumnRepair();
  check('Header skip: row 2 M untouched', s.deckCell(2, C.LEGACY), 'ignore me 08/10');
  check('Header skip: row 2 N untouched', s.deckCell(2, C.ARCHIVE), '');
  check('Header skip: row 3 M untouched', s.deckCell(3, C.LEGACY), 'also ignore 08/12');
  check('Header skip: row 3 N untouched', s.deckCell(3, C.ARCHIVE), '');
  check('Header skip: real row 4 still moved', s.deckCell(4, C.ARCHIVE), 'T1 08/15');
}

// 33. Repair moves post-cutoff history into an empty N and leaves M alone.
{
  const deckRows = [HEADER, ...REPAIR_FILLER_ROWS,
    ['Jane Doe', 'T5', '', '', '', '', '', '', '', '', '', '', 'T1 08/05 | T2 08/20', ''],
    ['John Roe', 'T9', '', '', '', '', '', '', '', '', '', '', 'T7 08/12', '']];
  const s = scenario(deckRows, [{ name: 'Jane Doe' }], { start: 1, rows: 1 }, '2026-08-22');
  s.api.repairHistoryColumn();
  check('Repair: preview changes nothing', s.deckCell(4, C.ARCHIVE), '');
  checkTruthy('Repair: preview opens',
    s.harness.dialogs[0].title === 'Repair History Column');

  s.api.applyHistoryColumnRepair();
  check('Repair: Jane history now in N', s.deckCell(4, C.ARCHIVE), 'T1 08/05 | T2 08/20');
  check('Repair: John history now in N', s.deckCell(5, C.ARCHIVE), 'T7 08/12');
  check('Repair: M deliberately left intact', s.deckCell(4, C.LEGACY), 'T1 08/05 | T2 08/20');
  check('Repair: header row untouched', s.deckCell(1, C.LEGACY), 'Legacy');
}

// 34. Pre-cutoff entries stay put, post-cutoff ones move.
{
  const deckRows = [HEADER, ...REPAIR_FILLER_ROWS,
    ['Jane Doe', 'T5', '', '', '', '', '', '', '', '', '', '',
     'Old1 06/10 | Old2 07/28 | New1 08/03 | New2 08/19', '']];
  const s = scenario(deckRows, [{ name: 'Jane Doe' }], { start: 1, rows: 1 }, '2026-08-22');
  s.api.applyHistoryColumnRepair();
  check('Cutoff: only post-8/1 moved', s.deckCell(4, C.ARCHIVE), 'New1 08/03 | New2 08/19');
  checkTruthy('Cutoff: doomed text reported',
    s.harness.dialogs[0].html.includes('Old1 06/10 | Old2 07/28'));
  checkTruthy('Cutoff: warns it will be lost',
    s.harness.dialogs[0].html.includes('lost when the column is deleted'));
}

// 35. A row with nothing recent enough is left entirely alone.
{
  const deckRows = [HEADER, ...REPAIR_FILLER_ROWS,
    ['Jane Doe', 'T5', '', '', '', '', '', '', '', '', '', '', 'Old 05/10 | Older 04/02', '']];
  const s = scenario(deckRows, [{ name: 'Jane Doe' }], { start: 1, rows: 1 }, '2026-08-22');
  s.api.repairHistoryColumn();
  checkTruthy('All-old row: preview declines',
    s.harness.alerts.length === 1 && s.harness.alerts[0].includes('Nothing to move'));
  check('All-old row: N untouched', s.deckCell(4, C.ARCHIVE), '');
  check('All-old row: M untouched', s.deckCell(4, C.LEGACY), 'Old 05/10 | Older 04/02');
}

// 36. Where N already holds text, it keeps its place and the moved text follows.
{
  const deckRows = [HEADER, ...REPAIR_FILLER_ROWS,
    ['Jane Doe', 'T5', '', '', '', '', '', '', '', '', '', '', 'T2 08/12', 'PRE-INSERT 07/01']];
  const s = scenario(deckRows, [{ name: 'Jane Doe' }], { start: 1, rows: 1 }, '2026-08-22');
  s.api.applyHistoryColumnRepair();
  check('Merge: existing text kept first',
    s.deckCell(4, C.ARCHIVE), 'PRE-INSERT 07/01 | T2 08/12');
  checkTruthy('Merge: flagged for review',
    s.harness.dialogs[0].html.includes('worth an eyeball'));
}

// 37. Running the repair twice does not duplicate anything.
{
  const deckRows = [HEADER, ...REPAIR_FILLER_ROWS,
    ['Jane Doe', 'T5', '', '', '', '', '', '', '', '', '', '', 'T1 08/10', '']];
  const s = scenario(deckRows, [{ name: 'Jane Doe' }], { start: 1, rows: 1 }, '2026-08-22');
  s.api.applyHistoryColumnRepair();
  check('Idempotent: first pass', s.deckCell(4, C.ARCHIVE), 'T1 08/10');
  s.api.applyHistoryColumnRepair();
  check('Idempotent: second pass unchanged', s.deckCell(4, C.ARCHIVE), 'T1 08/10');
  s.api.applyHistoryColumnRepair();
  check('Idempotent: third pass unchanged', s.deckCell(4, C.ARCHIVE), 'T1 08/10');
}

// 38. Undated text left behind is called out, since M is about to be deleted.
{
  const deckRows = [HEADER, ...REPAIR_FILLER_ROWS,
    ['Jane Doe', 'T5', '', '', '', '', '', '', '', '', '', '',
     'scribbled note | T1 08/10', '']];
  const s = scenario(deckRows, [{ name: 'Jane Doe' }], { start: 1, rows: 1 }, '2026-08-22');
  s.api.applyHistoryColumnRepair();
  check('Undated: dated part moved', s.deckCell(4, C.ARCHIVE), 'T1 08/10');
  checkTruthy('Undated: note flagged',
    s.harness.dialogs[0].html.includes('scribbled note'));
}

// 39. The delete step refuses while anything recent is still unmoved.
{
  const deckRows = [HEADER, ...REPAIR_FILLER_ROWS,
    ['Jane Doe', 'T5', '', '', '', '', '', '', '', '', '', '', 'T1 08/10', '']];
  const s = scenario(deckRows, [{ name: 'Jane Doe' }], { start: 1, rows: 1 }, '2026-08-22');
  s.api.deleteLegacyHistoryColumn();
  checkTruthy('Delete guard: refuses',
    s.harness.alerts.some(a => String(a).includes('Not deleting column M')));
  check('Delete guard: column still there', s.deck.values[0].length, 14);
}

// 40. After the move, deleting M shifts N back into M.
{
  const deckRows = [HEADER, ...REPAIR_FILLER_ROWS,
    ['Jane Doe', 'T5', '', '', '', '', '', '', '', '', '', '', 'T1 08/10', ''],
    ['John Roe', 'T9', '', '', '', '', '', '', '', '', '', '', 'T7 08/12', '']];
  const s = scenario(deckRows, [{ name: 'Jane Doe' }], { start: 1, rows: 1 }, '2026-08-22');
  s.api.applyHistoryColumnRepair();
  check('Delete: history staged in N', s.deckCell(4, C.ARCHIVE), 'T1 08/10');

  s.api.deleteLegacyHistoryColumn();
  check('Delete: column removed', s.deck.values[0].length, 13);
  check('Delete: history now sits in M', String(s.deck.values[3][12]), 'T1 08/10');
  check('Delete: second row too', String(s.deck.values[4][12]), 'T7 08/12');
  checkTruthy('Delete: reminds about the config change',
    s.harness.alerts.some(a => String(a).includes('DECK_COL.ARCHIVE')));
}

// 41. Cancelling the delete confirmation leaves the column in place.
{
  const deckRows = [HEADER, ...REPAIR_FILLER_ROWS,
    ['Jane Doe', 'T5', '', '', '', '', '', '', '', '', '', '', 'T1 08/10', '']];
  const s = scenario(deckRows, [{ name: 'Jane Doe' }], { start: 1, rows: 1 }, '2026-08-22');
  s.api.applyHistoryColumnRepair();
  s.harness.uiAnswer.value = 'CANCEL';
  s.api.deleteLegacyHistoryColumn();
  check('Delete cancelled: column intact', s.deck.values[0].length, 14);
}

// 42. Deleting with pre-cutoff text still in M warns that it will be destroyed.
{
  const deckRows = [HEADER, ...REPAIR_FILLER_ROWS,
    ['Jane Doe', 'T5', '', '', '', '', '', '', '', '', '', '', 'Old 05/01', '']];
  const s = scenario(deckRows, [{ name: 'Jane Doe' }], { start: 1, rows: 1 }, '2026-08-22');
  s.api.deleteLegacyHistoryColumn();
  checkTruthy('Delete with doomed text: warns',
    s.harness.alerts.some(a => String(a).includes('permanently deleted')));
  check('Delete with doomed text: went ahead on OK', s.deck.values[0].length, 13);
}

// 43. After the repair, a fresh EOD run appends alongside the moved history.
{
  const deckRows = [HEADER, ...REPAIR_FILLER_ROWS,
    ['Jane Doe', 'T3', '', '', 'T4', '', '', '', '', '', '', '', 'T1 08/05 | T2 08/12', '']];
  const s = scenario(deckRows, [{ name: 'Jane Doe', status: 'Y' }],
    { start: 1, rows: 1 }, '2026-08-22');
  s.api.applyHistoryColumnRepair();
  s.api.processWopToDeck();
  check('Post-repair EOD: appends to moved history',
    s.deckCell(4, C.ARCHIVE), 'T1 08/05 | T2 08/12 | T3 08/22');
  check('Post-repair EOD: student advanced', s.deckCell(4, C.CURRENT), 'T4');
}

// 44. The repair works while looking at the Deck List, not just the WOP sheet.
{
  const deckValues = [HEADER, ...REPAIR_FILLER_ROWS,
    ['Jane Doe', 'T5', '', '', '', '', '', '', '', '', '', '', 'T1 08/10', '']]
    .map(r => { const row = r.slice(); while (row.length < 14) row.push(''); return row; });
  const deck = new FakeSheet('Deck List', deckValues);
  const wop = new FakeSheet('Daily WOP', [new Array(11).fill('')], makeGrid(1, 11, '#ffffff'));
  wop.setSelection(1, 1);
  const context = vm.createContext({ console, Buffer, JSON, Math, Date: fixedDate('2026-08-22'),
    String, Number, Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  const harness = install(context, [deck, wop], 'Deck List');
  const api = loadScript(context);
  api.repairHistoryColumn();
  checkTruthy('Repair from Deck List: preview opens',
    harness.dialogs.length === 1 && harness.dialogs[0].title === 'Repair History Column');
  api.applyHistoryColumnRepair();
  check('Repair from Deck List: moved', String(deck.values[3][13]), 'T1 08/10');
}

// 45. Column N being entirely empty makes getDataRange() stop at M.
{
  const deckValues = [
    ['Name', 'Current', '', '', '', '', '', '', '', '', '', '', 'History'],
    ...REPAIR_FILLER_ROWS,
    ['Jane Doe', 'T5', '', '', '', '', '', '', '', '', '', '', 'T1 08/10']]
    .map(r => { const row = r.slice(); while (row.length < 14) row.push(''); return row; });
  const deck = new FakeSheet('Deck List', deckValues);
  deck.getDataRange = function () {
    const Ctor = Object.getPrototypeOf(this.getRange(1, 1, 1, 1)).constructor;
    return new Ctor(this, 1, 1, this.values.length, 13);
  };
  const wop = new FakeSheet('Daily WOP', [new Array(11).fill('')], makeGrid(1, 11, '#ffffff'));
  wop.setSelection(1, 1);
  const context = vm.createContext({ console, Buffer, JSON, Math, Date: fixedDate('2026-08-22'),
    String, Number, Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(context, [deck, wop], 'Deck List');
  const api = loadScript(context);
  api.applyHistoryColumnRepair();
  check('Narrow range repair: landed in N', String(deck.values[3][13]), 'T1 08/10');
  check('Narrow range repair: no "undefined"',
    String(deck.values[3][13]).includes('undefined'), false);
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

// 48. Parsing the Instruction Manager table.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);

  // Mirrors the real column layout, including the ones we ignore.
  const ROSTER = `
    <table>
      <thead><tr>
        <th>Pin</th><th>Student Name</th><th>PK &amp; FO Answer Keys</th>
        <th>WOB<br>Answer Keys</th><th>Answer Key Decks</th><th>Duration</th>
        <th>DWP 2.0</th><th>Start/End Schoolwork</th><th>Out</th>
      </tr></thead>
      <tbody>
        <tr>
          <td>1234</td><td>Jane Doe</td><td>-</td><td>-</td><td>-</td><td>60</td>
          <td><a href="/DWP/Index?studentId=2942358&amp;attendanceId=86722299&amp;centerId=2514&amp;dwpEntryId=21711167">DWP 2.0</a></td>
          <td>3:30</td><td></td>
        </tr>
        <tr>
          <td>5678</td><td>John Roe</td><td>-</td><td>-</td><td>-</td><td>60</td>
          <td><a href="https://radius.mathnasium.com/DWP/Index?studentId=111&amp;attendanceId=222&amp;centerId=2514&amp;dwpEntryId=333">DWP 2.0</a></td>
          <td>4:00</td><td></td>
        </tr>
        <tr>
          <td>9999</td><td>Not Checkedin</td><td>-</td><td>-</td><td>-</td><td>60</td>
          <td></td><td></td><td></td>
        </tr>
      </tbody>
    </table>`;

  const roster = api.parseInstructionManager_(ROSTER);

  check('roster: counts links', [roster.withLink, roster.withoutLink], [2, 1]);
  check('roster: relative href made absolute',
    roster.byName['jane doe'].url,
    'https://radius.mathnasium.com/DWP/Index?studentId=2942358&attendanceId=86722299' +
    '&centerId=2514&dwpEntryId=21711167');
  check('roster: absolute href left alone',
    roster.byName['john roe'].url,
    'https://radius.mathnasium.com/DWP/Index?studentId=111&attendanceId=222' +
    '&centerId=2514&dwpEntryId=333');
  check('roster: student with no link is recorded but has no url',
    roster.byName['not checkedin'].url, null);
  check('roster: display name preserved', roster.byName['jane doe'].name, 'Jane Doe');
  checkTruthy('roster: header row is not treated as a student',
    roster.byName['student name'] === undefined);

  // Columns are found by header text, so reordering them changes nothing.
  const REORDERED = ROSTER
    .replace('<th>Student Name</th><th>PK &amp; FO Answer Keys</th>',
             '<th>PK &amp; FO Answer Keys</th><th>Student Name</th>')
    .replace(/<td>1234<\/td><td>Jane Doe<\/td><td>-<\/td>/,
             '<td>1234</td><td>-</td><td>Jane Doe</td>');
  check('roster: survives a reordered Student Name column',
    api.parseInstructionManager_(REORDERED).byName['jane doe'].url,
    roster.byName['jane doe'].url);

  // A page without the expected table should say so, not return nothing.
  let err = '';
  try { api.parseInstructionManager_('<div>no tables here</div>'); }
  catch (e) { err = e.message; }
  checkTruthy('roster: empty page explains itself', err.includes('No table rows'));

  err = '';
  try { api.parseInstructionManager_('<table><tr><td>a</td></tr></table>'); }
  catch (e) { err = e.message; }
  checkTruthy('roster: missing Student Name column explains itself',
    err.includes('Student Name'));
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

  check('link: found via onclick rather than href',
    api.findDwpLink_('<td onclick="go(\'/DWP/Index?studentId=5&attendanceId=6\')">x</td>'),
    'https://radius.mathnasium.com/DWP/Index?studentId=5&attendanceId=6');
  check('link: absent', api.findDwpLink_('<td>nothing</td>'), null);
}

// 50. Roster lookup failures distinguish "not checked in" from "no link yet".
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  const roster = { byName: {
    'jane doe': { name: 'Jane Doe', url: 'https://x/DWP/Index?a=1' },
    'no link': { name: 'No Link', url: null }
  } };

  check('lookup: found', api.lookupRosterEntry_(roster, 'JANE DOE').url,
    'https://x/DWP/Index?a=1');

  let err = '';
  try { api.lookupRosterEntry_(roster, 'Ghost Student'); } catch (e) { err = e.message; }
  checkTruthy('lookup: absent says check-in', err.includes('checked in'));

  err = '';
  try { api.lookupRosterEntry_(roster, 'No Link'); } catch (e) { err = e.message; }
  checkTruthy('lookup: no link says so', err.includes('no DWP 2.0 link'));
}

// 51. Extracting from a real DWP page. This one is a live session with
//     nothing filled in, so every field should come back empty rather than
//     throwing -- empty is a real answer here, a missing element is not.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  const LIVE = fs.readFileSync('tests/fixtures/dwp-live.html', 'utf8');
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
  const FILLED = fs.readFileSync('tests/fixtures/dwp-filled.html', 'utf8');
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
  const DONE = fs.readFileSync('tests/fixtures/dwp-complete.html', 'utf8');
  const LIVE = fs.readFileSync('tests/fixtures/dwp-live.html', 'utf8');
  const get = (key, html) => api.RADIUS_EXTRACTORS[key](html || DONE);

  // Boolean-ish answers write a bare Y, matching how column K is filled in by
  // hand. A No writes nothing at all rather than the word "No".
  check('flag: problem of the week done', get('problemOfTheWeekFlag'), 'Y');
  check('flag: finalized', get('finalizedFlag'), 'Y');
  // Y: EOD reads this as "advance the student's task".
  check('flag: deck needs update writes Y', get('deckNeedsUpdateFlag'), 'Y');
  check('flag: an answered-No is blank, not "No"',
    api.RADIUS_EXTRACTORS.deckNeedsUpdateFlag(
      fs.readFileSync('tests/fixtures/dwp-filled.html', 'utf8')), '');
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
      fs.readFileSync('tests/fixtures/dwp-filled.html', 'utf8')),
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
    const s = scenario([HEADER, ...REPAIR_FILLER_ROWS,
      ['Amalie Laz', '', '', '', '', '', '', '', '', '', '', '', '', '']],
      [{ name: 'Amalie Laz', status: existingStatus, statusBg: statusBg }],
      { start: 1, rows: 1 }, '2026-08-22');
    s.harness.scriptProps.RADIUS_COOKIE = 'session=abc';
    vm.runInContext(
      'CONFIG.RADIUS.INSTRUCTION_MANAGER_URL = "https://radius.mathnasium.com/IM";',
      s.context);
    const DONE = fs.readFileSync('tests/fixtures/dwp-complete.html', 'utf8');
    s.harness.fetchHandler.value = url => ({ code: 200, body:
      url.indexOf('/IM') !== -1
        ? '<table><tr><th>Student Name</th><th>DWP 2.0</th></tr>' +
          '<tr><td>Amalie Laz</td><td><a href="/DWP/Index?studentId=1">go</a></td></tr></table>'
        : DONE });
    s.api.importRadiusData();
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
    s.harness.dialogs[0].html.includes('already processed by EOD'));
  check('import into K: the rest of the row still imports',
    String(s.wop.values[0][7]), '33');

  // An EOD marker is reported rather than flattened.
  s = runImport('YYP - B empty?', '#ffff00');
  check('import into K: marker text survives', s.wopStatus(0), 'YYP - B empty?');
  checkTruthy('import into K: marker is explained',
    s.harness.dialogs[0].html.includes('EOD marker'));
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
    const s = scenario([HEADER, ...REPAIR_FILLER_ROWS,
      ['Amalie Laz', '', '', '', '', '', '', '', '', '', '', '', '', '']],
      [{ name: 'Amalie Laz' }], { start: 1, rows: 1 }, '2026-08-22');
    s.harness.scriptProps.RADIUS_COOKIE = 'session=abc';
    vm.runInContext(
      'CONFIG.RADIUS.INSTRUCTION_MANAGER_URL = "https://radius.mathnasium.com/IM";',
      s.context);

    const page = fs.readFileSync('tests/fixtures/dwp-complete.html', 'utf8')
      .replace(/id="SessionStartTime" name="SessionStartTime" type="text" value="[^"]*"/,
               'id="SessionStartTime" name="SessionStartTime" type="text" value="' +
               signInHtmlTime + '"')
      .replace(/id="SessionEndTime" name="SessionEndTime" type="text" value="[^"]*"/,
               'id="SessionEndTime" name="SessionEndTime" type="text" value="' +
               signOutHtmlTime + '"');

    s.harness.fetchHandler.value = url => ({ code: 200, body:
      url.indexOf('/IM') !== -1
        ? '<table><tr><th>Student Name</th><th>DWP 2.0</th></tr>' +
          '<tr><td>Amalie Laz</td><td><a href="/DWP/Index?studentId=1">go</a></td></tr></table>'
        : page });
    s.api.importRadiusData();
    return {
      L: String(s.wop.values[0][11]), Lbg: String(s.wop.backgrounds[0][11]),
      M: String(s.wop.values[0][12]), Mbg: String(s.wop.backgrounds[0][12]),
      P: String(s.wop.values[0][15]),
      html: s.harness.dialogs[0].html
    };
  }

  // A normal hour: times written, nothing shaded, the note left as Radius had it.
  let out = runTiming('10:48 AM', '11:48 AM');
  check('sheet: normal session writes both times', [out.L, out.M],
    ['10:48 AM', '11:48 AM']);
  check('sheet: normal session is not shaded', [out.Lbg, out.Mbg],
    ['#ffffff', '#ffffff']);
  check('sheet: normal session appends only the Mathlete score', out.P,
    'she doesnt shut up big L | MLS (3)');

  // A short, late, early session: shaded and annotated.
  out = runTiming('10:12 AM', '10:40 AM');
  check('sheet: odd length shades sign-in and sign-out',
    [out.Lbg, out.Mbg], ['#ff9900', '#ff9900']);
  check('sheet: notes append in order, score last', out.P,
    'she doesnt shut up big L | signed in 12 minutes late | ' +
    'left 20 minutes early | MLS (3)');
  checkTruthy('sheet: the report explains the shading',
    out.html.includes('neither about an hour nor about two'));

  // A double: not shaded, but noted.
  out = runTiming('10:00 AM', '11:50 AM');
  check('sheet: a double is not shaded', [out.Lbg, out.Mbg], ['#ffffff', '#ffffff']);
  check('sheet: a double is noted', out.P,
    'she doesnt shut up big L | 2 hour session | MLS (3)');

  // Odd length with nothing to explain it: shaded, note untouched.
  out = runTiming('10:00 AM', '11:20 AM');
  check('sheet: 80 minutes shades without a timing note',
    [out.Lbg, out.Mbg, out.P],
    ['#ff9900', '#ff9900', 'she doesnt shut up big L | MLS (3)']);

  // Still in the centre: no sign-out, so nothing is judged.
  out = runTiming('10:30 AM', '');
  check('sheet: no sign-out means no shading and no timing note',
    [out.M, out.Lbg, out.Mbg, out.P],
    ['', '#ffffff', '#ffffff', 'she doesnt shut up big L | MLS (3)']);
}

// 52i. The Mathlete score on the end of the note column.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  check('score: present on the completed page',
    api.RADIUS_EXTRACTORS.mathleteScore(
      fs.readFileSync('tests/fixtures/dwp-complete.html', 'utf8')), '3');
  check('score: absent on an untouched page',
    api.RADIUS_EXTRACTORS.mathleteScore(
      fs.readFileSync('tests/fixtures/dwp-live.html', 'utf8')), '');
}

// 52j. EOD runs the import first, then acts on what it wrote.
{
  function runEod(options) {
    const opts = options || {};
    const deckRows = [HEADER, ...REPAIR_FILLER_ROWS,
      ['Amalie Laz', 'Task One', '', '', 'Task Two, Task Three', '',
       '', '', '', '', '', '', '', '']];
    const s = scenario(deckRows,
      [{ name: 'Amalie Laz', status: opts.status === undefined ? '' : opts.status }],
      { start: 1, rows: 1 }, '2026-08-22');

    if (!opts.unconfigured) {
      s.harness.scriptProps.RADIUS_COOKIE = 'session=abc';
      vm.runInContext(
        'CONFIG.RADIUS.INSTRUCTION_MANAGER_URL = "https://radius.mathnasium.com/IM";',
        s.context);
    }
    if (opts.runOnEod === false) {
      vm.runInContext('CONFIG.RADIUS.RUN_ON_EOD = false;', s.context);
    }

    const page = fs.readFileSync('tests/fixtures/dwp-complete.html', 'utf8');
    s.harness.fetchHandler.value = url => ({ code: 200, body:
      url.indexOf('/IM') !== -1
        ? '<table><tr><th>Student Name</th><th>DWP 2.0</th></tr>' +
          '<tr><td>Amalie Laz</td><td><a href="/DWP/Index?studentId=1">go</a></td></tr></table>'
        : page });

    s.api.processWopToDeck();
    return s;
  }

  // The completed fixture reports a deck update, so the import writes Y into
  // column K and EOD then advances the student on the strength of it.
  let s = runEod();
  check('EOD+import: column K carries the imported Y', s.wopStatus(0), 'Y');
  check('EOD+import: and EOD marked it done', s.wopStatusBg(0), '#00ff00');
  check('EOD+import: the student was advanced', s.deckCell(4, C.CURRENT), 'Task Two');
  check('EOD+import: the finished task was archived',
    s.deckCell(4, C.ARCHIVE), 'Task One 08/22');
  check('EOD+import: the other columns landed too',
    [String(s.wop.values[0][7]), String(s.wop.values[0][11])], ['33', '10:48 AM']);
  check('EOD+import: notes and score reached column P',
    String(s.wop.values[0][15]), 'she doesnt shut up big L | MLS (3)');
  checkTruthy('EOD+import: the report counts the import',
    s.harness.dialogs[0].html.includes('Imported from Radius'));

  // An operator-typed P plus the imported Y means both happen in one pass.
  s = runEod({ status: 'P' });
  check('EOD+import: typed P and imported Y both act',
    [s.deckCell(4, C.CURRENT), s.deckCell(4, C.PINK)], ['Task Two', 'pink']);

  // Turned off, EOD behaves exactly as it did before.
  s = runEod({ runOnEod: false });
  check('RUN_ON_EOD off: nothing fetched', s.harness.fetchLog.length, 0);
  check('RUN_ON_EOD off: column K untouched', s.wopStatus(0), '');
  check('RUN_ON_EOD off: student not advanced', s.deckCell(4, C.CURRENT), 'Task One');

  // On but not set up: EOD still runs, and says why the import did not.
  s = runEod({ unconfigured: true });
  check('unconfigured: nothing fetched', s.harness.fetchLog.length, 0);
  checkTruthy('unconfigured: EOD says the import was skipped',
    s.harness.alerts.concat(s.harness.dialogs.map(d => d.html))
      .some(t => String(t).includes('Radius')));
  check('unconfigured: EOD did not invent a status', s.wopStatus(0), '');
}

// 53. A fully completed page. This is the one that exposed the textarea bug
//     and finally showed a switch set to Yes.
{
  const ctx = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(ctx, [], null);
  const api = loadScript(ctx);
  const DONE = fs.readFileSync('tests/fixtures/dwp-complete.html', 'utf8');
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

  const LIVE = fs.readFileSync('tests/fixtures/dwp-live.html', 'utf8');
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

// 53. All eight fields land in their configured columns, Q through X.
{
  const s = scenario([HEADER, ...REPAIR_FILLER_ROWS,
    ['Amalie Laz', '', '', '', '', '', '', '', '', '', '', '', '', '']],
    [{ name: '9:59 AM Amalie Laz' }], { start: 1, rows: 1 }, '2026-08-22');

  s.harness.scriptProps.RADIUS_COOKIE = 'session=abc';
  vm.runInContext('CONFIG.RADIUS.INSTRUCTION_MANAGER_URL = "https://radius.mathnasium.com/IM";',
    s.context);

  const LIVE = fs.readFileSync('tests/fixtures/dwp-live.html', 'utf8');
  s.harness.fetchHandler.value = url => ({ code: 200, body:
    url.indexOf('/IM') !== -1
      ? '<table><tr><th>Student Name</th><th>DWP 2.0</th></tr>' +
        '<tr><td>Amalie Laz</td><td><a href="/DWP/Index?studentId=1">go</a></td></tr></table>'
      : LIVE });

  s.api.importRadiusData();

  // F G H J K L M O P, zero-indexed.
  check('configured columns written',
    [5, 6, 7, 9, 10, 11, 12, 14, 15].map(c => String(s.wop.values[0][c])),
    ['', '', '', '', '', '9:59 AM', '', '', '']);
  checkTruthy('import reports every column it wrote',
    s.harness.dialogs[0].html.includes('F, G, H, J, K, L, M, O, P'));
}

// 54. A roster link pointing at the wrong student writes nothing.
{
  const s = scenario([HEADER, ...REPAIR_FILLER_ROWS,
    ['Jane Doe', '', '', '', '', '', '', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe' }], { start: 1, rows: 1 }, '2026-08-22');

  s.harness.scriptProps.RADIUS_COOKIE = 'session=abc';
  vm.runInContext('CONFIG.RADIUS.INSTRUCTION_MANAGER_URL = "https://radius.mathnasium.com/IM";',
    s.context);

  const LIVE = fs.readFileSync('tests/fixtures/dwp-live.html', 'utf8');
  s.harness.fetchHandler.value = url => ({ code: 200, body:
    url.indexOf('/IM') !== -1
      ? '<table><tr><th>Student Name</th><th>DWP 2.0</th></tr>' +
        '<tr><td>Jane Doe</td><td><a href="/DWP/Index?studentId=1">go</a></td></tr></table>'
      : LIVE });  // page is actually Amalie Laz

  s.api.importRadiusData();
  check('wrong student: nothing written to Q', String(s.wop.values[0][16]), '');
  checkTruthy('wrong student: explained',
    s.harness.dialogs[0].html.includes('instead'));
}


// 53. An unset Instruction Manager URL is reported, not fetched.
{
  const s = scenario([HEADER, ...REPAIR_FILLER_ROWS,
    ['Jane Doe', '', '', '', '', '', '', '', '', '', '', '', '', '']],
    [{ name: 'Jane Doe' }], { start: 1, rows: 1 }, '2026-08-22');
  s.harness.scriptProps.RADIUS_COOKIE = 'session=abc';
  vm.runInContext('CONFIG.RADIUS.INSTRUCTION_MANAGER_URL = "";', s.context);
  s.api.importRadiusData();
  check('unset roster URL: nothing fetched', s.harness.fetchLog.length, 0);
  checkTruthy('unset roster URL: says what to set',
    s.harness.dialogs[0].html.includes('INSTRUCTION_MANAGER_URL'));
}


// ==========================================================================
console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  failures.forEach(f => console.log('  FAIL ' + f + '\n'));
  process.exit(1);
}
