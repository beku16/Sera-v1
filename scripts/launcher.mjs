#!/usr/bin/env node
/**
 * SERA launcher — the Smart App Control-proof entry point.
 *
 * Why this file exists: Windows Smart App Control blocks unsigned script
 * FILES (a downloaded .bat from a zero-reputation repo) with NO override
 * dialog. But SAC cannot block signed, high-reputation executables:
 * npm.cmd / node.exe (official Node installer), cmd.exe, powershell.exe
 * running INLINE commands, and GitHub's signed electron.exe.
 *
 * So the SAC-safe way to start SERA is:
 *     open a terminal in the SERA folder  ->  npm start
 * ("start" is wired to this file in package.json). This launcher then does
 * everything "Start SERA.bat" does:
 *
 *   0. self-unblock  — strips Windows' Mark-of-the-Web from the whole
 *                      folder (inline PowerShell: no script file to block)
 *   1. version gate  — detects an already-running OLD server and explains
 *                      how to kill it instead of serving you a stale app
 *   2. dependencies  — npm install (first run, or whenever package files
 *                      change after an update). Also keeps package-lock.json
 *                      clean so "git pull" never gets blocked
 *   3. build         — dist/server.cjs (first run only)
 *   4. server        — visible "SERA Server" console on Windows, detached
 *                      background process + log on macOS/Linux
 *   5. desktop       — Electron window (auto-repairs a missing shell by
 *                      re-running electron's installer); falls back to a
 *                      standalone Edge/Chrome --app window; a plain browser
 *                      tab only as the true last resort
 *
 * Set SERA_NO_UI=1 to skip step 5 (used by CI / headless testing).
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const PORT = Number(process.env.PORT || 43110);
const BASE = `http://localhost:${PORT}`;
const LOG = path.join(ROOT, 'sera-server.log');

const APP_VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
).version;

const c = (code, s) => (process.stdout.isTTY ? `\u001b[${code}m${s}\u001b[0m` : s);
const ok = (s) => console.log(c('32', `  [ok] ${s}`));
const step = (s) => console.log(c('36', `  [..] ${s}`));
const warn = (s) => console.log(c('33', `  [!] ${s}`));
const fail = (s) => console.log(c('31', `  [X] ${s}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getHealth(timeoutMs = 2000) {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Run a command, inheriting our stdio, with Node-friendly npm handling. */
function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: IS_WIN, // npm.cmd needs a shell on Windows
  });
  return r.status === 0;
}

/* ── Dependency freshness + git hygiene ──────────────────────────────
 * npm runs with whatever npm version the user's machine has, and a
 * different npm version can normalize package-lock.json differently -
 * so a plain `npm install` can rewrite that file and leave it
 * "modified". A dirty lockfile then makes the next `git pull` abort
 * with "your local changes would be overwritten" (real user report).
 *
 * Two fixes, both invisible to the user:
 *   1. In a git checkout, restore package-lock.json whenever npm
 *      dirtied it (users never hand-edit that file).
 *   2. Track a fingerprint of package.json + package-lock.json inside
 *      node_modules, and re-install automatically whenever it changes
 *      (e.g. after a git pull) - instead of only installing once ever.
 * ─────────────────────────────────────────────────────────────────── */
const DEPS_SHA_FILE = path.join(ROOT, 'node_modules', '.sera-deps-sha');

function depsSha() {
  return createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, 'package.json')))
    .update(fs.readFileSync(path.join(ROOT, 'package-lock.json')))
    .digest('hex');
}

function needsInstall() {
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) return true;
  try {
    return fs.readFileSync(DEPS_SHA_FILE, 'utf8').trim() !== depsSha();
  } catch {
    return true; // no fingerprint yet (older install) - refresh once to create it
  }
}

function rememberDepsSha() {
  try {
    fs.writeFileSync(DEPS_SHA_FILE, `${depsSha()}\n`);
  } catch {
    /* node_modules not writable - worst case: install runs again next time */
  }
}

function restoreLockfile() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return; // ZIP download - nothing to restore
  try {
    const dirty = execFileSync(
      'git', ['status', '--porcelain', '--', 'package-lock.json'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (dirty.trim()) {
      execFileSync('git', ['checkout', '--', 'package-lock.json'], { cwd: ROOT, stdio: 'ignore' });
      ok('package-lock.json restored - your next "git pull" stays clean.');
    }
  } catch {
    /* git not installed / not a repo / mid-merge - nothing to do */
  }
}

/** Detached spawn that survives this launcher exiting. */
function spawnDetached(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    ...opts,
  });
  child.unref();
  return child;
}

