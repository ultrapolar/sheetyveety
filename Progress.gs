/**
 * Drafting a progress report.
 *
 * A progress report wants two lists of topics: a few the student has already
 * mastered, and a few they are about to work on. Highlight the names, run
 * this, and it puts a draft on screen ready to copy out. It writes nothing to
 * any sheet.
 *
 * The two lists do not come from the same place, and only one of them can be
 * had today:
 *
 *   - What they are working on next is the deck queue -- column B and then
 *     column E of the Deck List -- which is real and here already.
 *   - What they have mastered is the per-topic breakdown of an assessment,
 *     which lives on a Radius page nobody has sent me yet. Both unknowns are
 *     marked NEEDS HTML below.
 *
 * Where a list comes up short the draft says so in the text itself rather than
 * quietly handing over three topics where four were asked for. A gap you can
 * see is a gap you can fill; a gap you cannot see gets sent to a parent.
 */

// ------------------------------------------------------------------
// Who the report is for
// ------------------------------------------------------------------

/**
 * Which column holds the student's name on a given sheet.
 *
 * You reach for a progress report from wherever you happen to be -- the day's
 * WOP, the Deck List, the changelog -- so the name is looked for in whichever
 * column that sheet keeps it in. Returns 0 for a sheet that has no such column.
 */
function nameColumnFor_(sheetName) {
  if (sheetName === CONFIG.SHEETS.WOP) return CONFIG.WOP_COL.NAME;
  if (sheetName === CONFIG.SHEETS.DECK) return CONFIG.DECK_COL.NAME;
  if (sheetName === CONFIG.CHANGELOG.SHEET_NAME) return CONFIG.CHANGELOG.COL.STUDENT;
  return 0;
}

/**
 * The students named in the highlighted rows, in the order they appear.
 *
 * One student highlighted twice -- two hourly rows on the Daily WOP, say --
 * is one student, not two reports. The first spelling seen is the one used.
 */
function highlightedStudents_(sheet) {
  const column = nameColumnFor_(sheet.getName());
  if (!column) {
    throw new Error('A progress report is drafted from a student name, and the "' +
      sheet.getName() + '" sheet has no name column. Switch to "' +
      CONFIG.SHEETS.WOP + '", "' + CONFIG.SHEETS.DECK + '" or "' +
      CONFIG.CHANGELOG.SHEET_NAME + '" and highlight the names you want.');
  }

  const range = sheet.getActiveRange();
  if (!range) throw new Error('Highlight the student name first.');

  const startRow = range.getRow();
  const numRows = Math.min(range.getNumRows(),
    Math.max(sheet.getLastRow() - startRow + 1, 0));
  if (numRows < 1) {
    throw new Error('The highlighted selection does not contain any rows with data.');
  }

  const values = sheet.getRange(startRow, column, numRows, 1).getValues();
  const seen = {};
  const students = [];
  for (let i = 0; i < numRows; i++) {
    const name = extractName_(values[i][0]);
    if (!name) continue;
    const key = normalizeStudentName_(name);
    if (seen[key]) continue;
    seen[key] = true;
    students.push({ name: name, sheetRow: startRow + i });
  }

  if (!students.length) {
    throw new Error('No student name in the highlighted rows of column ' +
      columnLetter_(column) + '.');
  }
  return students;
}

// ------------------------------------------------------------------
// The two lists
// ------------------------------------------------------------------

/**
 * The topics a student is about to work on, taken from the deck queue.
 *
 * Column B is what they are on now, column E what has been printed and is
 * waiting, column F what is queued behind that -- which is the order they will
 * meet them in, so it is the order they are listed in. CONFIG.PROGRESS
 * .UPCOMING_COLUMNS decides which of those are drawn on.
 *
 * A topic already listed is not listed again: a task sitting in both B and E
 * is one topic the student will work on, not two.
 */
function upcomingTopics_(deck, name, wanted) {
  const hit = deck.find(name);
  if (!hit) {
    return { topics: [], why: 'is not on the ' + CONFIG.SHEETS.DECK + ', so ' +
      'there is no queue to read the upcoming topics from.' };
  }
  if (hit.duplicate) {
    return { topics: [], why: 'appears on the ' + CONFIG.SHEETS.DECK + ' more ' +
      'than once, so there is no telling which queue is theirs.' };
  }

  const topics = [];
  const seen = {};
  (CONFIG.PROGRESS.UPCOMING_COLUMNS || []).forEach(function (key) {
    const column = CONFIG.DECK_COL[key];
    if (!column) return;
    splitList_(deck.get(hit.row, column)).forEach(function (topic) {
      const dedupe = topic.trim().toLowerCase();
      if (!dedupe || seen[dedupe]) return;
      seen[dedupe] = true;
      if (topics.length < wanted) topics.push(topic.trim());
    });
  });

  if (!topics.length) {
    return { topics: [], why: 'has nothing in the deck queue, so there are no ' +
      'upcoming topics to name.' };
  }
  return { topics: topics, why: '' };
}

