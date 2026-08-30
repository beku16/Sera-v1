@echo off
setlocal EnableExtensions EnableDelayedExpansion
title SERA - Voice AI Assistant
cd /d "%~dp0"

REM v1.9.0: SERA owns port 43110 now (PORT still wins; the server falls
REM back to an ephemeral port automatically when this one is busy).
if "%PORT%"=="" set "PORT=43110"
set "APP_VERSION=1.9.0"
set "ELECTRON_EXE=%~dp0node_modules\electron\dist\electron.exe"
set "ELECTRON_INSTALL=%~dp0node_modules\electron\install.js"
set "SERA_MAIN=%~dp0electron\main.cjs"
set "UI_OPENED=0"

REM -- Locate Edge / Chrome so the fallback is a standalone desktop-style
REM    window (--app mode: no tabs, no address bar), never a plain tab.
set "EDGE_EXE="
set "CHROME_EXE="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE_EXE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE_EXE if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE_EXE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE_EXE if exist "%LocalAppData%\Microsoft\Edge\Application\msedge.exe" set "EDGE_EXE=%LocalAppData%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME_EXE if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME_EXE if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%LocalAppData%\Google\Chrome\Application\chrome.exe"

echo.
echo   ============================================================
echo     S E R A   -   Local-First Voice AI Desktop Assistant
echo     Double-click launcher  -  github.com/beku16/sera
echo   ============================================================
echo.

REM -- 0. Self-unblock ----------------------------------------------------------
REM    Files extracted from a downloaded ZIP carry Windows' invisible
REM    "Mark of the Web", which makes SmartScreen / Smart App Control block
REM    them ONE BY ONE. Instead of asking you to unblock anything manually,
REM    the launcher strips that flag from the whole folder on every run
REM    (node_modules and .git are skipped - npm-downloaded files never have
REM    the flag). Silent when everything is already clean (~1-2 seconds).
powershell -NoProfile -ExecutionPolicy Bypass -Command "$n=0; $root=(Get-Location).Path; Get-ChildItem -LiteralPath $root -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'node_modules' -and $_.Name -ne '.git' } | ForEach-Object { if ($_.PSIsContainer) { Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { Get-Item -LiteralPath $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue } | ForEach-Object { $n++; Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue } } else { if (Get-Item -LiteralPath $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue) { $n++; Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue } } }; if ($n -gt 0) { exit 9 }"
if errorlevel 9 (
  echo   [..] One-time setup: removing Windows download-block flags from this folder.
  echo        You will not be asked to unblock files again.
  echo.
)

REM -- 1. Node.js runtime ------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js is not installed. SERA needs it to run.
  echo.
  echo   [i] Opening the Node.js download page in your browser...
  echo       Install the LTS version, then double-click this file again.
  echo.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node --version') do set "NODE_VERSION=%%v"
echo   [ok] Node.js !NODE_VERSION! found.

REM -- v1.8.5 FIX: APP_VERSION used to be hardcoded (1.6.10 forever), so a
REM    CURRENT server was misdetected as "an OLD SERA server, version
REM    mismatch" and re-opening the window told you to kill a healthy
REM    server. Sync it from package.json now that Node is confirmed.
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version" 2^>nul`) do set "APP_VERSION=%%v"

REM -- 2. Already running? Verify it is THIS version, then open desktop window -
curl --fail --silent --show-error --max-time 2 -o nul http://localhost:!PORT!/api/health >nul 2>nul
if errorlevel 1 goto dependencies

node -e "fetch('http://localhost:!PORT!/api/health').then(function(r){return r.json()}).then(function(h){process.exit(h.version==='!APP_VERSION!'?0:1)}).catch(function(){process.exit(2)})" >nul 2>nul
if errorlevel 2 goto dependencies
if errorlevel 1 goto stale_server
goto open_desktop

:stale_server
echo   [X] An OLD SERA server, version mismatch, is still running on port !PORT!.
echo       You updated the folder, but the old server is still serving the old app.
echo.
echo       FIX: close the "SERA Server" window - or run this in a terminal:
echo            taskkill /F /IM node.exe
echo       Then wait 5 seconds and double-click this file again.
echo.
pause
exit /b 1

:open_desktop
echo   [ok] SERA v!APP_VERSION! is already running on port !PORT!.
call :launch_desktop
if "!UI_OPENED!"=="1" goto summary
timeout /t 4 >nul
goto maybe_fallback

REM -- 3. Dependencies ---------------------------------------------------------
:dependencies
if not exist "node_modules\" (
  echo   [..] First run detected - installing dependencies.
  echo        This is a one-time setup and can take 5-10 minutes.
  echo        It also downloads the automation browser in the background.
  echo.
  call npm install
  if errorlevel 1 (
    echo   [X] npm install failed. Check your internet connection and run this file again.
    pause
    exit /b 1
  )
)
echo   [ok] Dependencies installed.

REM -- 4. Production build -----------------------------------------------------
if not exist "dist\server.cjs" (
  echo   [..] Building SERA - one moment...
  call npm run build
  if errorlevel 1 (
    echo   [i] Build failed - falling back to development mode instead.
  )
)

