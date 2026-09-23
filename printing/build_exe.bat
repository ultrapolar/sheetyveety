@echo off
setlocal EnableExtensions
title Build Batch Print exes

echo.
echo Building standalone batch_print.exe and batch_print_settings.exe
echo (Python built in -- nothing else needed on the target PC)...
echo.

set "PY="
where py >nul 2>nul && set "PY=py"
if not defined PY ( where python >nul 2>nul && set "PY=python" )
if not defined PY (
  echo [X] Python 3 is required to BUILD the exes (end users will not need it).
  echo     Install from https://www.python.org/downloads/ and try again.
  pause
  exit /b 1
)

echo [..] Installing build tools (pyinstaller, pypdf, reportlab, pywin32)...
%PY% -m pip install --upgrade --quiet pyinstaller pypdf reportlab pywin32
if errorlevel 1 ( echo [X] Tool install failed. & pause & exit /b 1 )
REM pywin32 only powers "Detect printers on this PC"; PyInstaller ships its
REM own hook for it, so no extra --hidden-import flags are needed below.

echo [..] Compiling batch_print.exe...
%PY% -m PyInstaller --onefile --console --name batch_print "%~dp0batch_print.py"
if errorlevel 1 ( echo [X] Build failed. & pause & exit /b 1 )

echo [..] Compiling batch_print_settings.exe (no console window)...
%PY% -m PyInstaller --onefile --windowed --name batch_print_settings "%~dp0settings_gui.py"
if errorlevel 1 ( echo [X] Build failed. & pause & exit /b 1 )

echo.
echo =====================================
echo    Done.
echo =====================================
echo  Your exes are at:
echo    %~dp0dist\batch_print.exe
echo    %~dp0dist\batch_print_settings.exe
echo.
echo  To distribute: put both exes, SumatraPDF.exe, and a config.json
echo  together in one folder (copy the one from this project, or run
echo  batch_print_settings.exe once to create it). Copy that folder to any
echo  PC and make shortcuts to the two exes. No Python, no pip, nothing to
echo  install.
echo.
pause
