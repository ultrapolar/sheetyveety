function onOpen() {
  var ui = SpreadsheetApp.getUi();
  
  // Creates the SOD Menu FIRST
  ui.createMenu('SOD')
      .addItem('Pinks Printed', 'processSodPinks')
      .addToUi();

  // Creates the EOD Menu SECOND
  ui.createMenu('EOD')
      .addItem('Colored Sheets Batch Process', 'processWopToDeck')
      .addToUi();
}

// ==========================================
// SOD SCRIPT: PINKS PRINTED (PART 1 - PARSING)
// ==========================================
function processSodPinks() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var wopSheet = ss.getSheetByName('Daily WOP');
  var deckSheet = ss.getSheetByName('Deck List');
  var ui = SpreadsheetApp.getUi();

  if (!wopSheet || !deckSheet) {
    ui.alert("Error: Ensure both 'Daily WOP' and 'Deck List' sheets exist.");
    return;
  }

  if (ss.getActiveSheet().getName() !== 'Daily WOP') {
    ui.alert("Please run this script while looking at the 'Daily WOP' sheet.");
    return;
  }

  var activeRange = wopSheet.getActiveRange();
  var startRow = activeRange.getRow();
  var numRows = activeRange.getNumRows();

  var dataRange = wopSheet.getRange(startRow, 1, numRows, 1); 
  var data = dataRange.getValues();
  var backgrounds = dataRange.getBackgrounds(); 

  var deckDataRange = deckSheet.getDataRange();
  var deckData = deckDataRange.getValues();

  var logMessages = [];
  var operations = []; 
  
  // NEW: Tracker Object for the Dashboard
  var stats = { pinkStudents: 0, tasksMoved: 0, issues: 0 };

  for (var i = 0; i < data.length; i++) {
    var colA_Color = backgrounds[i][0].toLowerCase(); 

    if (colA_Color === '#00ff00') continue; 

    var colA = String(data[i][0]).trim(); 
    if (colA === "") continue; 
    
    var fullName = colA.replace(/^[\d:]+\s*(AM|PM|am|pm)?\s*/, '').trim();
    if (!fullName) continue;

    var matchFound = false;

    for (var j = 0; j < deckData.length; j++) {
      var searchName = String(deckData[j][0]).trim(); 

      if (searchName.toLowerCase() === fullName.toLowerCase()) {
        var targetRow = j + 1; 
        matchFound = true;
        
        var colC_Val = String(deckSheet.getRange(targetRow, 3).getValue()).toLowerCase().trim();
        
        if (colC_Val === "pink") {
          stats.pinkStudents++; // Log that we found a student with a pink status
          
          var colE_Val = String(deckSheet.getRange(targetRow, 5).getValue()).trim();
          var colF_Val = String(deckSheet.getRange(targetRow, 6).getValue()).trim();

          // Rule 1: If Column E has something, STOP and FLAG RED
          if (colE_Val !== "") {
            wopSheet.getRange(startRow + i, 1).setBackground('#ffcccc');
            logMessages.push("<li style='color: #dc2626;'>❌ <strong>" + fullName + "</strong>: Cannot print. Column E already contains data.</li>");
            stats.issues++;
            break;
          }

          // Rule 2: If Column F is empty, STOP and FLAG RED
          if (colF_Val === "") {
            wopSheet.getRange(startRow + i, 1).setBackground('#ffcccc');
            logMessages.push("<li style='color: #dc2626;'>❌ <strong>" + fullName + "</strong>: Cannot print. Column F queue is empty!</li>");
            stats.issues++;
            break;
          }

          var fParts = colF_Val.split(/\s*,\s*/);
          var sdCount = 0;
          var firstSdIndex = -1;

          // Check for SD items
          for (var k = 0; k < fParts.length; k++) {
            if (/^SD\d+/i.test(fParts[k])) {
              sdCount++;
              if (firstSdIndex === -1) firstSdIndex = k;
            }
          }

          // Rule 3: Routing Logic (Auto vs Prompt)
          if (sdCount > 1) {
            operations.push({
              type: 'auto', fullName: fullName, wopRow: startRow + i, deckRow: targetRow, fParts: fParts, itemsToMove: firstSdIndex + 1
            });
          } else if (fParts.length > 1) {
            operations.push({
              type: 'prompt', fullName: fullName, wopRow: startRow + i, deckRow: targetRow, fParts: fParts, maxItems: fParts.length
            });
          } else {
            operations.push({
              type: 'auto', fullName: fullName, wopRow: startRow + i, deckRow: targetRow, fParts: fParts, itemsToMove: 1
            });
          }
        } 
        break; 
      }
    }

    if (!matchFound) {
      wopSheet.getRange(startRow + i, 1).setBackground('#ffcccc'); 
      logMessages.push("<li style='color: #dc2626;'>❌ <strong>" + fullName + "</strong> failed (Name not found in Deck List)</li>");
      stats.issues++;
    }
  }

  var needsPrompt = operations.filter(function(op) { return op.type === 'prompt'; }).length > 0;

  if (needsPrompt) {
    showMultiPromptUI(operations, logMessages, stats);
  } else {
    executeSodOperations(operations, logMessages, stats);
  }
}

