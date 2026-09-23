@echo off
setlocal EnableExtensions
title Batch Print - Installer

echo.
echo =====================================
echo    Batch Print  -  Installer
echo =====================================
echo.

REM --- 1. Find Python -------------------------------------------------------
set "PY="
where py >nul 2>nul && set "PY=py"
if not defined PY ( where python >nul 2>nul && set "PY=python" )
if not defined PY (
  echo [X] Python 3 was not found on this PC.
  echo.
  echo     Install it from  https://www.python.org/downloads/
  echo     and be sure to tick "Add Python to PATH" during setup,
  echo     then run this installer again.
  echo.
  pause
  exit /b 1
)
echo [ok] Found Python: %PY%

REM --- 2. Make sure SumatraPDF is in this folder ----------------------------
if not exist "%~dp0SumatraPDF.exe" (
  echo [X] SumatraPDF.exe is missing from this folder.
  echo.
  echo     Download the 64-bit PORTABLE build from
  echo     https://www.sumatrapdfreader.org/download-free-pdf-viewer
  echo     rename the file to  SumatraPDF.exe , drop it next to this
  echo     installer, and run it again.
  echo.
  pause
  exit /b 1
)
echo [ok] Found SumatraPDF.exe

REM --- 3. Create the app folder and copy files in ---------------------------
set "APP=%LOCALAPPDATA%\BatchPrint"
echo [..] Installing into  %APP%
if not exist "%APP%" mkdir "%APP%"
copy /y "%~dp0batch_print.py"       "%APP%\" >nul
copy /y "%~dp0config_store.py"      "%APP%\" >nul
copy /y "%~dp0settings_gui.py"      "%APP%\" >nul
copy /y "%~dp0printer_discovery.py" "%APP%\" >nul
copy /y "%~dp0SumatraPDF.exe"       "%APP%\" >nul
echo [ok] Files copied.

REM Don't clobber a site's already-configured settings on a re-run.
if not exist "%APP%\config.json" (
  copy /y "%~dp0config.json" "%APP%\" >nul
  echo [ok] Copied the default config.json -- open Batch Print Settings and
  echo      fill in the Sheet URL and printer names before the first run.
) else (
  echo [ok] Keeping the config.json already at %APP% -- your settings are untouched.
)

REM --- 4. Install the Python dependencies -----------------------------------
echo [..] Installing dependencies (pypdf, reportlab)...
%PY% -m pip install --upgrade --quiet pip
%PY% -m pip install --upgrade --quiet pypdf reportlab
if errorlevel 1 (
  echo [X] Could not install the dependencies. Check the internet connection
  echo     and run this installer again.
  echo.
  pause
  exit /b 1
)
echo [ok] Dependencies installed.

REM pywin32 only powers "Detect printers on this PC" in Settings -- Batch
REM Print itself runs fine without it, so a failure here doesn't stop setup.
echo [..] Installing pywin32 (for "Detect printers on this PC" in Settings)...
%PY% -m pip install --upgrade --quiet pywin32
if errorlevel 1 (
  echo [!] pywin32 didn't install -- Settings will still work, but you'll need
  echo     to type printer names in by hand instead of using Detect. Try
  echo     "py -m pip install pywin32" yourself later if you want it.
) else (
  echo [ok] pywin32 installed.
)

REM --- 5. Write the launchers ------------------------------------------------
> "%APP%\run.bat" echo @echo off
>>"%APP%\run.bat" echo title Batch Print
>>"%APP%\run.bat" echo cd /d "%%~dp0"
>>"%APP%\run.bat" echo %PY% "%%~dp0batch_print.py"
>>"%APP%\run.bat" echo pause

> "%APP%\settings.bat" echo @echo off
>>"%APP%\settings.bat" echo title Batch Print Settings
>>"%APP%\settings.bat" echo cd /d "%%~dp0"
>>"%APP%\settings.bat" echo %PY% "%%~dp0settings_gui.py"

REM --- 6. Put shortcuts on the Desktop ---------------------------------------
echo [..] Creating Desktop shortcuts...
powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Batch Print.lnk'); $s.TargetPath='%APP%\run.bat'; $s.WorkingDirectory='%APP%'; $s.Save()" >nul 2>nul
powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Batch Print Settings.lnk'); $s.TargetPath='%APP%\settings.bat'; $s.WorkingDirectory='%APP%'; $s.Save()" >nul 2>nul

echo.
echo =====================================
echo    Done.
echo =====================================
echo  Installed at : %APP%
echo  To print     : double-click "Batch Print" on the Desktop
echo  To configure : double-click "Batch Print Settings" on the Desktop
echo.
echo  Before the first run, open "Batch Print Settings" and set the Sheet CSV
echo  URL and your printer names -- see INSTALL.txt.
echo.
pause
