/**
 * SOD: Pinks Printed.
 *
 * Walks the highlighted Daily WOP rows, finds the students flagged pink on the
 * Deck List, and moves the front of their Column F queue into Column E.
 *
 * The run happens in two phases. The first phase only reads: it works out what
 * would happen and, if any student needs a judgement call, asks for it in a
 * single dialog. Nothing is written to either sheet until the operator
 * confirms, so closing the dialog leaves the spreadsheet exactly as it was.
 */
function processSodPinks() {
  let sheets;
  let selection;
  try {
    sheets = getSheets_();
    selection = getSelection_(sheets.wop);
  } catch (err) {
    showError_(err.message);
    return;
  }

  const nameCol = WopColumn_(sheets.wop, selection.startRow, selection.numRows, CONFIG.WOP_COL.NAME);
  const deck = DeckTable_(sheets.deck);

  const plan = {
    startRow: selection.startRow,
    numRows: selection.numRows,
    moves: [],
    problems: [],
    notPink: 0,
    alreadyDone: 0
  };

  for (let i = 0; i < selection.numRows; i++) {
    if (isDoneColor_(nameCol.background(i))) {
      plan.alreadyDone++;
      continue;
    }

    const name = extractName_(nameCol.value(i));
    if (!name) continue;

    const hit = deck.find(name);
    if (!hit) {
      plan.problems.push({ index: i, name: name, message: 'is not on the Deck List.' });
      continue;
    }
    if (hit.duplicate) {
      plan.problems.push({ index: i, name: name,
        message: 'appears on the Deck List more than once. Remove the duplicate ' +
          'so the script knows which row to update.' });
      continue;
    }

    const row = hit.row;
    if (deck.get(row, CONFIG.DECK_COL.PINK).toLowerCase() !== CONFIG.PINK_VALUE) {
      plan.notPink++;
      continue;
    }

    if (deck.get(row, CONFIG.DECK_COL.LOADED) !== '') {
      plan.problems.push({ index: i, name: name,
        message: 'cannot print — Column E already has something in it.' });
      continue;
    }

    const queue = splitList_(deck.get(row, CONFIG.DECK_COL.QUEUE));
    if (!queue.length) {
      plan.problems.push({ index: i, name: name,
        message: 'cannot print — the Column F queue is empty.' });
      continue;
    }

    // Routing. Two or more SD items means the split point is unambiguous:
    // move everything up to and including the first SD. A single item is
    // likewise obvious. Anything else is a judgement call for the operator.
    const sdIndexes = [];
    queue.forEach(function (item, idx) {
      if (/^SD\d+/i.test(item)) sdIndexes.push(idx);
    });

    const move = { index: i, name: name, deckRow: row, queue: queue };
    if (sdIndexes.length > 1) {
      move.itemsToMove = sdIndexes[0] + 1;
      move.needsPrompt = false;
    } else if (queue.length > 1) {
      move.itemsToMove = 1;
      move.needsPrompt = true;
    } else {
      move.itemsToMove = 1;
      move.needsPrompt = false;
    }
    plan.moves.push(move);
  }

  const needsPrompt = plan.moves.some(function (move) { return move.needsPrompt; });
  if (needsPrompt) {
    showSodPromptDialog_(plan);
  } else {
    executeSodPlan_(plan);
  }
}

/**
 * Asks how many queue items to move for each student the script cannot decide
 * for. The plan is parked in the cache and only a token travels to the
 * browser, so the dialog cannot be used to rewrite what the run will do.
 */