// ==========================================
// SOD SCRIPT: THE SINGLE-SCREEN PROMPT UI
// ==========================================
function showMultiPromptUI(operations, logMessages, stats) {
  var html = '<div style="font-family: Arial, sans-serif; padding: 10px;">';
  html += '<h3 style="margin-top: 0;">Multiple Tasks Detected</h3>';
  html += '<p style="font-size: 14px; color: #4b5563;">Specify how many items to move for each student:</p>';
  html += '<form id="sodForm">';

  var payload = { ops: operations, logs: logMessages, stats: stats };
  var encoded = Utilities.base64Encode(JSON.stringify(payload), Utilities.Charset.UTF_8);
  html += '<input type="hidden" name="payload" value="' + encoded + '">';

  for (var i = 0; i < operations.length; i++) {
    var op = operations[i];
    if (op.type === 'prompt') {
      html += '<div style="margin-bottom: 15px; padding: 10px; border: 1px solid #e5e7eb; border-radius: 6px; background: #f9fafb;">';
      html += '<div style="font-weight: bold; margin-bottom: 5px;">' + op.fullName + '</div>';
      html += '<div style="font-size: 12px; color: #6b7280; margin-bottom: 8px;">Queue (' + op.maxItems + '): <em>' + op.fParts.join(', ') + '</em></div>';
      html += '<label style="font-size: 14px;">Items to move: </label>';
      html += '<input type="number" name="num_' + i + '" min="1" max="' + op.maxItems + '" value="1" style="width: 60px; padding: 4px; border: 1px solid #d1d5db; border-radius: 4px;">';
      html += '</div>';
    }
  }

  html += '<button type="button" onclick="submitForm()" style="width: 100%; padding: 10px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">Process Selected</button>';
  html += '</form>';
  html += '<script>';
  html += 'function submitForm() {';
  html += '  var btn = document.querySelector("button");';
  html += '  btn.disabled = true; btn.innerText = "Processing..."; btn.style.background = "#9ca3af";';
  html += '  google.script.run.executeSodOperations_FromUI(document.getElementById("sodForm"));';
  html += '}';
  html += '</script></div>';

  var ui = HtmlService.createHtmlOutput(html).setWidth(400).setHeight(500);
  SpreadsheetApp.getUi().showModalDialog(ui, "Action Required");
}

// ==========================================
// SOD SCRIPT: HTML UI CALLBACK
// ==========================================
function executeSodOperations_FromUI(formObject) {
  var payloadStr = Utilities.newBlob(Utilities.base64Decode(formObject.payload)).getDataAsString();
  var payload = JSON.parse(payloadStr);
  var operations = payload.ops;

  for (var i = 0; i < operations.length; i++) {
    if (operations[i].type === 'prompt') {
      var val = parseInt(formObject['num_' + i], 10);
      operations[i].itemsToMove = isNaN(val) ? 1 : val; 
    }
  }

  executeSodOperations(operations, payload.logs, payload.stats);
}

