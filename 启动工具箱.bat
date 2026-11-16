@echo off
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
if exist "node_modules\electron\dist\electron.exe" goto launch
call npm install
if exist "node_modules\electron\dist\electron.exe" goto launch
echo Failed to find Electron. Please run npm install manually.
pause
exit /b 1

:launch
start "" "node_modules\electron\dist\electron.exe" .
