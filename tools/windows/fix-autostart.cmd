@echo off
REM Desk Clock autostart diagnose + repair launcher.
REM ASCII-ONLY on purpose: a .cmd file containing non-ASCII text plus "chcp 65001"
REM makes cmd.exe re-read the file from a byte offset after the codepage switch
REM and execute the mis-decoded bytes as commands ("xxx is not recognized...").
REM All Chinese output lives in the .ps1, which is saved as UTF-8 with BOM.
setlocal
cd /d "%~dp0"
echo.
echo  Desk Clock - Autostart Diagnose ^& Repair
echo  ---------------------------------------------
echo  This tool only reads and repairs YOUR OWN startup entry.
echo  It prints what Windows really sees, then repairs it.
echo.
where powershell >nul 2>&1
if errorlevel 1 (
  echo  [ERROR] Windows PowerShell not found in PATH.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-deskclock-autostart.ps1"
set RC=%errorlevel%
if not "%RC%"=="0" (
  echo.
  echo  [WARN] PowerShell exited with code %RC%
  echo  If the window closed instantly, run this file as ADMINISTRATOR:
  echo    right-click fix-autostart.cmd -^> Run as administrator
)
echo.
pause
endlocal