/* -- 0. Self-unblock (Windows only) --------------------------------------- */
function selfUnblock() {
  if (!IS_WIN) return;
  const ps =
    '$n=0; $root=(Get-Location).Path; ' +
    "Get-ChildItem -LiteralPath $root -Force -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.Name -ne 'node_modules' -and $_.Name -ne '.git' } | " +
    'ForEach-Object { ' +
    'if ($_.PSIsContainer) { ' +
    'Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | ' +
    'Where-Object { Get-Item -LiteralPath $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue } | ' +
    'ForEach-Object { $n++; Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue } ' +
    '} else { ' +
    'if (Get-Item -LiteralPath $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue) { $n++; Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue } ' +
    '} }; if ($n -gt 0) { exit 9 }';
  try {
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { cwd: ROOT, stdio: 'ignore', timeout: 120000 },
    );
    if (r.status === 9) {
      step('One-time setup: removed Windows download-block flags from this folder.');
      console.log('      You will not be asked to unblock files again.\n');
    }
  } catch {
    /* PowerShell unavailable — MOTW cleanup is best-effort, never fatal. */
  }
}

/* -- Electron helpers ------------------------------------------------------ */
function electronPaths() {
  if (IS_WIN) {
    return {
      exe: path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
      installer: path.join(ROOT, 'node_modules', 'electron', 'install.js'),
      main: path.join(ROOT, 'electron', 'main.cjs'),
    };
  }
  if (IS_MAC) {
    return {
      exe: path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
      installer: path.join(ROOT, 'node_modules', 'electron', 'install.js'),
      main: path.join(ROOT, 'electron', 'main.cjs'),
    };
  }
  return {
    exe: path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron'),
    installer: path.join(ROOT, 'node_modules', 'electron', 'install.js'),
    main: path.join(ROOT, 'electron', 'main.cjs'),
  };
}

