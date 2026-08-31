const { app, BrowserWindow, desktopCapturer, ipcMain, shell, session, clipboard, Tray, Menu, Notification, nativeImage, screen } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const isDev = process.env.SERA_DEV === 'true';
const isPackagedApp = app.isPackaged;
// v1.9.0: SERA's own default port (was 3000 — collided with half the dev
// ecosystem). The BACKEND may still fall back to an ephemeral port when
// this one is busy; `resolvedPort` below tracks the ACTUAL port via the
// SERA_LISTENING_PORT stdout marker / <SERA home>/sera.port handshake file.
const preferredPort = Number(process.env.PORT || 43110);
let resolvedPort = preferredPort;
/**
 * CDP remote debugging is the mechanism Playwright uses to attach to the
 * Electron renderer for the embedded browser panel. It exposes a raw CDP
 * endpoint on the local machine that allows arbitrary JS execution in the
 * renderer — effectively full RCE if a malicious local process connects.
 *
 * Previously the switch was appended unconditionally. Now we only enable it
 * when the embedded browser is explicitly requested via either:
 *  - dev mode (SERA_DEV=true), OR
 *  - SERA_ENABLE_EMBEDDED_BROWSER=true (for prod users who want the panel)
 *
 * When disabled, the server is not given BROWSER_CDP_URL, so Playwright
 * falls back to launching its own headless chromium (the panel still works,
 * just without the in-renderer BrowserView).
 */
const enableEmbeddedBrowser = isDev || process.env.SERA_ENABLE_EMBEDDED_BROWSER === 'true';
const cdpPort = 9222;
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();
let mainWindow;
let service;
let serviceRetries = 0;
const MAX_SERVICE_RETRIES = 3;
let localSpeech;
let localSpeechStartPromise = null;
let localSpeechStopTimer = null;
let localSpeechClients = 0;
let mainTranscriptCount = 0;
let localSpeechState = 'STOPPED';
let localSpeechExitCode = null;
let shuttingDown = false;
// Resolved at startup (whenReady) and used by createWindow for the window
// icon. Module-level because createWindow lives outside the whenReady scope.
let windowIconPath = null;
let tray = null;
let hasShownTrayNotification = false;

/* ── Window State Persistence ────────────────────────────────────── */
function getWindowStateFile() {
  const dir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'SERA');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  return path.join(dir, 'window-state.json');
}

function loadWindowState() {
  try {
    const raw = fs.readFileSync(getWindowStateFile(), 'utf8');
    const state = JSON.parse(raw);
    if (state && typeof state === 'object') return state;
  } catch { /* fallback */ }
  return {
    width: 1440,
    height: 960,
    closeToTray: true,
    startMinimized: false,
  };
}

let saveStateTimer = null;
function saveWindowState(updates) {
  if (saveStateTimer) clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    try {
      const current = loadWindowState();
      const merged = { ...current, ...updates };
      fs.writeFileSync(getWindowStateFile(), JSON.stringify(merged, null, 2), 'utf8');
    } catch { /* best effort */ }
  }, 250);
}

/* ── System Tray ─────────────────────────────────────────────────── */
function createTray() {
  if (tray) return;
  const iconCandidate = windowIconPath || path.join(__dirname, '..', 'public', 'icons', 'icon-64.png');
  let trayImage;
  try {
    trayImage = nativeImage.createFromPath(iconCandidate).resize({ width: 16, height: 16 });
  } catch {
    trayImage = null;
  }
  if (!trayImage || trayImage.isEmpty()) {
    try {
      const icoCandidate = path.join(__dirname, '..', 'build', 'icon.ico');
      trayImage = nativeImage.createFromPath(icoCandidate).resize({ width: 16, height: 16 });
    } catch { /* fallback */ }
  }

  try {
    tray = new Tray(trayImage || iconCandidate);
    tray.setToolTip('SERA — Windows Voice AI Assistant');
    updateTrayMenu();

    tray.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
        return;
      }
      if (mainWindow.isVisible()) {
        if (mainWindow.isFocused()) {
          mainWindow.hide();
        } else {
          mainWindow.focus();
        }
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    });

    tray.on('double-click', () => {
      focusWindow();
    });
  } catch (err) {
    shellLog(`tray creation warning: ${err.message}`);
  }
}