// ==========================================
// SOD SCRIPT: FINAL EXECUTION (PART 2)
// ==========================================
function executeSodOperations(operations, logMessages, stats) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var wopSheet = ss.getSheetByName('Daily WOP');
  var deckSheet = ss.getSheetByName('Deck List');

  for (var i = 0; i < operations.length; i++) {
    var op = operations[i];
    var fParts = op.fParts;
    
    var itemsToMove = Math.min(op.itemsToMove, fParts.length);
    stats.tasksMoved += itemsToMove; // Tally up every task moved

    var movedItemsArray = fParts.splice(0, itemsToMove); 
    var movedString = movedItemsArray.join(', ');
    var remainingString = fParts.join(', ');

    deckSheet.getRange(op.deckRow, 5).setValue(movedString);
    deckSheet.getRange(op.deckRow, 6).setValue(remainingString);
    deckSheet.getRange(op.deckRow, 3).clearContent(); 

    wopSheet.getRange(op.wopRow, 1).setBackground('#00FF00');
    logMessages.push("<li><strong>" + op.fullName + "</strong>: Loaded \"<em>" + movedString + "</em>\" into Col E and removed pink status.</li>");
  }

  if (logMessages.length > 0 || stats.issues > 0) {
    var htmlContent = `
      <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.5; padding: 5px;">
        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px; margin-bottom: 15px;">
          <h4 style="margin: 0 0 8px 0; color: #1e293b;">📊 SOD Summary</h4>
          <table style="width: 100%; font-size: 14px; color: #334155;">
            <tr><td><strong>Students w/ Pinks:</strong></td><td style="text-align: right;"><b>${stats.pinkStudents}</b></td></tr>
            <tr><td><strong>Total Tasks Moved:</strong></td><td style="text-align: right;"><b>${stats.tasksMoved}</b></td></tr>
            <tr><td><strong>Issues/Errors:</strong></td><td style="text-align: right; color: ${stats.issues > 0 ? '#dc2626' : '#334155'};"><b>${stats.issues}</b></td></tr>
          </table>
        </div>
        <strong>Action Log:</strong>
        <ul style="padding-left: 20px; margin-top: 10px;">${logMessages.join('')}</ul>
      </div>
    `;
    var htmlOutput = HtmlService.createHtmlOutput(htmlContent).setWidth(450).setHeight(400);
    SpreadsheetApp.getUi().showModalDialog(htmlOutput, "SOD Complete");
  } else {
    SpreadsheetApp.getUi().alert("SOD complete! No valid pink records were found in the highlighted selection.");
  }
}

