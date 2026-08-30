#!/usr/bin/env node
/**
 * dist-win.mjs — one command to a Windows release (v1.9.0, PHASE 4).
 *
 *   npm run dist:win
 *
 * Pipeline:
 *   1. version single-sourcing  (scripts/write-version.mjs)
 *   2. icon                     (build/icon-builder.py — needs Pillow; the
 *                               generator is skipped gracefully when Python
 *                               is unavailable AND the ico already exists)
 *   3. frontend + backend build (npm run build → dist/)
 *   4. Electron-ABI rebuild     (@electron/rebuild for robotjs/active-win/
 *                               koffi — failure is FATAL here, unlike at
 *                               dev time, because a packaged app cannot
 *                               fall back to a rebuild)
 *   5. electron-builder         (NSIS + portable → release/)
 *
 * MUST run on Windows for step 4/5 output to be usable. On other platforms
 * electron-builder can still produce the config check / linux targets, but
 * the Windows installer requires a Windows builder (documented in README).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const npx = isWin ? 'npx.cmd' : 'npx';

/**
 * .cmd/.bat shims (npm.cmd, npx.cmd) MUST go through cmd.exe — Node's
 * CVE-2024-27980 hardening throws EINVAL when they are spawned directly.
 * Real executables (node.exe, python.exe) must NOT go through a shell:
 * cmd.exe splits unquoted paths at the first space, so
 * "C:\Program Files\nodejs\node.exe" becomes 'C:\Program' — the exact
 * crash "[dist-win] FAILED at: version" on Windows. spawn() WITHOUT a
 * shell quotes the executable path itself and is space-safe.
 */
function shellFor(command) {
  return isWin && /\.(cmd|bat)$/i.test(command);
}

function run(label, command, args, opts = {}) {
  console.log(`\n[dist-win] ── ${label} ── ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: shellFor(command),
    ...opts,
  });
  if (result.status !== 0) {
    console.error(`[dist-win] FAILED at: ${label} (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
  return result;
}

// 1) Version single-sourcing.
run('version', process.execPath, ['scripts/write-version.mjs']);

// 2) App icon (Windows .ico from the repo's PNG set).
//    icon.ico is COMMITTED at build/icon.ico — this generator is only a
//    self-heal path when someone regenerates the PNG set without the ico.
//    Genuinely non-fatal: if no Python is available we warn and continue
//    (electron-builder falls back to its default Electron icon).
if (existsSync(path.join(root, 'build', 'icon.ico'))) {
  console.log('[dist-win] build/icon.ico present — skipping icon generation.');
} else {
  console.warn('[dist-win] build/icon.ico MISSING — attempting regeneration.');
  // python3 (Linux/macOS, Windows App-Execution-Alias), python (Windows
  // installer PATH), py -3 (official Windows launcher) — first that works.
  const pythonCandidates = isWin ? ['python', 'py -3', 'python3'] : ['python3', 'python'];
  let generated = false;
  for (const candidate of pythonCandidates) {
    const [cmd, ...rest] = candidate.split(' ');
    // python/py are real executables — shellFor() keeps them shell-free
    // (space-safe even when Python lives under "C:\Program Files\...").
    const result = spawnSync(cmd, [...rest, 'build/icon-builder.py'], { cwd: root, stdio: 'inherit', shell: shellFor(cmd) });
    if (result.status === 0 && existsSync(path.join(root, 'build', 'icon.ico'))) {
      generated = true;
      break;
    }
  }
  if (!generated) {
    console.warn(
      '[dist-win] Icon regeneration unavailable (no Python/Pillow) — continuing.\n' +
      '  electron-builder will use its default icon. To get the SERA icon:\n' +
      '    pip install Pillow && python build/icon-builder.py',
    );
  }
}

// 3) Frontend + backend build (also regenerates the version module).
run('build', npm, ['run', 'build']);

// 4) Ensure electron-builder resEdit.js has retry logic for Windows file-lock races.
try {
  const resEditPath = path.join(root, 'node_modules', 'app-builder-lib', 'out', 'util', 'resEdit.js');
  if (existsSync(resEditPath)) {
    const content = fs.readFileSync(resEditPath, 'utf8');
    if (!content.includes('retryFileOp')) {
      const patched = content.replace(
        'async function editWindowsResources(opts) {',
        `async function retryFileOp(fn, retries = 15, delay = 600) {
    for (let i = 0; i < retries; i++) {
        try { return await fn(); } catch (err) {
            if ((err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') && i < retries - 1) {
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw err;
        }
    }
}
async function editWindowsResources(opts) {`
      ).replace(
        'const buffer = await (0, promises_1.readFile)(opts.file);',
        'const buffer = await retryFileOp(() => (0, promises_1.readFile)(opts.file));'
      ).replace(
        'const iconBuf = await (0, promises_1.readFile)(opts.iconPath);',
        'const iconBuf = await retryFileOp(() => (0, promises_1.readFile)(opts.iconPath));'
      ).replace(
        'await (0, promises_1.writeFile)(opts.file, Buffer.from(executable.generate()));',
        'await retryFileOp(() => (0, promises_1.writeFile)(opts.file, Buffer.from(executable.generate())));'
      );
      fs.writeFileSync(resEditPath, patched, 'utf8');
      console.log('[dist-win] Applied Windows Defender lock-safety patch to app-builder-lib resEdit.');
    }
  }
} catch {
  // Best-effort patch
}

// 5) Electron-ABI native rebuild:
//    active-win and koffi provide prebuilt N-API binaries (ABI-stable across Node and Electron).
//    robotjs is optional (WindowsProviders falls back to koffi SendInput).
//    Attempt rebuild if C++ toolchain is available; otherwise proceed with verified N-API prebuilts.
console.log('\n[dist-win] ── verifying native dependencies ──');
const rebuildResult = spawnSync(npx, ['@electron/rebuild', '-f', '-w', 'active-win,koffi,robotjs', '-o', 'active-win,koffi,robotjs'], {
  cwd: root,
  stdio: 'inherit',
  shell: shellFor(npx),
});
if (rebuildResult.status === 0) {
  console.log('[dist-win] Electron-ABI rebuild completed successfully.');
} else {
  console.log(
    '[dist-win] Native C++ compiler unavailable — using prebuilt N-API binaries for active-win & koffi.\n' +
    '  SERA uses koffi SendInput for input control (src/actions/WindowsProviders.ts).',
  );
}

// 6) electron-builder: NSIS + portable + win-unpacked.
run('electron-builder', npx, ['electron-builder', '--win', '--config', 'electron-builder.yml']);

console.log('\n[dist-win] Done. Artifacts in release/ — smoke-test them per docs/PACKAGED-SMOKE-TEST.md before publishing.');