function updateTrayMenu() {
  if (!tray) return;
  const state = loadWindowState();
  let isAutoStart = false;
  try { isAutoStart = app.getLoginItemSettings().openAtLogin; } catch { /* best effort */ }
  const isSpeechRunning = localSpeechState === 'STARTED' || localSpeechState === 'STARTING';

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open SERA',
      click: () => focusWindow(),
    },
    {
      label: isSpeechRunning ? 'Pause Voice Listening' : 'Start Voice Mode',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sera-tray-action', isSpeechRunning ? 'voice-stop' : 'voice-start');
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: isAutoStart,
      click: (item) => {
        try { app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true }); } catch { /* best effort */ }
      },
    },
    {
      label: 'Close to System Tray',
      type: 'checkbox',
      checked: state.closeToTray !== false,
      click: (item) => {
        saveWindowState({ closeToTray: item.checked });
      },
    },
    { type: 'separator' },
    {
      label: 'Open Log Folder',
      click: () => shell.openPath(electronLogDir()),
    },
    { type: 'separator' },
    {
      label: 'Restart SERA',
      click: () => {
        serviceRetries = 0;
        if (service && !service.killed) service.kill();
        startService();
        waitForService().then(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.reload();
          }
        }).catch((err) => console.error('[RESTART_ERROR]', err.message));
      },
    },
    {
      label: 'Quit SERA',
      click: () => {
        shuttingDown = true;
        if (service && !service.killed) service.kill();
        if (localSpeech && !localSpeech.killed) localSpeech.kill();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

/* ── v1.9.0 paths + logging ──────────────────────────────────────── */
function seraHomeDir() {
  const override = process.env.SERA_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(process.env.USERPROFILE || os.homedir(), '.sera');
}
function electronLogDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SERA', 'logs');
  }
  return path.join(os.homedir(), '.cache', 'SERA', 'logs');
}
function shellLog(line) {
  try {
    fs.mkdirSync(electronLogDir(), { recursive: true });
    fs.appendFileSync(path.join(electronLogDir(), 'electron.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch { /* never throw from logging */ }
}
/** The backend's writable dirs, passed to the child so both processes agree. */
function childDataEnv() {
  const defaultUserData = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'SERA');
  const defaultLocalData = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SERA');
  return isPackagedApp
    ? {
        SERA_PACKAGED: '1',
        SERA_RESOURCES_PATH: process.resourcesPath,
        SERA_USER_DATA: process.env.SERA_USER_DATA || defaultUserData,
        SERA_LOCAL_DATA: process.env.SERA_LOCAL_DATA || defaultLocalData,
      }
    : {
        SERA_USER_DATA: process.env.SERA_USER_DATA || defaultUserData,
        SERA_LOCAL_DATA: process.env.SERA_LOCAL_DATA || defaultLocalData,
      };
}

/** Reads the port handshake file the backend writes after binding. */
function readPortHandshakeFile() {
  try {
    const raw = fs.readFileSync(path.join(seraHomeDir(), 'sera.port'), 'utf8').trim();
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

// Only enable CDP when the embedded browser feature is on. Always-on CDP
// with no authentication was a CRITICAL security hole — any local process
// could connect to port 9222 and execute arbitrary JS in the renderer.
if (enableEmbeddedBrowser) {
  app.commandLine.appendSwitch('remote-debugging-port', String(cdpPort));
  // Bind CDP to localhost only (Electron's default, but explicit for safety).
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
}
// NOTE: The previous `--disable-features=OutOfBlinkCors` switch has been
// removed. It globally disabled Blink's CORS enforcement in the renderer,
// which is unnecessary (the renderer only loads from same-origin
// http://localhost:PORT) and dangerous (any XSS becomes a CORS bypass).

/* ── BACKEND SUPERVISION (v1.9.0 — spec §31 crash recovery) ────────
 * Dev:  `npm run dev` exactly as before.
 * Packaged (BUG L6 FIX): process.execPath is SERA.exe — spawning it with a
 * script argument would RELAUNCH the app. ELECTRON_RUN_AS_NODE=1 turns the
 * same exe into a plain Node runtime for the child, so the packaged bundle
 * runs `SERA.exe dist/server.cjs` as a real backend.
 * The child's stdout is scanned for the SERA_LISTENING_PORT marker so the
 * shell follows port fallbacks transparently (handshake file as backup). */
function startService() {
  if (process.env.SERA_USE_EXISTING_SERVER === 'true') return;
  const resourcesRoot = isPackagedApp ? process.resourcesPath : path.join(__dirname, '..');
  const serverBundle = path.join(resourcesRoot, 'dist', 'server.cjs');
  const useNodeMode = !isDev;
  const command = isDev
    ? (process.platform === 'win32' ? 'npm.cmd' : 'npm')
    : process.execPath;
  const args = isDev ? ['run', 'dev'] : [serverBundle];
  // Mark the child server as running in desktop mode so the
  // ActionManager / ComputerAuthorizationManager auto-grant the trusted
  // capability set (APPLICATION_LAUNCH, KEYBOARD_CONTROL, MOUSE_CONTROL,
  // SCREEN_CAPTURE, etc.) for every session. Without this flag, every
  // capability-gated tool is silently rejected with "Capability X requires
  // authorization" until the user manually invokes
  // setComputerControlAuthorization — which the system prompt never tells
  // them to do, so the entire computer-control surface appears broken.
  // Desktop mode is the safe default: SERA only spawns this server when
  // the user has already installed and launched the app on their own
  // machine, so the trust assumption is sound.
  const childEnv = {
    ...process.env,
    ...childDataEnv(),
    NODE_ENV: isDev ? 'development' : 'production',
    PORT: String(preferredPort),
    SERA_DESKTOP_MODE: 'true',
  };
  if (useNodeMode) {
    // BUG L6: make SERA.exe behave as node for the child backend.
    childEnv.ELECTRON_RUN_AS_NODE = '1';
    childEnv.NODE_PATH = [
      path.join(resourcesRoot, 'app.asar', 'node_modules'),
      path.join(resourcesRoot, 'app.asar.unpacked', 'node_modules'),
      path.join(resourcesRoot, 'node_modules'),
      path.join(__dirname, '..', 'node_modules'),
    ].join(path.delimiter);
  }
  if (enableEmbeddedBrowser) {
    childEnv.BROWSER_CDP_URL = `http://127.0.0.1:${cdpPort}`;
  } else {
    // Don't leak a stale CDP URL from a previous dev run into a production
    // server that shouldn't be attaching to the renderer.
    delete childEnv.BROWSER_CDP_URL;
  }
  delete childEnv.ELECTRON_RUN_AS_NODE_PARENT; // hygiene

  const targetCwd = isDev
    ? path.join(__dirname, '..')
    : (childEnv.SERA_USER_DATA || path.join(os.homedir(), 'AppData', 'Roaming', 'SERA'));
  try { fs.mkdirSync(targetCwd, { recursive: true }); } catch { /* best-effort */ }

  service = spawn(command, args, {
    cwd: targetCwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: isDev && process.platform === 'win32',
  });

  service.on('error', (err) => {
    shellLog(`backend spawn error: ${err.message}`);
  });

  // Port handshake: stdout marker first, handshake file as backup.
  const scanForPort = (chunk) => {
    const match = String(chunk).match(/SERA_LISTENING_PORT=(\d+)/);
    if (match) {
      const portFromChild = Number(match[1]);
      if (Number.isInteger(portFromChild) && portFromChild > 0 && portFromChild !== resolvedPort) {
        resolvedPort = portFromChild;
        shellLog(`backend port resolved to ${resolvedPort} (preferred ${preferredPort})`);
      }
    }
  };
  service.stdout.on('data', scanForPort);
  service.stdout.on('data', (chunk) => process.stdout.write(`[SERVER] ${chunk}`));
  service.stderr.on('data', (chunk) => process.stderr.write(`[SERVER:ERR] ${chunk}`));
  shellLog(`backend spawned pid=${service.pid} dev=${isDev} packaged=${isPackagedApp}`);

  // ── CRASH RECOVERY (spec §31): retry with backoff, then an honest ──
  // error window with RESTART / OPEN LOGS (never a silent dead app).
  service.on('exit', (code, signal) => {
    if (shuttingDown || process.env.SERA_USE_EXISTING_SERVER === 'true') return;
    shellLog(`backend exited code=${code} signal=${signal} retry=${serviceRetries}/${MAX_SERVICE_RETRIES}`);
    if (serviceRetries < MAX_SERVICE_RETRIES) {
      serviceRetries += 1;
      const backoffMs = 1000 * serviceRetries;
      setTimeout(() => {
        if (!shuttingDown) {
          console.log(`[SUPERVISOR] restarting backend (attempt ${serviceRetries}/${MAX_SERVICE_RETRIES})…`);
          startService();
        }
      }, backoffMs);
    } else {
      showBackendCrashWindow(code, signal);
    }
  });
}

/** Last-resort crash window: honest report + RESTART + OPEN LOGS. */
function showBackendCrashWindow(code, signal) {
  if (mainWindow && !mainWindow.isDestroyed()) return; // UI still alive — diagnostics own it.
  const win = new BrowserWindow({
    width: 640,
    height: 420,
    title: 'SERA — backend problem',
    backgroundColor: '#05070B',
    resizable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{background:#05070B;color:#e6edf3;font:14px/1.6 system-ui,sans-serif;padding:32px;margin:0}
    h1{font-size:18px;margin:0 0 8px} p{color:#9aa7b3;margin:6px 0}
    code{background:#161b22;padding:2px 6px;border-radius:4px;font-size:12px}
    .btns{margin-top:24px;display:flex;gap:12px}
    button{padding:10px 18px;border-radius:8px;border:1px solid #30363d;background:#21262d;color:#e6edf3;font-weight:700;cursor:pointer}
    button.primary{background:#22c55e;border-color:#22c55e;color:#052e16}
  </style></head><body>
    <h1>SERA's background service stopped unexpectedly</h1>
    <p>Exit code: <code>${code ?? 'unknown'}</code>${signal ? `, signal <code>${signal}</code>` : ''}</p>
    <p>Everything you saved (memories, API keys, settings) is safe. You can restart the service now.</p>
    <div class="btns">
      <button class="primary" onclick="location.href='sera://restart'">RESTART SERA</button>
      <button onclick="location.href='sera://logs'">OPEN LOG FOLDER</button>
    </div>
    <script>
      const { ipcRenderer } = require('electron');
    </script>
  </body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => { /* best-effort */ });
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (url.includes('sera://restart')) {
      serviceRetries = 0;
      try { win.destroy(); } catch { /* already gone */ }
      startService();
      waitForService().then(() => createWindow()).catch((err) => console.error('[SUPERVISOR] restart failed:', err.message));
    } else if (url.includes('sera://logs')) {
      shell.openPath(electronLogDir());
    }
  });
}

async function createWindow() {
  const state = loadWindowState();
  let x = state.x;
  let y = state.y;
  let width = Number(state.width) || 1440;
  let height = Number(state.height) || 960;

  // Validate bounds against active displays
  if (typeof x === 'number' && typeof y === 'number') {
    try {
      const displays = screen.getAllDisplays();
      const visible = displays.some((d) => {
        const b = d.bounds;
        return x >= b.x - 50 && x <= b.x + b.width - 50 && y >= b.y - 50 && y <= b.y + b.height - 50;
      });
      if (!visible) {
        x = undefined;
        y = undefined;
      }
    } catch {
      x = undefined;
      y = undefined;
    }
  }

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === 'media');

  // Screen share support — without this handler, getDisplayMedia() rejects
  // with NotSupportedError in every Electron >= 22 (see the block above).
  registerDisplayMediaHandler();

  // Enforce a Content Security Policy on the renderer.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self'; " +
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "font-src 'self' https://fonts.gstatic.com data:; " +
          "img-src 'self' data: blob: https:; " +
          "media-src 'self' blob:; " +
          "connect-src 'self' ws://localhost:* wss://localhost:* http://localhost:*; " +
          "frame-ancestors 'none'",
        ],
      },
    });
  });

  mainWindow = new BrowserWindow({
    ...(typeof x === 'number' && typeof y === 'number' ? { x, y } : {}),
    width,
    height,
    title: 'SERA - Voice AI Assistant',
    backgroundColor: '#05070B',
    autoHideMenuBar: true,
    show: false,
    ...(windowIconPath ? { icon: windowIconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (state.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.on('resize', () => {
    if (!mainWindow.isMaximized()) {
      const bounds = mainWindow.getBounds();
      saveWindowState({ width: bounds.width, height: bounds.height });
    }
  });

  mainWindow.on('move', () => {
    if (!mainWindow.isMaximized()) {
      const bounds = mainWindow.getBounds();
      saveWindowState({ x: bounds.x, y: bounds.y });
    }
  });

  mainWindow.on('maximize', () => saveWindowState({ isMaximized: true }));
  mainWindow.on('unmaximize', () => saveWindowState({ isMaximized: false }));

  mainWindow.on('close', (event) => {
    if (shuttingDown) return;
    const currentState = loadWindowState();
    if (currentState.closeToTray !== false) {
      event.preventDefault();
      mainWindow.hide();
      if (!hasShownTrayNotification) {
        hasShownTrayNotification = true;
        if (Notification.isSupported()) {
          new Notification({
            title: 'SERA is running in the background',
            body: 'SERA is minimized to the system tray. Click the tray icon to reopen.',
            ...(windowIconPath ? { icon: windowIconPath } : {}),
          }).show();
        }
      }
      return;
    }
  });

  // Block top-level navigation away from the local server.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      if (!isLocal || parsed.port !== String(resolvedPort)) {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch {
      event.preventDefault();
    }
  });
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (typeof details.url === 'string' && /^https?:\/\//i.test(details.url)) {
      void shell.openExternal(details.url);
    }
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => {
    if (!state.startMinimized) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  const uiUrl = `http://localhost:${resolvedPort}`;
  await mainWindow.loadURL(uiUrl);
  if (!state.startMinimized) {
    mainWindow.show();
    mainWindow.focus();
  }
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (pendingDisplayRequest) settleDisplayRequest({});
    else closeScreenPicker();
  });
}

function focusWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * v1.9.0: waits for /api/health on the RESOLVED port. The backend prints
 * SERA_LISTENING_PORT after binding (fallback ports included); the
 * handshake file covers stdout-buffering quirks. Every probe re-reads both
 * so a fallback can never leave the shell polling a dead port.
 */
async function waitForService() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const fromFile = readPortHandshakeFile();
    if (fromFile && fromFile !== resolvedPort) {
      resolvedPort = fromFile;
    }
    try {
      const response = await fetch(`http://localhost:${resolvedPort}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Sera service did not start on port ${resolvedPort}.`);
}


ipcMain.handle('open-external', (_event, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Only http and https URLs may be opened externally.');
  return shell.openExternal(url);
});

// v1.9.0: OPEN LOG FOLDER — the MY PC diagnostics panel exposes the
// rotating logs (backend + electron shell) for support workflows. Opening
// a filesystem folder requires the shell — impossible from the renderer.
ipcMain.handle('sera-open-log-folder', () => shell.openPath(electronLogDir()));

// Clipboard writes from the renderer. The async navigator.clipboard API is
// unreliable inside Electron — focus and permission quirks make writeText()
// reject or never resolve, which is why the chat "copy" button appeared
// dead. Routing through the main-process clipboard module always works.
ipcMain.handle('sera-clipboard-write', (_event, text) => {
  try {
    if (typeof text !== 'string' || text.length === 0 || text.length > 512 * 1024) return false;
    clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('sera-get-autostart', () => {
  try { return app.getLoginItemSettings().openAtLogin; } catch { return false; }
});

ipcMain.handle('sera-set-autostart', (_event, enable) => {
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enable), openAsHidden: true });
    updateTrayMenu();
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
});

ipcMain.handle('sera-show-notification', (_event, title, body) => {
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: String(title || 'SERA'),
        body: String(body || ''),
        ...(windowIconPath ? { icon: windowIconPath } : {}),
      }).show();
    }
  } catch { /* best effort */ }
});

