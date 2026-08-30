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

function run(label, command, args, opts = {}) {
  console.log(`\n[dist-win] ── ${label} ── ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWin,
    ...opts,
  });
  if (result.status !== 0) {
    console.error(`[dist-win] FAILED at: ${label} (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
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
    const cmd = candidate.split(' ')[0];
    const rest = candidate.split(' ').slice(1);
    const result = spawnSync(cmd, [...rest, 'build/icon-builder.py'], { cwd: root, stdio: 'inherit', shell: isWin });
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

// 4) Electron-ABI native rebuild. robotjs is the known-hard one (audit BUG
//    L12: Node-24 build fails; Electron 43 ABI needs VS Build Tools on the
//    builder). If this step fails, STOP: shipping an unbuilt native module
//    would only fail at runtime on the user machine.
try {
  const rebuildArgs = ['@electron/rebuild', '-f', '-w', 'robotjs,active-win,koffi', '-o', 'robotjs,active-win,koffi'];
  run('electron-abi rebuild', isWin ? 'npx.cmd' : 'npx', rebuildArgs);
} catch {
  console.error(
    '[dist-win] Native rebuild failed.\n' +
    '  Ensure Windows + Visual Studio Build Tools + Python are installed (see README → Development).\n' +
    '  SERA degrades to input fallbacks without robotjs, but the build must not ship silently broken.',
  );
  process.exit(1);
}

// 5) electron-builder: NSIS + portable.
run('electron-builder', isWin ? 'npx.cmd' : 'npx', ['electron-builder', '--win', '--config', 'electron-builder.yml']);

console.log('\n[dist-win] Done. Artifacts in release/ — smoke-test them per docs/PACKAGED-SMOKE-TEST.md before publishing.');
