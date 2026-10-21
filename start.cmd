@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "BASSCHART_EXIT=%ERRORLEVEL%"
echo.
if not "%BASSCHART_EXIT%"=="0" echo BassChart Studio stopped with error code %BASSCHART_EXIT%.
pause
exit /b %BASSCHART_EXIT%