ipcMain.handle('sera-minimize-to-tray', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
});

// Quit from the in-app power button (v1.9.0 — BUG L10/M9 FIX): kill ONLY
// the processes this shell owns (backend child + speech worker). The old
// handler ran `taskkill /FI "WINDOWTITLE eq SERA Server*"` (killed every
// console with that title) AND a Get-NetTCPConnection port-kill that could
// terminate ANY process bound to the port — including another user's SERA
// or an unrelated app after a fallback. Ownership is the only safe kill.
ipcMain.handle('sera-quit', () => {
  shuttingDown = true;
  try { if (service && !service.killed) service.kill(); } catch { /* best-effort */ }
  try { if (localSpeech && !localSpeech.killed) localSpeech.kill(); } catch { /* best-effort */ }
  app.quit();
});

// ---------------------------------------------------------------------------
// Screen share (Display Media) in the desktop shell
//
// Since Electron 22 the built-in Chromium screen picker is gone: unless the
// app registers session.setDisplayMediaRequestHandler, EVERY
// navigator.mediaDevices.getDisplayMedia() call from the renderer rejects
// with NotSupportedError — which the SERA UI surfaced as "This browser
// cannot capture the screen." That is exactly what happened in v1.7.0–v1.8.2:
// browser share worked in Chrome during development but never inside the
// desktop window. The handler below restores it with a native source picker
// (entire screens + application windows) built on desktopCapturer.
//
// Flow: renderer calls getDisplayMedia() → handler enumerates sources →
// single source = grant immediately; otherwise open screen-picker.html in a
// sandboxed child window → user picks (or cancels / presses Esc / closes the
// window) → grant the chosen source / deny the request. One request at a
// time; the web side additionally has its own picker-timeout safety net.
let pendingDisplayRequest = null;
let pickerWindow = null;

