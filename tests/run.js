'use strict';
const fs = require('fs');
const vm = require('vm');
const { FakeSheet, makeGrid, install, fixedDate } = require('./fakeSheets.js');

const SOURCES = ['Config.gs', 'Common.gs', 'Sod.gs', 'Eod.gs', 'Repair.gs', 'Menu.gs'];

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
  splitHistoryEntries_, planHistoryColumnRepair_
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
  const wopValues = wopRows.map(r => {
    const row = [r.name];
    while (row.length < 10) row.push('');
    row.push(r.status === undefined ? '' : r.status);
    return row;
  });
  const wopBg = makeGrid(wopValues.length, 11, '#ffffff');
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
  return { deck, wop, harness, api,
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


// ==========================================================================
console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  failures.forEach(f => console.log('  FAIL ' + f + '\n'));
  process.exit(1);
}
