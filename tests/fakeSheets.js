/**
 * A minimal stand-in for the Apps Script Spreadsheet service, enough to run
 * Sod.gs and Eod.gs outside Google and assert on the resulting cell values.
 */
'use strict';

function makeGrid(rows, cols, fill) {
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) row.push(fill);
    grid.push(row);
  }
  return grid;
}

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.numRows; }
  getNumColumns() { return this.numCols; }
  _slice(grid) {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const row = [];
      for (let c = 0; c < this.numCols; c++) {
        row.push(grid[this.row - 1 + r][this.col - 1 + c]);
      }
      out.push(row);
    }
    return out;
  }
  _write(grid, block, label) {
    if (block.length !== this.numRows) {
      throw new Error(`${label}: expected ${this.numRows} rows, got ${block.length}`);
    }
    for (let r = 0; r < this.numRows; r++) {
      if (block[r].length !== this.numCols) {
        throw new Error(`${label}: expected ${this.numCols} cols, got ${block[r].length}`);
      }
      for (let c = 0; c < this.numCols; c++) {
        grid[this.row - 1 + r][this.col - 1 + c] = block[r][c];
        this.sheet.writeCount++;
      }
    }
  }
  getValues() { return this._slice(this.sheet.values); }
  setValues(block) { this._write(this.sheet.values, block, 'setValues'); return this; }
  getBackgrounds() { return this._slice(this.sheet.backgrounds); }
  getFontColors() { return this._slice(this.sheet.fontColors); }
  setFontColors(block) { this._write(this.sheet.fontColors, block, 'setFontColors'); return this; }
  setBackgrounds(block) { this._write(this.sheet.backgrounds, block, 'setBackgrounds'); return this; }
  getFormulas() {
    this.sheet.formulaReads = (this.sheet.formulaReads || 0) + 1;
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const row = [];
      for (let c = 0; c < this.numCols; c++) {
        const key = (this.row + r) + ':' + (this.col + c);
        row.push((this.sheet.formulas && this.sheet.formulas[key]) || '');
      }
      out.push(row);
    }
    return out;
  }
  getValue() { return this.sheet.values[this.row - 1][this.col - 1]; }
  setValue(v) { this.sheet.values[this.row - 1][this.col - 1] = v; this.sheet.writeCount++; return this; }
  setBackground(c) { this.sheet.backgrounds[this.row - 1][this.col - 1] = c; return this; }
  activate() {
    this.sheet.activeRange = this;
    this.sheet.activated = { row: this.row, col: this.col };
    return this;
  }
  /** Format-only copy, which is all the day-header row needs. */
  copyTo(target, options) {
    const opts = options || {};
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) {
        const from = { row: this.row - 1 + r, col: this.col - 1 + c };
        const to = { row: target.row - 1 + r, col: target.col - 1 + c };
        if (!this.sheet.backgrounds[to.row]) continue;
        this.sheet.backgrounds[to.row][to.col] =
          this.sheet.backgrounds[from.row][from.col];
        this.sheet.fontColors[to.row][to.col] =
          this.sheet.fontColors[from.row][from.col];
        if (!opts.formatOnly) {
          this.sheet.values[to.row][to.col] = this.sheet.values[from.row][from.col];
        }
      }
    }
    return this;
  }
  clearContent() {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) {
        this.sheet.values[this.row - 1 + r][this.col - 1 + c] = '';
      }
    }
    return this;
  }
}

class FakeSheet {
  constructor(name, values, backgrounds) {
    this.name = name;
    this.values = values;
    this.backgrounds = backgrounds || makeGrid(values.length, values[0].length, '#ffffff');
    this.fontColors = makeGrid(values.length, values[0].length, '#000000');
    this.activeRange = null;
    this.writeCount = 0;
  }
  getName() { return this.name; }
  getRange(row, col, numRows, numCols) {
    return new FakeRange(this, row, col, numRows === undefined ? 1 : numRows,
      numCols === undefined ? 1 : numCols);
  }
  getDataRange() {
    return new FakeRange(this, 1, 1, this.values.length, this.values[0].length);
  }
  getLastRow() {
    for (let r = this.values.length; r >= 1; r--) {
      if (this.values[r - 1].some(v => String(v).trim() !== '')) return r;
    }
    return 0;
  }
  getMaxColumns() { return this.values[0].length; }
  getMaxRows() { return this.values.length; }
  insertRowsAfter(row, howMany) {
    const width = this.values[0].length;
    for (let n = 0; n < howMany; n++) {
      this.values.splice(row + n, 0, new Array(width).fill(''));
      this.backgrounds.splice(row + n, 0, new Array(width).fill('#ffffff'));
      this.fontColors.splice(row + n, 0, new Array(width).fill('#000000'));
    }
    return this;
  }
  deleteColumn(col) {
    this.values.forEach(row => row.splice(col - 1, 1));
    this.backgrounds.forEach(row => row.splice(col - 1, 1));
    this.deletedColumns = (this.deletedColumns || []).concat([col]);
  }
  getLastColumn() { return this.values[0].length; }
  setSelection(row, numRows) {
    this.activeRange = new FakeRange(this, row, 1, numRows, 1);
  }
  getActiveRange() { return this.activeRange; }
  setActiveRange(range) {
    this.activeRange = range;
    this.activated = { row: range.row, col: range.col };
    return range;
  }
}