function closeScreenPicker() {
  if (pickerWindow && !pickerWindow.isDestroyed()) {
    // Drop the 'closed' listener first so tearing the window down here can
    // never re-enter settleDisplayRequest for an already-settled request.
    pickerWindow.removeAllListeners('closed');
    pickerWindow.destroy();
  }
  pickerWindow = null;
}

/** Resolve the pending display-media request exactly once. */
function settleDisplayRequest(streams) {
  const pending = pendingDisplayRequest;
  if (!pending) return;
  pendingDisplayRequest = null;
  closeScreenPicker();
  try {
    pending.callback(streams);
  } catch (error) {
    console.error('[DISPLAY_MEDIA_SETTLE_ERROR]', error.message);
  }
}

function denyDisplayRequest(callback) {
  // An empty Streams object grants nothing — Chromium fails the request,
  // which the web side maps to a clean denied/aborted error for the user.
  try {
    callback({});
  } catch (error) {
    console.error('[DISPLAY_MEDIA_DENY_ERROR]', error.message);
  }
}

function grantDisplaySource(callback, request, source) {
  const streams = { video: { id: source.id, name: source.name } };
  // SERA requests audio:false today; keep the door open for a future
  // "share tab/system audio" toggle — system loopback is Windows-only.
  if (request && request.audioRequested && process.platform === 'win32') {
    streams.audio = 'loopback';
  }
  try {
    callback(streams);
  } catch (error) {
    console.error('[DISPLAY_MEDIA_GRANT_ERROR]', error.message);
  }
}

