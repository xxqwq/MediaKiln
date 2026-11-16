@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "node_modules\electron\dist\electron.exe" (
  start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
) else (
  echo 未检测到 Electron，正在尝试安装依赖...
  call npm install
  if exist "node_modules\electron\dist\electron.exe" (
    start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
  ) else (
    echo 启动失败，请检查 Node.js 与 npm 环境。
    pause
  )
)