function install(globalObj, sheets, activeSheetName) {
  const byName = {};
  sheets.forEach(s => { byName[s.name] = s; });

  const dialogs = [];
  const alerts = [];
  const uiAnswer = { value: 'OK' };

  // ui.prompt(). `next` is what the person types; `button` is which one they
  // press. Both are read once and the text cleared, so a test that forgets to
  // set it gets an empty box rather than the previous test's answer.
  const promptAnswer = { next: '', button: 'OK' };
  const prompts = [];
  let lockHeld = false;

  const spreadsheet = {
    getSheetByName: n => byName[n] || null,
    getActiveSheet: () => byName[activeSheetName],
    getSpreadsheetTimeZone: () => 'America/New_York'
  };

  // A seating chart kept in a separate document is reached by id, so the fake
  // has to be able to hand one back rather than only the active spreadsheet.
  const booksById = {};

  const activatedSheets = [];
  globalObj.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
    setActiveSheet: sheet => { activatedSheets.push(sheet.getName()); return sheet; },
    openById: id => {
      if (!booksById[id]) {
        throw new Error('Unable to open the spreadsheet with id ' + id + '.');
      }
      return booksById[id];
    },
    getUi: () => ({
      createMenu: () => ({ addItem() { return this; }, addToUi() {} }),
      alert: (...args) => {
        alerts.push(args.length > 1 ? args.join(' | ') : args[0]);
        return args.length > 2 ? uiAnswer.value : undefined;
      },
      prompt: (...args) => {
        prompts.push(args.length > 1 ? args.join(' | ') : args[0]);
        const typed = promptAnswer.next;
        promptAnswer.next = '';
        return {
          getSelectedButton: () => promptAnswer.button,
          getResponseText: () => typed
        };
      },
      ButtonSet: { OK_CANCEL: 'OK_CANCEL' },
      Button: { OK: 'OK', CANCEL: 'CANCEL' },
      showModalDialog: (html, title) => dialogs.push({ title, html: html.content })
    })
  };

  globalObj.HtmlService = {
    createHtmlOutput: content => ({
      content,
      setWidth() { return this; },
      setHeight() { return this; }
    })
  };

  globalObj.LockService = {
    getDocumentLock: () => ({
      tryLock: () => { if (lockHeld) return false; lockHeld = true; return true; },
      releaseLock: () => { lockHeld = false; }
    })
  };

  const cache = {};
  // Apps Script rejects a non-numeric expiry outright rather than ignoring it,
  // so a mistyped CONFIG path reaching here is a runtime failure in the real
  // thing. A fake that shrugs at it hides exactly the bug it exists to catch.
  function checkTtl(method, shape, ttl, given) {
    if (!given) return;
    if (typeof ttl !== 'number' || isNaN(ttl)) {
      throw new Error('The parameters (' + shape +
        (ttl === undefined || ttl === null ? ',null' : ',' + typeof ttl) +
        ") don't match the method signature for CacheService.Cache." + method + '.');
    }
  }

  globalObj.CacheService = {
    getUserCache: () => ({
      put: function (k, v, ttl) {
        checkTtl('put', 'string,string', ttl, arguments.length > 2);
        cache[k] = v;
      },
      putAll: function (entries, ttl) {
        checkTtl('putAll', '(class)', ttl, arguments.length > 1);
        Object.keys(entries).forEach(k => { cache[k] = entries[k]; });
      },
      get: k => (k in cache ? cache[k] : null),
      remove: k => { delete cache[k]; },
      removeAll: keys => { keys.forEach(k => { delete cache[k]; }); }
    })
  };

  // --- UrlFetchApp -------------------------------------------------------
  const fetchLog = [];
  const fetchHandler = { value: null };
  globalObj.UrlFetchApp = {
    fetch: (url, params) => {
      fetchLog.push({ url, params });
      const res = fetchHandler.value ? fetchHandler.value(url, params) : {};
      return {
        getResponseCode: () => (res.code === undefined ? 200 : res.code),
        getContentText: () => (res.body === undefined ? '' : res.body)
      };
    }
  };

  // --- PropertiesService --------------------------------------------------
  const scriptProps = {};
  globalObj.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: k => (k in scriptProps ? scriptProps[k] : null),
      setProperty: (k, v) => { scriptProps[k] = v; },
      deleteProperty: k => { delete scriptProps[k]; }
    })
  };

  let uuid = 0;
  globalObj.Utilities = {
    sleep: () => {},
    getUuid: () => 'uuid-' + (++uuid),
    // Was a hard-coded '08/22', which happened to be right while EOD was the
    // only caller and only ever asked for MM/dd. Anything else got that same
    // string back, so a yyyy in the pattern came out as no year at all.
    formatDate: (date, timeZone, pattern) => {
      const d = date instanceof Date ? date : new Date();
      const pad = (n, width) => String(n).padStart(width, '0');
      return String(pattern)
        .replace(/yyyy/g, pad(d.getFullYear(), 4))
        .replace(/MM/g, pad(d.getMonth() + 1, 2))
        .replace(/dd/g, pad(d.getDate(), 2))
        .replace(/HH/g, pad(d.getHours(), 2))
        .replace(/mm/g, pad(d.getMinutes(), 2));
    },
    base64Encode: s => Buffer.from(s, 'utf8').toString('base64'),
    base64Decode: s => Buffer.from(s, 'base64'),
    newBlob: bytes => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
    Charset: { UTF_8: 'utf8' }
  };

  // SpreadsheetApp.getUi() is called fresh each time; Button/ButtonSet must
  // be reachable from the object the script actually holds.
  globalObj.SpreadsheetApp.getUi().Button = { OK: 'OK', CANCEL: 'CANCEL' };

  // --- CalendarApp --------------------------------------------------------
  // An event is {title, start, guests:[{name, email}]}. getEvents() windows on
  // the start time the way the real one does, so a test can put a session just
  // outside the window and see it left out.
  const calendars = {};
  let defaultCalendar = null;

  const makeEvent = e => ({
    getTitle: () => e.title,
    getStartTime: () => e.start,
    isAllDayEvent: () => !!e.allDay,
    getGuestList: () => {
      if (e.guestsThrow) throw new Error('No access to the guest list.');
      return (e.guests || []).map(g => ({
        getName: () => g.name || '',
        getEmail: () => g.email || ''
      }));
    }
  });

  const makeCalendar = (id, name, events) => ({
    getId: () => id,
    getName: () => name,
    getEventsForDay: day => (events || [])
      .filter(e => e.start.getFullYear() === day.getFullYear() &&
                   e.start.getMonth() === day.getMonth() &&
                   e.start.getDate() === day.getDate())
      .map(e => makeEvent(e)),
    getEvents: (from, to) => (events || [])
      .filter(e => e.start >= from && e.start < to)
      .map(e => ({
        getTitle: () => e.title,
        getStartTime: () => e.start,
        getGuestList: () => {
          if (e.guestsThrow) throw new Error('No access to the guest list.');
          return (e.guests || []).map(g => ({
            getName: () => g.name || '',
            getEmail: () => g.email || ''
          }));
        }
      }))
  });

  const addCalendar = (id, name, events, asDefault) => {
    const calendar = makeCalendar(id, name, events);
    calendars[id] = calendar;
    if (asDefault) defaultCalendar = calendar;
    return calendar;
  };

  globalObj.CalendarApp = {
    getDefaultCalendar: () => defaultCalendar,
    getCalendarById: id => calendars[id] || null,
    getAllCalendars: () => {
      if (globalObj.__calendarsThrow) throw new Error('No calendar access.');
      return Object.keys(calendars).map(id => calendars[id]);
    }
  };

  // Register an extra spreadsheet that openById can find.
  const addBook = (id, bookSheets, bookName) => {
    booksById[id] = {
      getName: () => bookName || id,
      getSheets: () => bookSheets.slice(),
      getSheetByName: name => bookSheets.filter(sh => sh.getName() === name)[0] || null,
      getSpreadsheetTimeZone: () => 'UTC'
    };
  };

  return { dialogs, alerts, uiAnswer, promptAnswer, prompts, fetchLog,
    fetchHandler, scriptProps, addBook, addCalendar, activatedSheets,
    sheets: byName };
}

/** A Date whose no-arg constructor returns a fixed instant. */
// `tickMs` advances the clock a little on every reading, for the one thing a
// frozen clock cannot show: a run that takes too long. The default of 0 leaves
// every other test looking at a single fixed instant.
function fixedDate(iso, tickMs) {
  const pinned = new Date(iso + 'T12:00:00').getTime();
  const step = tickMs || 0;
  let elapsed = 0;
  return class PinnedDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(pinned + elapsed); else super(...args);
    }
    static now() { elapsed += step; return pinned + elapsed; }
  };
}

module.exports = { FakeSheet, makeGrid, install, fixedDate };