REM -- 5. Start the server in its own window -----------------------------------
REM    v1.6.8 FIX: this used to be "cmd /k", which keeps the console window
REM    open FOREVER after the server exits — the "SERA Server tab stays open
REM    after stopping" bug. Now the window CLOSES ITSELF when the server
REM    exits normally (power button / Stop SERA.bat), and only stays open
REM    with a visible error + pause if the server CRASHED, so you can read
REM    what went wrong.
echo   [..] Starting the SERA server...
if exist "dist\server.cjs" (
  start "SERA Server" /min cmd /c "title SERA Server && set NODE_ENV=production&& set PORT=!PORT!&& (node dist\server.cjs || (echo. & echo   [X] The SERA server exited with an error. & echo. & echo       This window stays open so you can read the message above. & echo       Press any key to close it, then check the SERA GitHub issues page. & pause >nul))"
) else (
  start "SERA Server" /min cmd /c "title SERA Server && set PORT=!PORT!&& (npx tsx server.ts || (echo. & echo   [X] The SERA server exited with an error. & echo. & echo       This window stays open so you can read the message above. & echo       Press any key to close it, then check the SERA GitHub issues page. & pause >nul))"
)

REM -- 6. Wait for the API to come up, then open the desktop window ------------
set /a tries=0
:waitloop
timeout /t 1 >nul
curl --fail --silent --max-time 2 -o nul http://localhost:!PORT!/api/health >nul 2>nul
if not errorlevel 1 goto ready
set /a tries+=1
if !tries! geq 90 (
  echo   [X] The server did not come up after 90 seconds.
  echo       Look at the "SERA Server" window for the error, then run this file again.
  pause
  exit /b 1
)
goto waitloop

:ready
echo   [ok] SERA v!APP_VERSION! is live on http://localhost:!PORT!
call :launch_desktop
if "!UI_OPENED!"=="1" goto summary
timeout /t 4 >nul

:maybe_fallback
if "!UI_OPENED!"=="1" goto summary
tasklist /FI "IMAGENAME eq electron.exe" 2>nul | find /I "electron.exe" >nul
if errorlevel 1 (
  echo   [i] The desktop window did not appear - opening a standalone app window instead.
  call :open_app_window
)

:summary
echo.
echo   ============================================================
echo     SERA is running as a DESKTOP APP on your system.
echo     Look for the SERA window on your screen or taskbar.
echo.
echo       - "SERA Server" window = the AI brain. Closing it stops SERA.
echo       - Easiest stop: the power button (top-right of the app)
echo         or double-click "Stop SERA.bat" in this folder.
echo       - The SERA desktop window is the assistant itself.
echo       - No browser needed. If a standalone app window opened
echo         as a fallback, you can close it and re-run this file.
echo.
echo     On first launch pick LOCAL MODE - it runs fully offline.
echo     No Ollama yet? The app guides you - or pick Online Mode.
echo     SERA window not showing? Just run this file once more.
echo     Want it pinned like a normal app? Right-click the SERA
echo     icon on the taskbar and choose "Pin to taskbar".
echo   ============================================================
echo.
timeout /t 10 >nul
exit /b 0

REM -- Subroutine: desktop window first; auto-repair a missing Electron; -------
REM -- standalone app window (Edge/Chrome --app) before any plain browser tab. -
:launch_desktop
if exist "!ELECTRON_EXE!" (
  echo   [..] Opening the SERA desktop window...
  set "SERA_USE_EXISTING_SERVER=true"
  start "SERA" "!ELECTRON_EXE!" "!SERA_MAIN!"
  exit /b 0
)
REM Electron shell not downloaded yet - npm may have skipped its postinstall.
if exist "!ELECTRON_INSTALL!" (
  echo   [..] Desktop shell not found - downloading it now, one-time, 1-3 minutes...
  echo        Needs internet - this fixes the "opens in a Chrome tab" problem.
  node "!ELECTRON_INSTALL!"
  if exist "!ELECTRON_EXE!" (
    echo   [ok] Desktop shell installed.
    echo   [..] Opening the SERA desktop window...
    set "SERA_USE_EXISTING_SERVER=true"
    start "SERA" "!ELECTRON_EXE!" "!SERA_MAIN!"
    exit /b 0
  )
  echo   [!] Desktop shell download failed - check your internet / proxy.
  echo       Retry later by double-clicking this file again, or run in a terminal:
  echo           npm config set ignore-scripts false ^&^& npm rebuild electron
)
REM Last resort that still feels like a desktop app: a standalone window.
call :open_app_window
set "UI_OPENED=1"
exit /b 0

REM -- Subroutine: standalone app window - no tabs, no address bar. ------------
:open_app_window
if defined EDGE_EXE (
  echo   [..] Opening SERA in a standalone desktop window via Edge...
  start "SERA" "!EDGE_EXE!" --app=http://localhost:!PORT! --window-size=1440,960
  exit /b 0
)
if defined CHROME_EXE (
  echo   [..] Opening SERA in a standalone desktop window via Chrome...
  start "SERA" "!CHROME_EXE!" --app=http://localhost:!PORT! --window-size=1440,960
  exit /b 0
)
echo   [i] Edge/Chrome not found - opening your default browser.
start "" http://localhost:!PORT!
exit /b 0