/** Launch the Electron desktop window. Returns true if the process started. */
function launchDesktop() {
  const { exe, installer, main } = electronPaths();
  if (fs.existsSync(exe)) {
    step('Opening the SERA desktop window...');
    spawnDetached(exe, [main], {
      env: { ...process.env, SERA_USE_EXISTING_SERVER: 'true', PORT: String(PORT) },
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  }
  // Desktop shell not downloaded yet — npm may have skipped its postinstall.
  if (fs.existsSync(installer)) {
    step('Desktop shell not found - downloading it now (one-time, 1-3 minutes)...');
    console.log('      Needs internet - this is what makes SERA a real desktop window.');
    const r = spawnSync(process.execPath, [installer], { cwd: ROOT, stdio: 'inherit' });
    if (r.status === 0 && fs.existsSync(exe)) {
      ok('Desktop shell installed.');
      step('Opening the SERA desktop window...');
      spawnDetached(exe, [main], {
        env: { ...process.env, SERA_USE_EXISTING_SERVER: 'true', PORT: String(PORT) },
        stdio: 'ignore',
        windowsHide: true,
      });
      return true;
    }
    warn('Desktop shell download failed - check your internet / proxy.');
    console.log('      Retry by running npm start again, or fix npm and run:');
    console.log('          npm config set ignore-scripts false && npm rebuild electron');
  } else {
    warn('Desktop shell package missing - run "npm install" once, then npm start again.');
  }
  return false;
}

/** Standalone Edge/Chrome --app window: desktop feel, no tabs, no address bar. */
function findChromiumBrowser() {
  if (IS_WIN) {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const lad = process.env['LocalAppData'] || '';
    const candidates = [
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(lad, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    return candidates.find((p) => p && fs.existsSync(p)) || null;
  }
  if (IS_MAC) {
    const candidates = [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    return candidates.find((p) => fs.existsSync(p)) || null;
  }
  for (const b of ['microsoft-edge', 'microsoft-edge-stable', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync('which', [b], { stdio: 'ignore' });
    if (r.status === 0) return b;
  }
  return null;
}

function openAppWindow() {
  const browser = findChromiumBrowser();
  if (browser) {
    step(`Opening SERA in a standalone desktop window via ${path.basename(browser)}...`);
    spawnDetached(browser, [`--app=${BASE}`, '--window-size=1440,960']);
    return true;
  }
  return false;
}

function openFallbackUi() {
  if (openAppWindow()) return;
  step('Opening your browser (last resort)...');
  try {
    if (IS_WIN) {
      spawnDetached('cmd.exe', ['/d', '/s', '/c', `start "" ${BASE}`], { windowsVerbatimArguments: true });
    } else if (IS_MAC) {
      spawnDetached('open', [BASE]);
    } else {
      spawnDetached('xdg-open', [BASE]);
    }
  } catch {
    console.log(`      Open ${BASE} manually in your browser.`);
  }
}

/* -- Desktop shortcut (Windows only) ---------------------------------------- *
 * SAC users can never double-click Start SERA.bat (unsigned script file),
 * so after a successful launch we (re)write a "Start SERA" shortcut on the
 * desktop that points at cmd.exe -> npm start in this folder. cmd.exe and
 * node.exe are signed, trusted programs, so the shortcut is exactly as
 * SAC-proof as typing npm start — but from now on it is a plain double-click.
 * The shortcut is refreshed on every launch, so it self-heals if the SERA
 * folder is moved. Opt out with SERA_NO_SHORTCUT=1.
 */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function createDesktopShortcut() {
  if (!IS_WIN || process.env.SERA_NO_SHORTCUT === '1') return;
  const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const rootQ = psQuote(ROOT);
  const ps =
    '$ws = New-Object -ComObject WScript.Shell; ' +
    "$lnk = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\\Start SERA.lnk'); " +
    '$lnk.TargetPath = $env:ComSpec; ' +
    "$lnk.Arguments = '/d /c npm start'; " +
    `$lnk.WorkingDirectory = ${rootQ}; ` +
    `if (Test-Path ${psQuote(electronExe)}) { ` +
    `$lnk.IconLocation = ${psQuote(electronExe + ',0')} } ` +
    '$lnk.Save()';
  try {
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { cwd: ROOT, stdio: 'ignore', timeout: 60000 },
    );
    if (r.status === 0) {
      ok('Desktop shortcut ready: "Start SERA" on your desktop — double-click it from now on.');
    }
  } catch {
    /* Shortcut creation is best-effort; npm start itself always works. */
  }
}

/* -- Server ---------------------------------------------------------------- */
function startServer() {
  const serverJs = path.join(ROOT, 'dist', 'server.cjs');
  const useBundle = fs.existsSync(serverJs);
  if (IS_WIN) {
    // Visible, minimized console window — closing it stops SERA (same UX as
    // Start SERA.bat). windowsVerbatimArguments keeps the nested quotes.
    const inner =
      `title SERA Server && set NODE_ENV=production&& set PORT=${PORT}&& ` +
      (useBundle ? `node "${serverJs}"` : 'npx tsx server.ts');
    spawnDetached(
      'cmd.exe',
      ['/d', '/s', '/c', `start "SERA Server" /min cmd /k "${inner}"`],
      { windowsVerbatimArguments: true },
    );
  } else {
    const out = fs.openSync(LOG, 'a');
    const child = spawn(
      process.execPath,
      useBundle ? [serverJs] : [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'server.ts')],
      {
        cwd: ROOT,
        detached: true,
        stdio: ['ignore', out, out],
        env: { ...process.env, NODE_ENV: useBundle ? 'production' : 'development', PORT: String(PORT) },
      },
    );
    child.unref();
  }
}

async function waitForServer(seconds = 90) {
  for (let i = 0; i < seconds; i += 1) {
    const health = await getHealth();
    if (health) return health;
    await sleep(1000);
  }
  return null;
}

/* -- Main ------------------------------------------------------------------- */
async function main() {
  console.log('');
  console.log('  ============================================================');
  console.log('    S E R A   -   Local-First Voice AI Desktop Assistant');
  console.log(`    npm start  -  v${APP_VERSION}  -  github.com/beku16/sera`);
  console.log('  ============================================================');
  console.log('');

  // 0. Self-unblock (Windows).
  selfUnblock();

  ok(`Node.js ${process.version} found.`);

  // Git hygiene: if a previous npm install dirtied package-lock.json,
  // restore it now so an update via "git pull" cannot get blocked.
  restoreLockfile();

  // 1. Already running? Verify the version so a stale server can't serve
  //    an old app after a folder update.
  const existing = await getHealth();
  if (existing) {
    if (existing.version !== APP_VERSION) {
      fail(`An OLD SERA server (v${existing.version || 'unknown'}) is still running on port ${PORT}.`);
      console.log('      You updated the folder, but the old server is still serving the old app.');
      console.log('');
      if (IS_WIN) {
        console.log('      FIX: close the "SERA Server" window - or run this in a terminal:');
        console.log('           taskkill /F /IM node.exe');
      } else {
        console.log('      FIX: run this in a terminal:');
        console.log('           pkill -f dist/server.cjs');
      }
      console.log('      Then wait 5 seconds and run npm start again.');
      process.exit(1);
    }
    ok(`SERA v${APP_VERSION} is already running on port ${PORT}.`);
  } else {
    // 2. Dependencies (first run, or whenever package files changed -
    //    e.g. after a git pull). Fingerprint-tracked, not one-shot.
    if (needsInstall()) {
      const firstRun = !fs.existsSync(path.join(ROOT, 'node_modules'));
      step(firstRun ? 'First run detected - installing dependencies.'
                    : 'Dependencies changed by the update - refreshing them.');
      console.log('      One-time setup, can take 5-10 minutes.');
      console.log('      It also downloads the automation browser in the background.');
      console.log('');
      if (!run(IS_WIN ? 'npm.cmd' : 'npm', ['install'])) {
        fail('npm install failed. Check your internet connection and run npm start again.');
        process.exit(1);
      }
      restoreLockfile(); // npm may have rewritten it - keep git pull clean
      rememberDepsSha(); // ...and remember what we installed
    }
    ok('Dependencies installed.');

    // 3. Production build.
    if (!fs.existsSync(path.join(ROOT, 'dist', 'server.cjs'))) {
      step('Building SERA - one moment...');
      if (!run(IS_WIN ? 'npm.cmd' : 'npm', ['run', 'build'])) {
        warn('Build failed - will fall back to development mode.');
      }
    }

    // 4. Server.
    step('Starting the SERA server...');
    startServer();
    const health = await waitForServer();
    if (!health) {
      fail('The server did not come up after 90 seconds.');
      if (IS_WIN) {
        console.log('      Look at the "SERA Server" window for the error, then try again.');
      } else {
        console.log(`      Check ${LOG} for the error, then try again.`);
      }
      process.exit(1);
    }
    // The bundle on disk can be older than this launcher (e.g. the user
    // updated the folder but dist/ is a leftover). Never celebrate a stale
    // app — rebuild it.
    if (health.version !== APP_VERSION) {
      warn(`The built app on disk is v${health.version || 'unknown'}, but v${APP_VERSION} is expected.`);
      step('Rebuilding SERA to match...');
      if (!run(IS_WIN ? 'npm.cmd' : 'npm', ['run', 'build'])) {
        fail('Build failed. Delete the dist folder and run npm start again.');
        process.exit(1);
      }
      step('Restarting the SERA server...');
      if (IS_WIN) {
        spawnSync('taskkill', ['/F', '/IM', 'node.exe'], { stdio: 'ignore' });
      } else {
        spawnSync('pkill', ['-f', 'dist/server.cjs'], { stdio: 'ignore' });
      }
      await sleep(3000);
      startServer();
      const health2 = await waitForServer();
      if (!health2 || health2.version !== APP_VERSION) {
        fail('The server is still serving an old build. Restart the machine and run npm start again.');
        process.exit(1);
      }
    }
  }
  ok(`SERA v${APP_VERSION} is live on ${BASE}`);

  // 4.5 Desktop shortcut (Windows): makes every future launch a double-click,
  //     even under Smart App Control.
  createDesktopShortcut();

  // 5. Desktop window.
  if (process.env.SERA_NO_UI === '1') {
    console.log('  [i] SERA_NO_UI=1 - skipping the desktop window.');
  } else {
    const started = launchDesktop();
    if (started) {
      await sleep(4000);
      // Electron alive? If it died instantly (blocked / GPU / AV), fall back
      // to a standalone app window instead of leaving the user with nothing.
      let alive = true;
      if (IS_WIN) {
        const t = spawnSync('tasklist', ['/FI', 'IMAGENAME eq electron.exe'], { stdio: 'ignore' });
        alive = t.status === 0;
      } else {
        const t = spawnSync('pgrep', ['-f', 'electron/main.cjs'], { stdio: 'ignore' });
        alive = t.status === 0;
      }
      if (!alive) {
        warn('Desktop window did not appear - opening a standalone app window instead.');
        openFallbackUi();
      }
    } else {
      openFallbackUi();
    }
  }

  console.log('');
  console.log('  ============================================================');
  console.log('    SERA is running as a DESKTOP APP on your system.');
  console.log('    Look for the SERA window on your screen or taskbar.');
  console.log('');
  if (IS_WIN) {
    console.log('      - "SERA Server" window = the AI brain. Closing it stops SERA.');
  } else {
    console.log(`      - Server runs in the background (log: ${LOG}).`);
    console.log('        Stop it with: pkill -f dist/server.cjs');
  }
  console.log('      - The SERA desktop window is the assistant itself.');
  console.log('');
  console.log('    On first launch pick LOCAL MODE - it runs fully offline.');
  console.log('    No Ollama yet? The app guides you - or pick Online Mode.');
  console.log('    SERA window not showing? Just run npm start once more.');
  console.log('  ============================================================');
  console.log('');
}

main().catch((err) => {
  fail(err && err.message ? err.message : String(err));
  process.exit(1);
});