function registerDisplayMediaHandler() {
  // useSystemPicker: on macOS 15+ the OS-native picker is used and this
  // handler is not even invoked; everywhere else we show our own picker.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    resolveDisplayRequest(request, callback).catch((error) => {
      console.error('[DISPLAY_MEDIA_HANDLER_ERROR]', error.message);
      denyDisplayRequest(callback);
    });
  }, { useSystemPicker: true });
}

async function resolveDisplayRequest(request, callback) {
  if (!request.videoRequested) {
    // Audio-only display capture is not a thing SERA does — deny cleanly.
    denyDisplayRequest(callback);
    return;
  }
  if (pendingDisplayRequest) {
    // A picker is already open; deny the overlapping request instead of
    // stacking a second modal on top of the first.
    denyDisplayRequest(callback);
    return;
  }

  let sources = [];
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
  } catch (error) {
    console.error('[DISPLAY_MEDIA_SOURCES_ERROR]', error.message);
  }

  // Screens first, then windows. Windows without a thumbnail are almost
  // always invisible ghost windows of background processes — the native
  // Chromium picker hides them too, so we filter them out. Screens are
  // always real captures and are always kept.
  const screens = sources.filter((source) => source.id.startsWith('screen:') && source.name);
  const windows = sources.filter(
    (source) => source.id.startsWith('window:') && source.name && source.thumbnail && !source.thumbnail.isEmpty(),
  );
  const usable = screens.concat(windows);

  if (usable.length === 0) {
    denyDisplayRequest(callback);
    return;
  }
  if (usable.length === 1) {
    // One surface only — no picker needed, grant it directly.
    grantDisplaySource(callback, request, usable[0]);
    return;
  }

  pendingDisplayRequest = { callback, request, sources: usable };
  openScreenPicker();
}

