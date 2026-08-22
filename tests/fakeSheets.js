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
  clearContent() { this.sheet.values[this.row - 1][this.col - 1] = ''; return this; }
}

class FakeSheet {
  constructor(name, values, backgrounds) {
    this.name = name;
    this.values = values;
    this.backgrounds = backgrounds || makeGrid(values.length, values[0].length, '#ffffff');
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
  setSelection(row, numRows) {
    this.activeRange = new FakeRange(this, row, 1, numRows, 1);
  }
  getActiveRange() { return this.activeRange; }
}

function install(globalObj, sheets, activeSheetName) {
  const byName = {};
  sheets.forEach(s => { byName[s.name] = s; });

  const dialogs = [];
  const alerts = [];
  let lockHeld = false;

  const spreadsheet = {
    getSheetByName: n => byName[n] || null,
    getActiveSheet: () => byName[activeSheetName],
    getSpreadsheetTimeZone: () => 'America/New_York'
  };

  globalObj.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
    getUi: () => ({
      createMenu: () => ({ addItem() { return this; }, addToUi() {} }),
      alert: msg => alerts.push(msg),
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
  globalObj.CacheService = {
    getUserCache: () => ({
      put: (k, v) => { cache[k] = v; },
      get: k => (k in cache ? cache[k] : null),
      remove: k => { delete cache[k]; }
    })
  };

  let uuid = 0;
  globalObj.Utilities = {
    getUuid: () => 'uuid-' + (++uuid),
    formatDate: () => '08/22',
    base64Encode: s => Buffer.from(s, 'utf8').toString('base64'),
    base64Decode: s => Buffer.from(s, 'base64'),
    Charset: { UTF_8: 'utf8' }
  };

  return { dialogs, alerts, sheets: byName };
}

module.exports = { FakeSheet, makeGrid, install };
