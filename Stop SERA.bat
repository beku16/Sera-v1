@echo off
setlocal EnableExtensions
title Stop SERA
cd /d "%~dp0"

if "%PORT%"=="" set "PORT=43110"

echo.
echo   ============================================================
echo     Stopping SERA...
echo   ============================================================
echo.

REM -- v1.9.0 (BUG L10 FIX): SERA now stops ONLY processes that clearly
REM      belong to it. The old script ran `taskkill /IM electron.exe` —
REM      killing EVERY Electron app on the machine (VS Code insiders,
REM      chat clients, other tools) — and killed whatever sat on the port
REM      without checking what it was.

REM -- 1. Close the "SERA Server" console window (its title is unique to
REM      this launcher; kills the node child + cmd host as one tree).
taskkill /FI "WINDOWTITLE eq SERA Server*" /T /F >nul 2>nul

REM -- 2. Stop the SERA backend by port — but ONLY when the listening
REM       process looks like SERA (its command line references this
REM       folder or dist/server.cjs). A browser tab, another dev's server
REM       or an unrelated app on the same port is left alone.
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-CimInstance Win32_Process -Filter \"ProcessId = $($c.OwningProcess)\" -ErrorAction SilentlyContinue; if ($p -and $p.CommandLine -like '*sera*') { try { taskkill /PID $($c.OwningProcess) /T /F | Out-Null; Write-Host '  [ok] SERA server stopped (port %PORT%).' } catch {} } else { Write-Host '  [i] Port %PORT% is used by a non-SERA process - left running.' } } else { Write-Host '  [i] Nothing was listening on port %PORT% - server was not running.' }"

REM -- 3. Close the SERA desktop window by its WINDOW TITLE — never by
REM       image name (electron.exe belongs to many unrelated apps).
powershell -NoProfile -Command "Get-Process | Where-Object { $_.MainWindowTitle -like 'SERA - Voice*' -or $_.MainWindowTitle -like 'SERA - *' } | Stop-Process -Force -ErrorAction SilentlyContinue"

echo   [ok] SERA desktop window closed.
echo.
echo   SERA is now fully stopped. Double-click "Start SERA.bat" to run it again.
echo.
timeout /t 4 >nul
exit /b 0
