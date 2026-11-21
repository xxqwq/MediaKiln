@echo off
setlocal
set "MK_DIR=%~dp0"
if exist "%MK_DIR%MediaKiln.exe" (
  set "ELECTRON_RUN_AS_NODE=1"
  set "VGT_ELECTRON_EXE=%MK_DIR%MediaKiln.exe"
  set "VGT_RESOURCES_PATH=%MK_DIR%resources"
  "%MK_DIR%MediaKiln.exe" "%MK_DIR%resources\app.asar\cli.js" %*
  exit /b %ERRORLEVEL%
)
if exist "%MK_DIR%cli.js" (
  node "%MK_DIR%cli.js" %*
  exit /b %ERRORLEVEL%
)
echo [MediaKiln] Cannot find MediaKiln.exe or cli.js in "%MK_DIR%" >&2
exit /b 1
