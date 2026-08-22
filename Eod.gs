/**
 * EOD: Colored Sheets Batch Process.
 *
 * Reads the letters in Column K of the highlighted Daily WOP rows and applies
 * them to the Deck List. Each Y advances the student one task (Column B is
 * archived to Column M, and the next item in Column E takes its place).
 * A P marks the student pink in Column C.
 *
 * Column K always describes the work still outstanding. When a row finishes,
 * it goes green and is skipped by later runs. When it cannot finish, the
 * letters left in the cell are exactly what a re-run should do.
 */
function processWopToDeck() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    showError_('Someone else is running a batch on this spreadsheet right now. ' +
      'Wait for them to finish and try again.');
    return;
  }

  let sheets;
  let selection;
  let deck;
  let nameCol;
  let statusCol;

  try {
    sheets = getSheets_();
    selection = getSelection_(sheets.wop);
  } catch (err) {
    lock.releaseLock();
    showError_(err.message);
    return;
  }

  const log = ActionLog_();
  const stats = { students: 0, yActions: 0, pActions: 0, skipped: 0 };
  const dateStr = Utilities.formatDate(
    new Date(), sheets.ss.getSpreadsheetTimeZone(), CONFIG.DATE_FORMAT);

  try {
    nameCol = WopColumn_(sheets.wop, selection.startRow, selection.numRows, CONFIG.WOP_COL.NAME);
    statusCol = WopColumn_(sheets.wop, selection.startRow, selection.numRows, CONFIG.WOP_COL.STATUS);
    deck = DeckTable_(sheets.deck);

    for (let i = 0; i < selection.numRows; i++) {
      // Green means the paperwork is already done.
      if (isDoneColor_(statusCol.background(i))) {
        stats.skipped++;
        continue;
      }

      const status = parseStatus_(statusCol.value(i));
      if (!status) continue;

      const sheetRow = selection.startRow + i;
      const rawStatus = String(statusCol.value(i)).trim();
      const name = extractName_(nameCol.value(i));

      if (!name) {
        statusCol.setBackground(i, CONFIG.COLOR.ERROR);
        log.error('Row ' + sheetRow,
          'Column K says "' + rawStatus + '" but Column A has no student name.');
        continue;
      }

      const hit = deck.find(name);
      if (!hit) {
        statusCol.setBackground(i, CONFIG.COLOR.ERROR);
        log.error(name, 'is not on the Deck List, so nothing was applied.');
        continue;
      }
      if (hit.duplicate) {
        statusCol.setBackground(i, CONFIG.COLOR.ERROR);
        log.error(name, 'appears on the Deck List more than once. Remove the ' +
          'duplicate so the script knows which row to update.');
        continue;
      }

      const row = hit.row;

      if (status.pCount > 1) {
        log.warn(name, 'Column K contained ' + status.pCount +
          ' P\'s ("' + rawStatus + '"); only one pink was applied.');
      }

      let current = deck.get(row, CONFIG.DECK_COL.CURRENT);

      // Nothing to advance: leave the whole row untouched, including the P,
      // so a re-run after Column B is filled in does the complete job.
      if (status.yCount > 0 && !current) {
        statusCol.setValue(i, status.core + ' - B empty?');
        statusCol.setBackground(i, CONFIG.COLOR.WARN);
        log.warn(name, 'Column B is empty, so nothing was applied' +
          (status.pCount > 0 ? ' (the pink is still pending too)' : '') +
          '. Fill in Column B and run this again.');
        continue;
      }

      const queue = splitList_(deck.get(row, CONFIG.DECK_COL.LOADED));
      let archive = deck.get(row, CONFIG.DECK_COL.ARCHIVE);
      const completed = [];

      for (let y = 0; y < status.yCount; y++) {
        if (!current) break;
        completed.push(current);
        archive = archive
          ? archive + CONFIG.ARCHIVE_SEPARATOR + current + ' ' + dateStr
          : current + ' ' + dateStr;
        current = queue.length ? queue.shift() : '';
      }

      if (status.yCount > 0) {
        deck.set(row, CONFIG.DECK_COL.CURRENT, current);
        deck.set(row, CONFIG.DECK_COL.LOADED, queue.join(', '));
        deck.set(row, CONFIG.DECK_COL.ARCHIVE, archive);
        stats.yActions += completed.length;
        log.ok(name, 'finished "' + completed.join(', ') + '" and is now on "' +
          (current || 'nothing — Column E was empty') + '".');
      }

      if (status.pCount > 0) {
        deck.set(row, CONFIG.DECK_COL.PINK, CONFIG.PINK_VALUE);
        stats.pActions++;
        log.ok(name, 'was marked pink in Column C.');
      }

      const remaining = status.yCount - completed.length;
      if (remaining > 0) {
        // Record what is still owed, not what was done -- otherwise a re-run
        // would advance the student all over again.
        statusCol.setValue(i, 'Y'.repeat(remaining) +
          ' (' + completed.length + ' of ' + status.yCount + ' done, ran out)');
        statusCol.setBackground(i, CONFIG.COLOR.WARN);
        log.warn(name, 'ran out of tasks after ' + completed.length + ' of ' +
          status.yCount + '. Column K now shows the ' + remaining +
          ' still to do; top up Column B or E and run this again.');
      } else {
        statusCol.setValue(i, status.core);
        statusCol.setBackground(i, CONFIG.COLOR.DONE);
      }

      stats.students++;
    }
  } catch (err) {
    log.error('Run stopped', 'Unexpected error: ' + err.message +
      ' Everything completed before this point has been saved.');
  } finally {
    // Saved even on failure: each student is finished before the next begins,
    // so whatever is buffered is internally consistent.
    try {
      if (deck) deck.flush();
      if (statusCol) statusCol.flush();
    } catch (flushErr) {
      log.error('Save failed', 'Could not write changes back: ' + flushErr.message);
    }
    lock.releaseLock();
  }

  if (log.isEmpty()) {
    showError_('EOD complete. Nothing in the highlighted selection needed processing' +
      (stats.skipped ? ' (' + stats.skipped + ' already marked green).' : '.'));
    return;
  }

  showReport_('EOD Complete', '📊 EOD Summary', [
    { label: 'Students processed', value: stats.students },
    { label: "Total 'Y' actions", value: stats.yActions },
    { label: "Total 'P' actions", value: stats.pActions },
    { label: 'Already green (skipped)', value: stats.skipped },
    { label: 'Needs attention', value: log.issueCount(), alert: log.issueCount() > 0 }
  ], log);
}
