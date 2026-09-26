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
 *
 * A finished task that is a checkup or a progress check (CU1, PCU6, 2nd PC2, PC A1A --
 * CONFIG.CHANGELOG.FROM_EOD) also gets the student a new row on the Deck
 * Changelog, dated today with their next session filled in. Only once the
 * Deck List has been saved, so the changelog never records a task the Deck
 * List does not.
 *
 * Then, for the same rows, attendance: column A goes green or orange from
 * Radius's sign-ins (CONFIG.RADIUS.ATTENDANCE.IN_EOD), and anybody Radius has
 * no match for is listed in a warning above the report.
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
  const stats = { students: 0, yActions: 0, pActions: 0, skipped: 0, changelog: 0 };
  const forChangelog = [];
  let saved = false;
  let attendanceWarning = '';
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

      const sheetRow = selection.startRow + i;
      const rawStatus = String(statusCol.value(i)).trim();
      const status = parseStatus_(statusCol.value(i));

      if (!status) {
        // An empty cell is a row with nothing to do. A cell with something in
        // it that is not a Y/P instruction is a typo, and skipping it without
        // a word lets "YU" pass for a finished row -- the report would say
        // nothing needed processing, and whoever typed it would believe that.
        if (rawStatus) {
          statusCol.setBackground(i, CONFIG.COLOR.ERROR);
          log.error('Row ' + sheetRow, 'Column K says "' + rawStatus +
            '", which is not a Y/P instruction. Nothing was applied.');
        }
        continue;
      }

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

      // A cell holds fifty thousand characters and no more. A history that
      // has reached it would make the write throw, and a throw partway through
      // a flush leaves the Deck List half-applied. Better to stop this one
      // student with the instruction intact than to risk the whole batch.
      if (status.yCount > 0 && String(archive).length > CONFIG.MAX_CELL_CHARS) {
        statusCol.setValue(i, status.core + ' - history full');
        statusCol.setBackground(i, CONFIG.COLOR.ERROR);
        log.error(name, 'Column ' + columnLetter_(CONFIG.DECK_COL.ARCHIVE) +
          ' has run out of room — a cell holds about ' + CONFIG.MAX_CELL_CHARS +
          ' characters and this history is at ' + String(archive).length +
          '. Nothing was applied. Move the older entries somewhere else and ' +
          'run this again.');
        continue;
      }

      if (status.yCount > 0) {
        deck.set(row, CONFIG.DECK_COL.CURRENT, current);
        deck.set(row, CONFIG.DECK_COL.LOADED, queue.join(', '));
        deck.set(row, CONFIG.DECK_COL.ARCHIVE, archive);
        stats.yActions += completed.length;
        log.ok(name, 'finished "' + completed.join(', ') + '" and is now on "' +
          (current || 'nothing — Column E was empty') + '".');
        completed.forEach(function (task) {
          if (isChangelogTask_(task)) forChangelog.push({ name: name, task: task });
        });
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
      saved = true;
    } catch (flushErr) {
      log.error('Save failed', 'Could not write changes back: ' + flushErr.message);
    }

    // Still inside the lock, and only after the Deck List is saved: a
    // changelog row for a task the Deck List never recorded as finished would
    // be the one record that disagrees with the rest.
    if (saved) {
      try {
        stats.changelog = addChangelogEntries_(forChangelog, log);
      } catch (clErr) {
        log.error('Deck Changelog', 'Could not add ' + forChangelog.length +
          ' row(s): ' + clErr.message + ' The Deck List itself was saved.');
      }
    } else if (forChangelog.length) {
      log.error('Deck Changelog', 'Nothing was added, because the Deck List ' +
        'could not be saved.');
    }

    // Attendance for the same rows, still inside the lock. The Deck List is
    // saved by now, so nothing Radius does here can undo any of it.
    const attendance = CONFIG.RADIUS.ATTENDANCE;
    if (saved && attendance && attendance.IN_EOD) {
      if (typeof attendanceForEod_ !== 'function') {
        log.warn('Attendance', 'not checked: Attendance.gs is not in this ' +
          'spreadsheet\'s script. Copy it in from the repo.');
      } else {
        try {
          attendanceWarning = attendanceForEod_(sheets.wop, selection, log);
        } catch (attErr) {
          log.error('Attendance', 'Could not be checked: ' + attErr.message +
            ' The Deck List itself was saved.');
        }
      }
    }
    lock.releaseLock();
  }

  if (log.isEmpty()) {
    showError_('EOD complete. Nothing in the highlighted selection needed processing' +
      (stats.skipped ? ' (' + stats.skipped + ' already marked green).' : '.'));
    return;
  }

  const summary = [];
  summary.push(
    { label: 'Students processed', value: stats.students },
    { label: "Total 'Y' actions", value: stats.yActions },
    { label: "Total 'P' actions", value: stats.pActions },
    { label: 'Already green (skipped)', value: stats.skipped },
    { label: 'Deck Changelog rows added', value: stats.changelog },
    { label: 'Needs attention', value: log.issueCount(), alert: log.issueCount() > 0 });

  showReport_('EOD Complete', '📊 EOD Summary', summary, log, attendanceWarning);
}