function showSodPromptDialog_(plan) {
  const token = Utilities.getUuid();
  CacheService.getUserCache().put(
    'sodPlan_' + token, JSON.stringify(plan), CONFIG.CACHE_TTL_SECONDS);

  let html = '<div style="font-family: Arial, sans-serif; padding: 10px; color: #1e293b;">' +
    '<h3 style="margin-top: 0;">How many items should move?</h3>' +
    '<p style="font-size: 13px; color: #4b5563;">Nothing has been changed yet. ' +
    'These students have more than one thing waiting in Column F:</p>' +
    '<form id="sodForm">' +
    '<input type="hidden" name="token" value="' + escapeHtml_(token) + '">';

  plan.moves.forEach(function (move, index) {
    if (!move.needsPrompt) return;
    // Items are escaped individually so the separator can stay as markup.
    const list = move.queue.map(function (item, n) {
      return (n + 1) + '. ' + escapeHtml_(item);
    }).join(' &nbsp;·&nbsp; ');

    html += '<div style="margin-bottom: 12px; padding: 10px; border: 1px solid #e5e7eb; ' +
      'border-radius: 6px; background: #f9fafb;">' +
      '<div style="font-weight: bold; margin-bottom: 4px;">' + escapeHtml_(move.name) + '</div>' +
      '<div style="font-size: 12px; color: #6b7280; margin-bottom: 8px;">' +
      list + '</div>' +
      '<label style="font-size: 14px;">Move the first </label>' +
      '<input type="number" name="move_' + index + '" min="1" max="' + move.queue.length +
      '" value="1" style="width: 55px; padding: 4px; border: 1px solid #d1d5db; border-radius: 4px;">' +
      '<span style="font-size: 14px;"> of ' + move.queue.length + '</span>' +
      '</div>';
  });

  const autoMoves = plan.moves.filter(function (move) { return !move.needsPrompt; });
  if (autoMoves.length) {
    html += '<div style="font-size: 12px; color: #6b7280; margin: 14px 0;">' +
      'Also moving automatically: ' +
      autoMoves.map(function (move) {
        return escapeHtml_(move.name) + ' (' + move.itemsToMove + ')';
      }).join(', ') + '</div>';
  }
  if (plan.problems.length) {
    html += '<div style="font-size: 12px; color: #b45309; margin: 14px 0;">' +
      plan.problems.length + ' row(s) cannot be processed and will be flagged red.</div>';
  }

  html += '<div id="err" style="display: none; margin: 10px 0; padding: 8px; ' +
    'background: #fef2f2; border: 1px solid #fecaca; border-radius: 4px; ' +
    'color: #b91c1c; font-size: 13px;"></div>' +
    '<button type="button" id="go" onclick="submitForm()" style="width: 100%; padding: 10px; ' +
    'background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer; ' +
    'font-weight: bold;">Process</button>' +
    '<button type="button" id="cancel" onclick="google.script.host.close()" ' +
    'style="width: 100%; padding: 8px; margin-top: 6px; background: none; color: #6b7280; ' +
    'border: none; cursor: pointer; font-size: 13px;">Cancel — nothing will change</button>' +
    '</form>' +
    '<script>' +
    'function submitForm() {' +
    '  var go = document.getElementById("go");' +
    '  var cancel = document.getElementById("cancel");' +
    '  var err = document.getElementById("err");' +
    '  err.style.display = "none";' +
    '  go.disabled = true; cancel.disabled = true;' +
    '  go.textContent = "Processing..."; go.style.background = "#9ca3af";' +
    '  google.script.run' +
    '    .withFailureHandler(function (e) {' +
    '      go.disabled = false; cancel.disabled = false;' +
    '      go.textContent = "Process"; go.style.background = "#2563eb";' +
    '      err.textContent = "Nothing was changed. " + (e && e.message ? e.message : e);' +
    '      err.style.display = "block";' +
    '    })' +
    '    .executeSodOperations_FromUI(document.getElementById("sodForm"));' +
    '}' +
    '</script></div>';

  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(430).setHeight(520), 'Action Required');
}

/**
 * Callback from the dialog. Pulls the parked plan back out of the cache and
 * applies the operator's numbers to it.
 */
function executeSodOperations_FromUI(formObject) {
  const cache = CacheService.getUserCache();
  const key = 'sodPlan_' + formObject.token;
  const stored = cache.get(key);

  if (!stored) {
    throw new Error('This dialog has expired. Re-run "Pinks Printed" from the SOD menu.');
  }
  cache.remove(key);

  const plan = JSON.parse(stored);
  plan.moves.forEach(function (move, index) {
    if (!move.needsPrompt) return;
    const entered = parseInt(formObject['move_' + index], 10);
    move.itemsToMove = isNaN(entered) ? 1 : entered;
  });

  executeSodPlan_(plan);
}