/**
 * The topics a student scored full marks on in their most recent assessment.
 *
 * NEEDS HTML -- twice over, and neither can be guessed at:
 *
 *   1. Which Radius page carries a per-topic breakdown of an assessment.
 *      CONFIG.PROGRESS.ASSESSMENT_URL is empty until somebody says.
 *   2. How to read the topics and scores out of it, which is
 *      PROGRESS_EXTRACTORS.masteredTopics below.
 *
 * Until both exist this returns nothing and says why. It does not fall back to
 * the deck history: a task the student finished is not a topic they scored a
 * hundred per cent on, and a progress report that says otherwise is worse than
 * one with a gap in it.
 */
function masteredTopics_(name, wanted) {
  if (!CONFIG.PROGRESS.ASSESSMENT_URL) {
    return { topics: [], why: 'the assessment page has not been mapped yet, so ' +
      'nothing can say which topics were full marks. Set ' +
      'CONFIG.PROGRESS.ASSESSMENT_URL and fill in ' +
      'PROGRESS_EXTRACTORS.masteredTopics once a copy of that page exists.' };
  }

  const entry = lookupRosterEntry_(name);
  if (!entry) {
    return { topics: [], why: 'was not found on the Radius roster, so their ' +
      'assessment could not be looked up.' };
  }

  let html;
  try {
    html = radiusFetch_(progressAssessmentUrl_(entry));
  } catch (err) {
    return { topics: [], why: 'their assessment page could not be fetched: ' +
      err.message };
  }

  let found;
  try {
    found = PROGRESS_EXTRACTORS.masteredTopics(html);
  } catch (err) {
    return { topics: [], why: 'their assessment page could not be read: ' +
      err.message };
  }

  const mastered = found.filter(function (topic) {
    return topic.percent >= CONFIG.PROGRESS.MASTERED_AT_OR_ABOVE;
  }).map(function (topic) { return topic.name; });

  if (!mastered.length) {
    return { topics: [], why: 'had no topic at ' +
      CONFIG.PROGRESS.MASTERED_AT_OR_ABOVE + '% on their most recent assessment.' };
  }
  return { topics: mastered.slice(0, wanted), why: '' };
}

/** The assessment page for a roster entry. NEEDS HTML -- see masteredTopics_. */
function progressAssessmentUrl_(entry) {
  return CONFIG.PROGRESS.ASSESSMENT_URL
    .replace('{{studentId}}', encodeURIComponent(entry.StudentId))
    .replace('{{centerId}}', encodeURIComponent(entry.CenterId));
}

/**
 * Pulling values out of a Radius assessment page.
 *
 * Deliberately separate from everything above, so that when a copy of the page
 * turns up this is the only function that has to be written. It must return a
 * list of { name, percent } -- one per topic on the assessment, percent as a
 * number out of a hundred -- or throw saying what it could not find.
 */
const PROGRESS_EXTRACTORS = {
  masteredTopics: function (html) {
    throw new Error('the per-topic breakdown has not been mapped yet. Send a ' +
      'copy of an assessment page for a student who has just been graded, and ' +
      'this becomes a few lines.');
  }
};

// ------------------------------------------------------------------
// The draft
// ------------------------------------------------------------------

/** A list of topics as the draft shows them, short lists marked as short. */
function topicLines_(found, wanted, kind) {
  const lines = found.topics.map(function (topic) {
    return CONFIG.PROGRESS.BULLET + topic;
  });

  const missing = wanted - found.topics.length;
  if (missing > 0) {
    // A gap left visible in the text, because a report handed over three
    // topics deep where four were asked for should not read as finished.
    lines.push(CONFIG.PROGRESS.BULLET + CONFIG.PROGRESS.MISSING_MARK
      .replace('{{n}}', missing)
      .replace('{{kind}}', kind));
  }
  return lines.join('\n');
}

/** One student's draft, from the template in CONFIG.PROGRESS. */
function progressDraft_(student, mastered, upcoming) {
  const wanted = CONFIG.PROGRESS.TOPIC_COUNT;
  return CONFIG.PROGRESS.TEMPLATE
    .replace('{{student}}', student.name)
    .replace('{{mastered}}', topicLines_(mastered, wanted, 'mastered'))
    .replace('{{upcoming}}', topicLines_(upcoming, wanted, 'upcoming'));
}

