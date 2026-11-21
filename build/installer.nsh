; MediaKiln NSIS 安装/卸载钩子：安全将安装目录加入或移出当前用户 PATH（用于 mediakiln 命令行）

!macro customInstall
  System::Call 'Kernel32::SetEnvironmentVariable(t "MK_INSTDIR", t "$INSTDIR")'
  nsExec::ExecToLog `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = ($$env:MK_INSTDIR).TrimEnd('\'); if (-not $$d) { exit 0 }; $$cur = [Environment]::GetEnvironmentVariable('Path', 'User'); $$parts = @(); if ($$cur) { $$parts = @($$cur -split ';' | Where-Object { $$_.Trim() -ne '' }) }; $$exists = (@($$parts | Where-Object { $$_.Trim().TrimEnd('\').ToLowerInvariant() -eq $$d.ToLowerInvariant() }).Count -gt 0); if (-not $$exists) { [Environment]::SetEnvironmentVariable('Path', (($$parts + $$d) -join ';'), 'User') }"`
!macroend

!macro customUnInstall
  System::Call 'Kernel32::SetEnvironmentVariable(t "MK_INSTDIR", t "$INSTDIR")'
  nsExec::ExecToLog `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = ($$env:MK_INSTDIR).TrimEnd('\'); if (-not $$d) { exit 0 }; $$cur = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not $$cur) { exit 0 }; $$parts = @($$cur -split ';' | Where-Object { $$_.Trim() -ne '' }); $$kept = @($$parts | Where-Object { $$_.Trim().TrimEnd('\').ToLowerInvariant() -ne $$d.ToLowerInvariant() }); [Environment]::SetEnvironmentVariable('Path', ($$kept -join ';'), 'User')"`
!macroend