/**
 * Applies the plan. The Deck List is re-read here rather than trusted from the
 * planning phase, so a row that moved or changed while the dialog was open is
 * caught instead of being written over.
 */
function executeSodPlan_(plan) {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    throw new Error('Someone else is running a batch on this spreadsheet right now.');
  }

  const log = ActionLog_();
  const stats = { pinkStudents: plan.moves.length, tasksMoved: 0 };
  let deck;
  let nameCol;

  try {
    const sheets = getSheets_();
    nameCol = WopColumn_(sheets.wop, plan.startRow, plan.numRows, CONFIG.WOP_COL.NAME);
    deck = DeckTable_(sheets.deck);

    plan.problems.forEach(function (problem) {
      nameCol.setBackground(problem.index, CONFIG.COLOR.ERROR);
      log.error(problem.name, problem.message);
    });

    plan.moves.forEach(function (move) {
      const row = move.deckRow;

      if (deck.nameAt(row).toLowerCase() !== move.name.toLowerCase()) {
        log.error(move.name, 'was skipped — the Deck List changed while the dialog ' +
          'was open (row ' + row + ' now holds "' + deck.nameAt(row) + '").');
        return;
      }
      if (deck.get(row, CONFIG.DECK_COL.PINK).toLowerCase() !== CONFIG.PINK_VALUE) {
        log.error(move.name, 'was skipped — the pink flag in Column C was cleared ' +
          'while the dialog was open.');
        return;
      }
      if (deck.get(row, CONFIG.DECK_COL.LOADED) !== '') {
        log.error(move.name, 'was skipped — something was put into Column E while ' +
          'the dialog was open.');
        return;
      }

      const queue = splitList_(deck.get(row, CONFIG.DECK_COL.QUEUE));
      if (queue.join('|') !== move.queue.join('|')) {
        log.error(move.name, 'was skipped — the Column F queue changed while the ' +
          'dialog was open. Run "Pinks Printed" again for this student.');
        return;
      }

      // Guard both ends: the dialog's min/max are advisory only.
      const itemsToMove = Math.max(1, Math.min(move.itemsToMove, queue.length));
      const moved = queue.splice(0, itemsToMove);

      deck.set(row, CONFIG.DECK_COL.LOADED, moved.join(', '));
      deck.set(row, CONFIG.DECK_COL.QUEUE, queue.join(', '));
      deck.set(row, CONFIG.DECK_COL.PINK, '');

      nameCol.setBackground(move.index, CONFIG.COLOR.DONE);
      stats.tasksMoved += moved.length;
      log.ok(move.name, 'loaded "' + moved.join(', ') + '" into Column E' +
        (queue.length ? ' (' + queue.length + ' still queued)' : ' (queue now empty)') +
        ' and the pink flag was cleared.');
    });
  } catch (err) {
    log.error('Run stopped', 'Unexpected error: ' + err.message +
      ' Everything completed before this point has been saved.');
  } finally {
    try {
      if (deck) deck.flush();
      if (nameCol) nameCol.flush();
    } catch (flushErr) {
      log.error('Save failed', 'Could not write changes back: ' + flushErr.message);
    }
    lock.releaseLock();
  }

  if (log.isEmpty()) {
    showError_('SOD complete. No pink students were found in the highlighted selection' +
      (plan.notPink ? ' (' + plan.notPink + ' matched but were not marked pink).' : '.'));
    return;
  }

  showReport_('SOD Complete', '📊 SOD Summary', [
    { label: 'Students with pinks', value: stats.pinkStudents },
    { label: 'Total tasks moved', value: stats.tasksMoved },
    { label: 'Matched but not pink', value: plan.notPink },
    { label: 'Already green (skipped)', value: plan.alreadyDone },
    { label: 'Needs attention', value: log.issueCount(), alert: log.issueCount() > 0 }
  ], log);
}