function openScreenPicker() {
  closeScreenPicker();
  const hasParent = mainWindow && !mainWindow.isDestroyed();
  pickerWindow = new BrowserWindow({
    width: 760,
    height: 620,
    minWidth: 520,
    minHeight: 420,
    title: 'Choose what to share',
    backgroundColor: '#05070B',
    autoHideMenuBar: true,
    show: false,
    resizable: true,
    ...(hasParent ? { parent: mainWindow, modal: true } : {}),
    ...(windowIconPath ? { icon: windowIconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'picker-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Own session partition: the picker page must not inherit the main
      // session's CSP/permission plumbing — or any of its storage.
      partition: 'sera-screen-picker',
    },
  });
  pickerWindow.removeMenu();
  pickerWindow.once('ready-to-show', () => pickerWindow.show());
  pickerWindow.on('closed', () => {
    pickerWindow = null;
    // Closed without a selection (Esc, Cancel, X button) → deny.
    settleDisplayRequest({});
  });
  pickerWindow
    .loadFile(path.join(__dirname, 'screen-picker.html'))
    .catch((error) => {
      console.error('[SCREEN_PICKER_LOAD_ERROR]', error.message);
      settleDisplayRequest({});
    });
}

ipcMain.handle('screen-picker:get-sources', () => {
  if (!pendingDisplayRequest) return [];
  return pendingDisplayRequest.sources.map((source) => ({
    id: source.id,
    name: source.name,
    kind: source.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail: safeImageDataUrl(source.thumbnail),
    appIcon: safeImageDataUrl(source.appIcon),
  }));
});

function safeImageDataUrl(image) {
  try {
    return image && !image.isEmpty() ? image.toDataURL() : null;
  } catch {
    return null;
  }
}

ipcMain.handle('screen-picker:select', (_event, id) => {
  if (typeof id !== 'string' || !pendingDisplayRequest) return { ok: false };
  const source = pendingDisplayRequest.sources.find((entry) => entry.id === id);
  if (!source) return { ok: false };
  settleDisplayRequest({
    video: { id: source.id, name: source.name },
    ...(pendingDisplayRequest.request.audioRequested && process.platform === 'win32'
      ? { audio: 'loopback' }
      : {}),
  });
  return { ok: true };
});

ipcMain.handle('screen-picker:cancel', () => {
  settleDisplayRequest({});
  return { ok: true };
});

ipcMain.handle('local-speech-start', () => {
  console.log('[SPEECH_START_REQUEST]');
  localSpeechClients += 1;
  console.log(`[LOCAL_SPEECH_OWNERS] ${localSpeechClients}`);
  if (localSpeechStopTimer) {
    clearTimeout(localSpeechStopTimer);
    localSpeechStopTimer = null;
    console.log('[LOCAL_SPEECH_STOP_CANCELLED]');
  }
  if (localSpeech && localSpeech.exitCode === null && !localSpeech.killed) {
    console.log(`[SPEECH_START_RESULT] state=${localSpeechState} pid=${localSpeech.pid}`);
    return { state: localSpeechState, pid: localSpeech.pid, exitCode: localSpeechExitCode };
  }
  if (localSpeech) {
    console.log(`[LOCAL_SPEECH_STALE_CHILD] pid=${localSpeech.pid} exitCode=${localSpeech.exitCode}`);
    localSpeech = null;
  }
  if (localSpeechStartPromise) return localSpeechStartPromise;
  localSpeechState = 'STARTING';
  localSpeechExitCode = null;
  localSpeechStartPromise = new Promise((resolve, reject) => {
  // v1.9.0 (BUG L7 FIX): the worker used to require an EXTERNAL Node.js
  // (hardcoded C:\Program Files\nodejs\node.exe) — packaged installs
  // don't have one. Packaged: SERA.exe + ELECTRON_RUN_AS_NODE=1 is the
  // runtime. Dev: the repo's own node (npm_node_execpath) as before.
  const nodeExecutable = isPackagedApp
    ? process.execPath
    : (process.env.npm_node_execpath || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'));
  // v1.6.9 FIX: the worker used to inherit a MINIMAL env (PATH, SystemRoot,
  // TEMP, …). That broke the PowerShell worker in the field: PowerShell's
  // module autoloading relies on PSModulePath, cmd.exe helpers on ComSpec,
  // and .NET/Get-PnpDevice on windir — with them missing, Get-PnpDevice and
  // even Add-Type could fail, killing wake-word on machines where the same
  // worker ran fine from a normal shell. Inherit the FULL environment.
  const speechEnv = { ...process.env };
  if (isPackagedApp) {
    speechEnv.ELECTRON_RUN_AS_NODE = '1';
    speechEnv.NODE_PATH = [
      path.join(process.resourcesPath, 'app.asar', 'node_modules'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules'),
      path.join(process.resourcesPath, 'node_modules'),
    ].join(path.delimiter);
  }
  const worker = spawn(nodeExecutable, [path.join(__dirname, 'speech-host.cjs')], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: speechEnv,
  });
  localSpeech = worker;
  console.log(`[SPEECH_WORKER_SPAWN] pid=${worker.pid}`);
  console.log(`[SPEECH_WORKER_PID] ${worker.pid}`);
  worker.on('error', (error) => {
    console.error('[LOCAL_SPEECH_ERROR]', error.message);
    // Clear the in-flight promise so subsequent callers don't get a stale
    // rejected promise. The previous code only cleared it on `exit`, which
    // meant a spawn-time `error` event left the next caller waiting on a
    // promise that would never settle from their perspective.
    if (localSpeech === worker) {
      localSpeechStartPromise = null;
      localSpeechState = 'ERROR';
      localSpeechClients = 0;
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('local-speech-error', { message: error.message });
  });
  worker.stdout.setEncoding('utf8');
  let pending = '';
  worker.stdout.on('data', (chunk) => {
    console.log(`[SPEECH_WORKER_STDOUT] bytes=${Buffer.byteLength(chunk)}`);
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const payload = JSON.parse(line);
        if (payload.type === 'transcript') {
          mainTranscriptCount += 1;
          payload.mainTranscriptCount = mainTranscriptCount;
          console.log(`[LOCAL_SPEECH_STDOUT] IPC_TRANSCRIPT text=${JSON.stringify(payload.text)} mainCount=${mainTranscriptCount}`);
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('local-speech-transcript', payload);
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (payload.type === 'status') {
              localSpeechState = payload.status || localSpeechState;
              if (payload.status === 'STARTED') console.log('[SPEECH_WORKER_ENGINE_RUNNING]');
              mainWindow.webContents.send('local-speech-status', payload);
            }
            if (payload.type === 'error') {
              if (payload.event === 'MIC_SIGNAL_ERROR') mainWindow.webContents.send('local-speech-diagnostic', payload);
              else mainWindow.webContents.send('local-speech-error', payload);
            }
          if (payload.type === 'audio' || payload.type === 'diagnostic') mainWindow.webContents.send('local-speech-diagnostic', payload);
        }
        // For error events the human-readable `message` is the whole point —
        // the old ordering printed `event` first, which hid WHY SAPI failed
        // (users only ever saw "ERROR: SAPI_RECOGNIZE_ERROR" with no reason).
        const detail = payload.type === 'error'
          ? (payload.message || payload.event || 'unknown error')
          : (payload.text || payload.status || payload.event || payload.message || payload.name || (payload.level !== undefined ? `level=${payload.level}` : ''));
        console.log(`[SERA_LOCAL_SPEECH] ${String(payload.type).toUpperCase()}${payload.event && payload.type === 'error' && payload.message ? ` (${payload.event})` : ''}: ${detail}`);
      } catch (error) {
        console.error('[LOCAL_SPEECH_PARSE_ERROR]', error.message);
      }
    }
  });
  worker.stderr.on('data', (chunk) => console.error('[SPEECH_WORKER_STDERR]', String(chunk).trim()));
  worker.on('exit', (code, signal) => {
    const isCleanExit = code === 0 || code === 4294770688 || code === 3221225786 || worker.killed || worker._isStopping || signal === 'SIGTERM' || signal === 'SIGINT';
    localSpeechState = isCleanExit ? 'STOPPED' : 'ERROR';
    localSpeechExitCode = code;
    console.log(`[SPEECH_WORKER_EXIT] pid=${worker.pid} code=${code ?? 'unknown'} signal=${signal || worker.signalCode || 'none'} killed=${worker.killed} isStopping=${Boolean(worker._isStopping)} isCleanExit=${isCleanExit}`);
    if (!isCleanExit && code !== null && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('local-speech-error', { message: `Local speech process stopped (exit code ${code}).` });
    }
    if (localSpeech === worker) {
      localSpeech = null;
      localSpeechStartPromise = null;
      localSpeechClients = 0;
    }
  });
  worker.on('close', (code, signal) => console.log(`[SPEECH_WORKER_CLOSE] pid=${worker.pid} code=${code ?? 'unknown'} signal=${signal || 'none'}`));
  // Wrap reject so the in-flight promise is also cleared on a one-shot
  // spawn error — otherwise the next local-speech-start caller would get
  // a stale, already-rejected promise back from the previous attempt.
  const rejectAndReset = (err) => {
    if (localSpeech === worker) {
      localSpeechStartPromise = null;
      localSpeechState = 'ERROR';
      localSpeechClients = 0;
    }
    reject(err);
  };
  worker.once('error', rejectAndReset);
  worker.once('spawn', () => {
    console.log('[LOCAL_SPEECH_PROCESS_STARTED]');
    resolve({ state: localSpeechState, pid: worker.pid, exitCode: localSpeechExitCode });
  });
  });
  return localSpeechStartPromise;
});

ipcMain.handle('local-speech-state', () => ({
  state: localSpeech && localSpeech.exitCode === null && !localSpeech.killed ? localSpeechState : (localSpeechState === 'ERROR' ? 'ERROR' : 'STOPPED'),
  pid: localSpeech?.pid || null,
  exitCode: localSpeechExitCode,
  owners: localSpeechClients,
}));

ipcMain.handle('local-speech-stop', () => {
  localSpeechClients = Math.max(0, localSpeechClients - 1);
  console.log(`[LOCAL_SPEECH_STOP_REQUESTED] owners=${localSpeechClients}`);
  if (localSpeechClients > 0) return true;
  if (localSpeech) {
    localSpeech._isStopping = true;
  }
  if (localSpeechStopTimer) clearTimeout(localSpeechStopTimer);
  localSpeechStopTimer = setTimeout(() => {
    if (localSpeech && !localSpeech.killed) {
      console.log(`[LOCAL_SPEECH_STOP] pid=${localSpeech.pid}`);
      localSpeech._isStopping = true;
      localSpeech.kill();
    }
    localSpeech = null;
    localSpeechStartPromise = null;
    localSpeechStopTimer = null;
  }, 250);
  return true;
});

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;

  // Group the window, taskbar entry and notifications under the SERA app id
  // instead of a bare "Electron" identity on Windows. Without this, Windows
  // shows the generic Electron icon and toast notifications can be misfiled.
  try { app.setAppUserModelId('com.beku16.sera'); } catch {}

  // Runtime window/taskbar icon. On Windows the exe's embedded icon is used
  // for the taskbar, but passing the PNG here keeps the window icon
  // consistent (and on Linux it is the only way to get a proper taskbar
  // icon). Icons are generated into public/icons and shipped in the repo.
  try {
    const fs = require('node:fs');
    const candidate = path.join(__dirname, '..', 'public', 'icons', 'icon-512.png');
    if (fs.existsSync(candidate)) windowIconPath = candidate;
  } catch {}

  createTray();
  startService();
  await waitForService();
  await createWindow();
}).catch((err) => {
  shellLog(`whenReady error: ${err.stack || err.message}`);
});

app.on('second-instance', () => focusWindow());
process.on('uncaughtException', (error) => {
  shellLog(`uncaughtException: ${error.stack || error.message}`);
  console.error('[ELECTRON_UNCAUGHT_EXCEPTION]', error.stack || error.message);
});
process.on('unhandledRejection', (error) => {
  shellLog(`unhandledRejection: ${String(error)}`);
  console.error('[ELECTRON_UNHANDLED_REJECTION]', error);
});

app.on('window-all-closed', () => {
  shellLog('window-all-closed');
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  shellLog('before-quit');
  if (shuttingDown) return;
  shuttingDown = true;
  if (service && !service.killed) service.kill();
  if (localSpeech && !localSpeech.killed) localSpeech.kill();
});