/**
 * Menu entry: draft a progress report for each highlighted student.
 *
 * Nothing is written to the spreadsheet. The draft is put on screen to be
 * copied into whatever the report itself is written in.
 */
function draftProgressReport() {
  const log = ActionLog_();
  let drafts;
  let students;

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getActiveSheet();
    students = highlightedStudents_(sheet);

    const deckSheet = ss.getSheetByName(CONFIG.SHEETS.DECK);
    if (!deckSheet) {
      throw new Error('Could not find a sheet named "' + CONFIG.SHEETS.DECK +
        '", which is where the upcoming topics are read from.');
    }
    const deck = DeckTable_(deckSheet);
    const wanted = CONFIG.PROGRESS.TOPIC_COUNT;

    drafts = students.map(function (student) {
      const upcoming = upcomingTopics_(deck, student.name, wanted);
      const mastered = masteredTopics_(student.name, wanted);

      if (upcoming.why) log.warn(student.name, upcoming.why);
      else if (upcoming.topics.length < wanted) {
        log.warn(student.name, 'has only ' + upcoming.topics.length +
          ' topic(s) in the deck queue, so the draft is ' +
          (wanted - upcoming.topics.length) + ' short of the ' + wanted +
          ' upcoming topics a report asks for.');
      } else {
        log.ok(student.name, 'upcoming topics taken from the deck queue.');
      }

      if (mastered.why) log.warn(student.name, mastered.why);
      else if (mastered.topics.length < wanted) {
        log.warn(student.name, 'had only ' + mastered.topics.length +
          ' topic(s) at ' + CONFIG.PROGRESS.MASTERED_AT_OR_ABOVE + '%.');
      } else {
        log.ok(student.name, 'mastered topics taken from their assessment.');
      }

      return progressDraft_(student, mastered, upcoming);
    });
  } catch (err) {
    showError_(err.message);
    return;
  }

  showProgressDrafts_(drafts.join(CONFIG.PROGRESS.BETWEEN_STUDENTS), log,
    students.length);
}

/**
 * Puts the drafts on screen in a box you can copy out of.
 *
 * The text is selected as soon as the dialog opens, so Ctrl+C works without
 * touching anything. The button is a convenience on top of that, not the only
 * way in: a modal dialog is sandboxed and the clipboard call can be refused,
 * and a copy button that silently does nothing is worse than no button.
 */
function showProgressDrafts_(text, log, count) {
  const entries = log.all();
  const notes = entries.map(function (entry) {
    const style = LOG_STYLE_[entry.level] || LOG_STYLE_.ok;
    return '<li style="color: ' + style.color + '; margin-bottom: 4px;">' +
      style.icon + ' <strong>' + escapeHtml_(entry.subject) + '</strong> &mdash; ' +
      escapeHtml_(entry.message) + '</li>';
  }).join('');

  const html = '<div style="font-family: Arial, sans-serif; font-size: 14px; ' +
    'line-height: 1.5; padding: 5px; color: #1e293b;">' +
    '<p style="margin: 0 0 8px;">Draft for ' + count + ' student' +
    (count === 1 ? '' : 's') + '. Nothing has been written to the spreadsheet.</p>' +
    '<textarea id="draft" style="width: 100%; height: 260px; font-family: ' +
    'Consolas, monospace; font-size: 13px; padding: 8px; box-sizing: border-box; ' +
    'border: 1px solid #cbd5e1; border-radius: 6px;">' + escapeHtml_(text) +
    '</textarea>' +
    '<p style="margin: 8px 0;"><button id="copy" style="padding: 6px 14px; ' +
    'font-size: 14px;">Copy</button> <span id="said" style="color: #64748b;">' +
    'The text is selected — Ctrl+C copies it.</span></p>' +
    (notes ? '<div style="font-weight: bold; margin: 14px 0 6px;">Notes</div>' +
      '<ul style="padding-left: 20px; margin: 0;">' + notes + '</ul>' : '') +
    '</div>' +
    '<script>' +
    'var box = document.getElementById("draft");' +
    'box.focus(); box.select();' +
    'document.getElementById("copy").onclick = function () {' +
    '  box.select();' +
    '  var said = document.getElementById("said");' +
    '  var ok = false;' +
    '  try { ok = document.execCommand("copy"); } catch (e) { ok = false; }' +
    '  said.textContent = ok ? "Copied." :' +
    '    "This dialog is not allowed to reach the clipboard — the text is ' +
    'selected, press Ctrl+C.";' +
    '};' +
    '</script>';

  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(560).setHeight(560),
    'Progress report draft');
}
