'use strict';
const fs = require('fs');
const vm = require('vm');
const { FakeSheet, makeGrid, install } = require('./fakeSheets.js');

const SOURCES = ['Config.gs', 'Common.gs', 'Sod.gs', 'Eod.gs', 'Menu.gs'];

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
  escapeHtml_, processWopToDeck, processSodPinks, executeSodOperations_FromUI
};`;
  vm.runInContext(source, context);
  return context.__api;
}

function scenario(deckRows, wopRows, selection) {
  const deckValues = deckRows.map(r => {
    const row = r.slice();
    while (row.length < 13) row.push('');
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

  const context = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
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
const HEADER = ['Name', 'Current', 'Pink', '', 'Loaded', 'Queue', '', '', '', '', '', '', 'Archive'];
const C = { NAME: 1, CURRENT: 2, PINK: 3, LOADED: 5, QUEUE: 6, ARCHIVE: 13 };

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
  const context = vm.createContext({ console, Buffer, JSON, Math, Date, String, Number,
    Object, Array, RegExp, Error, isNaN, parseInt, parseFloat });
  install(context, [deck, wop], 'Daily WOP');
  const api = loadScript(context);
  api.processWopToDeck();
  check('EOD narrow deck: archive written cleanly',
    String(deck.values[1][12]), 'T1 08/22');
  check('EOD narrow deck: no "undefined" leaked into padded cells',
    String(deck.values[1][11]), '');
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
    .map(r => { const row = r.slice(); while (row.length < 13) row.push(''); return row; });
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

// ==========================================================================
console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  failures.forEach(f => console.log('  FAIL ' + f + '\n'));
  process.exit(1);
}