// ==========================================
// EOD SCRIPT: COLORED SHEETS BATCH PROCESS
// ==========================================
function processWopToDeck() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var wopSheet = ss.getSheetByName('Daily WOP');
  var deckSheet = ss.getSheetByName('Deck List');

  if (!wopSheet || !deckSheet) {
    SpreadsheetApp.getUi().alert("Error: Ensure both 'Daily WOP' and 'Deck List' sheets exist with exact spelling.");
    return;
  }

  if (ss.getActiveSheet().getName() !== 'Daily WOP') {
    SpreadsheetApp.getUi().alert("Please run this script while looking at the 'Daily WOP' sheet.");
    return;
  }

  var activeRange = wopSheet.getActiveRange();
  var startRow = activeRange.getRow();
  var numRows = activeRange.getNumRows();

  var dataRange = wopSheet.getRange(startRow, 1, numRows, 11); 
  var data = dataRange.getValues();
  var backgrounds = dataRange.getBackgrounds(); 

  var today = new Date();
  var dateStr = Utilities.formatDate(today, ss.getSpreadsheetTimeZone(), "MM/dd");

  var deckDataRange = deckSheet.getDataRange();
  var deckData = deckDataRange.getValues();

  var logMessages = [];
  
  // NEW: Tracker Object for the Dashboard
  var stats = { studentsProcessed: 0, yActions: 0, pActions: 0, issues: 0 };

  for (var i = 0; i < data.length; i++) {
    var colK_Color = backgrounds[i][10].toLowerCase(); 

    if (colK_Color === '#00ff00') continue; 

    var colK_Text = String(data[i][10]).toUpperCase().trim(); 
    
    var isTriggerY = false;
    var isTriggerP = false;
    var yCount = 0;

    if (colK_Text === 'Y - B EMPTY?') {
      isTriggerY = true;
      yCount = 1; 
    } else if (/^[YP]+$/.test(colK_Text) || colK_Text.includes(' (RAN OUT OF TASKS)')) {
      var cleanText = colK_Text.split(' ')[0]; 
      isTriggerY = cleanText.includes('Y');
      isTriggerP = cleanText.includes('P');
      yCount = (cleanText.match(/Y/g) || []).length; 
    }

    if (isTriggerY || isTriggerP) {
      var colA = String(data[i][0]).trim(); 
      var fullName = colA.replace(/^[\d:]+\s*(AM|PM|am|pm)?\s*/, '').trim();

      if (!fullName) continue; 

      var matchFound = false; 

      for (var j = 0; j < deckData.length; j++) {
        var searchName = String(deckData[j][0]).trim(); 

        if (searchName.toLowerCase() === fullName.toLowerCase()) {
          var targetRow = j + 1; 
          var bWasEmpty = false;
          var completedTasks = []; 

          if (isTriggerY) {
            var colB_Val = String(deckSheet.getRange(targetRow, 2).getValue()).trim();  
            var colE_Val = String(deckSheet.getRange(targetRow, 5).getValue()).trim();  
            var colM_Val = String(deckSheet.getRange(targetRow, 13).getValue()).trim(); 

            for (var y = 0; y < yCount; y++) {
              if (colB_Val === "") {
                if (y === 0) {
                  wopSheet.getRange(startRow + i, 11).setValue("Y - B empty?").setBackground('#ffff00'); 
                  logMessages.push("<li style='color: #d97706;'>⚠️ <strong>" + fullName + "</strong> skipped (Column B was initially empty)</li>");
                  bWasEmpty = true;
                  stats.issues++;
                } else {
                  logMessages.push("<li style='color: #d97706;'>⚠️ <strong>" + fullName + "</strong> ran out of tasks in Column E. Only processed " + y + " out of " + yCount + ".</li>");
                  stats.issues++;
                }
                break; 
              }

              completedTasks.push(colB_Val);
              colM_Val = colM_Val ? (colM_Val + " | " + colB_Val + " " + dateStr) : (colB_Val + " " + dateStr);

              if (colE_Val !== "") {
                var eParts = colE_Val.split(/\s*,\s*/); 
                colB_Val = eParts.shift(); 
                colE_Val = eParts.join(', '); 
              } else {
                colB_Val = ""; 
              }
            }

            if (!bWasEmpty) {
              deckSheet.getRange(targetRow, 2).setValue(colB_Val);
              deckSheet.getRange(targetRow, 5).setValue(colE_Val);
              deckSheet.getRange(targetRow, 13).setValue(colM_Val);

              var newTaskText = colB_Val ? colB_Val : "Nothing (Col E was empty)";
              logMessages.push("<li><strong>" + fullName + "</strong> finished \"<em>" + completedTasks.join(", ") + "</em>\" and is now on \"<em>" + newTaskText + "</em>\"</li>");
            }
            
            stats.yActions += completedTasks.length; // Tally up successfully archived tasks
          }
          
          if (isTriggerP) {
            deckSheet.getRange(targetRow, 3).setValue("pink");
            logMessages.push("<li><strong>" + fullName + "</strong> was marked \"<em>pink</em>\" in Column C</li>");
            stats.pActions++; // Tally up Pinks
          }

          if (!bWasEmpty) {
            var finalLetter = "";
            var actualYProcessed = completedTasks.length;
            var ranOut = isTriggerY && (actualYProcessed < yCount);

            if (isTriggerY) {
              for (var k = 0; k < actualYProcessed; k++) {
                finalLetter += "Y";
              }
            }
            if (isTriggerP) finalLetter += "P";

            if (ranOut) {
              finalLetter += " (ran out of tasks)";
              wopSheet.getRange(startRow + i, 11).setValue(finalLetter).setBackground('#ffff00');
            } else {
              wopSheet.getRange(startRow + i, 11).setValue(finalLetter).setBackground('#00FF00');
            }
          }

          stats.studentsProcessed++; // Tally up students successfully handled
          matchFound = true; 
          break; 
        }
      }

      if (!matchFound) {
        wopSheet.getRange(startRow + i, 11).setBackground('#ffcccc'); 
        logMessages.push("<li style='color: #dc2626;'>❌ <strong>" + fullName + "</strong> failed (Name not found in Deck List)</li>");
        stats.issues++;
      }
    }
  }

  if (logMessages.length > 0 || stats.issues > 0) {
    var htmlContent = `
      <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.5; padding: 5px;">
        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px; margin-bottom: 15px;">
          <h4 style="margin: 0 0 8px 0; color: #1e293b;">📊 EOD Summary</h4>
          <table style="width: 100%; font-size: 14px; color: #334155;">
            <tr><td><strong>Students Processed:</strong></td><td style="text-align: right;"><b>${stats.studentsProcessed}</b></td></tr>
            <tr><td><strong>Total 'Y' Actions:</strong></td><td style="text-align: right;"><b>${stats.yActions}</b></td></tr>
            <tr><td><strong>Total 'P' Actions:</strong></td><td style="text-align: right;"><b>${stats.pActions}</b></td></tr>
            <tr><td><strong>Issues/Errors:</strong></td><td style="text-align: right; color: ${stats.issues > 0 ? '#dc2626' : '#334155'};"><b>${stats.issues}</b></td></tr>
          </table>
        </div>
        <strong>Action Log:</strong>
        <ul style="padding-left: 20px; margin-top: 10px;">${logMessages.join('')}</ul>
      </div>
    `;
    var htmlOutput = HtmlService.createHtmlOutput(htmlContent).setWidth(450).setHeight(400);
    SpreadsheetApp.getUi().showModalDialog(htmlOutput, "EOD Complete");
  } else {
    SpreadsheetApp.getUi().alert("EOD complete! No valid Y, P, or YP records were found in the highlighted selection.");
  }
}
