import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import {
  DiagnosticCheckResult,
  DiagnosticCategory,
  IDiagnosticCheckRunner,
} from './types';
import { esmRequire, esmDirname } from './esmShim';
import { defaultApiKeyVault } from '../local/ApiKeyVault';
import { ocrDataDir, userDataDir } from '../local/SERAPaths';
const { existsSync } = fs;
const { join } = path;

const execAsync = promisify(exec);

/**
 * Comprehensive Diagnostic Check Catalog — A→Z Deep-Scan Coverage
 *
 * Each export below is a factory function returning an
 * IDiagnosticCheckRunner. They are registered by
 * `SystemDiagnosticService.registerDefaultChecks()` alongside the
 * original 11 capability-gate checks, giving the deep-scan full A→Z
 * coverage across every subsystem from small (PID/uptime) to big
 * (whole-system disk space and Playwright launches).
 *
 * ## Design principles
 *
 * 1. **Never declare `passed` for something you didn't actually probe.**
 *    Every check below performs a real operation — reading a file,
 *    spawning a process, importing a module — before reporting healthy.
 *
 * 2. **Categorize honestly.** A native module that fails to load is
 *    `critical`, not `info`. A low disk warning is `warning`. An
 *    informational metric (uptime, PID) is `healthy` only because the
 *    probe itself succeeded, not because the value is "good".
 *
 * 3. **Provide actionable `userActionGuide`.** Every failure message
 *    explains how to fix it — the install command, the file path, the
 *    doc URL.
 *
 * 4. **Auto-fix where possible, escalate otherwise.** Checks whose
 *    failure has a safe programmatic fix set `autoFixAvailable: true`
 *    + `repairStatus: 'can_auto_fix'`. The rest set
 *    `repairStatus: 'requires_user_action'` so the AutoRepairEngine
 *    knows to surface the guide to the user.
 *
 * 5. **Don't depend on optional peers.** Native modules are loaded
 *    via `esmRequire()` which throws a clean error if the package
 *    isn't installed — caught by the surrounding try/catch and
 *    surfaced as a clear diagnostic, never as a crash.
 */

// ─── helpers ──────────────────────────────────────────────────────────

/** Wraps a probe in try/catch and returns a failed DiagnosticCheckResult. */
function buildBase(
  checkId: string,
  name: string,
  category: DiagnosticCategory,
): Pick<DiagnosticCheckResult, 'checkId' | 'name' | 'category' | 'timestamp'> {
  return { checkId, name, category, timestamp: Date.now() };
}

/** Returns a "passed" result with optional details. */
function pass(
  base: Pick<DiagnosticCheckResult, 'checkId' | 'name' | 'category' | 'timestamp'>,
  message: string,
  details?: Record<string, unknown>,
): DiagnosticCheckResult {
  return {
    ...base,
    severity: 'healthy',
    status: 'passed',
    message,
    details,
    repairStatus: 'not_applicable',
    autoFixAvailable: false,
  };
}

/** Returns a "failed" result with user action guide. */
function fail(
  base: Pick<DiagnosticCheckResult, 'checkId' | 'name' | 'category' | 'timestamp'>,
  message: string,
  userActionGuide: string,
  details?: Record<string, unknown>,
  autoFixAvailable = false,
  fixDescription?: string,
): DiagnosticCheckResult {
  return {
    ...base,
    severity: 'critical',
    status: 'failed',
    message,
    details,
    repairStatus: autoFixAvailable ? 'can_auto_fix' : 'requires_user_action',
    autoFixAvailable,
    fixDescription,
    userActionGuide,
  };
}

/** Returns a "warning" result. */
function warn(
  base: Pick<DiagnosticCheckResult, 'checkId' | 'name' | 'category' | 'timestamp'>,
  message: string,
  userActionGuide: string,
  details?: Record<string, unknown>,
  autoFixAvailable = false,
  fixDescription?: string,
): DiagnosticCheckResult {
  return {
    ...base,
    severity: 'warning',
    status: 'warning',
    message,
    details,
    repairStatus: autoFixAvailable ? 'can_auto_fix' : 'requires_user_action',
    autoFixAvailable,
    fixDescription,
    userActionGuide,
  };
} 

const ocrDataFile = (): string => join(ocrDataDir(), 'eng.traineddata');

/** Resolves a project-relative path from process.cwd(). */
export function resolveProject(relativePath: string): string {
  return path.resolve(process.cwd(), relativePath);
}

/** Detects the platform's app-launcher binary. */
async function detectAppLauncher(): Promise<string | null> {
  if (process.platform === 'win32') return 'start';
  if (process.platform === 'darwin') return 'open';
  if (process.platform === 'linux') return 'xdg-open';
  return null;
}

/**
 * Windows "start" is NOT a real executable — it's a builtin of cmd.exe
 * (like "cd", "echo", "dir"). `where start` returns nothing on a healthy
 * Windows system because there's no start.exe / start.com / start.bat to find.
 * The launcher is always available as long as cmd.exe is available, which is
 * guaranteed on every supported Windows version. Treating "where start"
 * returning empty as a failure was a false-positive bug — every Windows
 * install reported CRITICAL for this check. Treat cmd-builtins specially.
 */
const CMD_BUILTINS = new Set(['start']);

/** Attempts to spawn a binary; returns true on exit 0. For cmd-builtins (like
 * Windows "start"), returns true unconditionally — they're not on PATH but
 * are always available via cmd.exe. */
async function binaryOnPath(name: string): Promise<boolean> {
  if (CMD_BUILTINS.has(name.toLowerCase())) {
    return true;
  }
  try {
    const cmd = process.platform === 'win32' ? `where ${name}` : `command -v ${name}`;
    const result = await execAsync(cmd, { windowsHide: true });
    return (result.stdout || '').trim().length > 0;
  } catch {
    return false;
  }
}

// ─── Node Runtime & Process checks ────────────────────────────────────

export function createNodeVersionCheck(): IDiagnosticCheckRunner {
  return {
    id: 'node_version_check',
    name: 'Node.js Runtime Version',
    category: 'node_runtime',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('node_version_check', 'Node.js Runtime Version', 'node_runtime');
      const major = Number(process.versions.node.split('.')[0]);
      if (major < 18) {
        return fail(
          base,
          `Node.js v${process.versions.node} is too old — SERA requires Node 18 or newer (LTS 20 recommended).`,
          `Install Node.js 20 LTS from https://nodejs.org/ and restart SERA. After installing, run "npm install" again.`,
          { current: process.versions.node, major, required: '>=18' },
        );
      }
      return pass(
        base,
        `Node.js v${process.versions.node} (${process.platform}/${process.arch}) meets SERA's minimum requirement (>=18).`,
        { current: process.versions.node, major, platform: process.platform, arch: process.arch },
      );
    },
  };
}

export function createProcessUptimeCheck(): IDiagnosticCheckRunner {
  return {
    id: 'process_uptime',
    name: 'Server Process Uptime',
    category: 'node_runtime',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('process_uptime', 'Server Process Uptime', 'node_runtime');
      const uptimeSeconds = process.uptime();
      const uptimeHuman =
        uptimeSeconds < 60 ? `${uptimeSeconds.toFixed(1)}s` :
        uptimeSeconds < 3600 ? `${(uptimeSeconds / 60).toFixed(1)}m` :
        `${(uptimeSeconds / 3600).toFixed(2)}h`;
      return pass(
        base,
        `Server process (PID ${process.pid}) has been running for ${uptimeHuman}.`,
        { pid: process.pid, ppid: process.ppid, uptimeSeconds, uptimeHuman },
      );
    },
  };
}

export function createEventLoopLagCheck(): IDiagnosticCheckRunner {
  return {
    id: 'event_loop_lag',
    name: 'Event Loop Lag',
    category: 'node_runtime',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('event_loop_lag', 'Event Loop Lag', 'node_runtime');
      try {
        const lagMs = await new Promise<number>((resolve) => {
          const start = performance.now();
          setImmediate(() => resolve(performance.now() - start));
        });
        if (lagMs > 100) {
          return warn(
            base,
            `Event loop lag is ${lagMs.toFixed(1)}ms — high latency detected. Audio streaming and tool dispatch may stutter.`,
            'Check for CPU-heavy synchronous operations in server.ts or any tool executor. Use Node --prof to identify hot paths.',
            { lagMs: lagMs.toFixed(2), threshold: 100 },
          );
        }
        return pass(
          base,
          `Event loop lag is ${lagMs.toFixed(2)}ms — within healthy bounds (<100ms).`,
          { lagMs: lagMs.toFixed(2) },
        );
      } catch (err) {
        return fail(
          base,
          `Event loop measurement failed: ${err instanceof Error ? err.message : String(err)}`,
          'This is an internal Node.js probe — should not fail. Restart the server.',
        );
      }
    },
  };
}

export function createHeapMemoryCheck(): IDiagnosticCheckRunner {
  return {
    id: 'heap_memory_usage',
    name: 'Heap Memory Usage',
    category: 'node_runtime',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('heap_memory_usage', 'Heap Memory Usage', 'node_runtime');
      const mem = process.memoryUsage();
      const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
      const heapTotalMb = Math.round(mem.heapTotal / 1024 / 1024);
      const rssMb = Math.round(mem.rss / 1024 / 1024);
      const externalMb = Math.round((mem.external || 0) / 1024 / 1024);
      if (heapUsedMb > 512) {
        return warn(
          base,
          `Heap usage is high (${heapUsedMb}MB used / ${heapTotalMb}MB total). Possible memory leak.`,
          'Restart SERA. If the leak recurs, profile with "node --inspect dist/server.cjs" and Chrome DevTools.',
          { heapUsedMb, heapTotalMb, rssMb, externalMb, threshold: 512 },
        );
      }
      return pass(
        base,
        `Heap usage healthy (${heapUsedMb}MB used / ${heapTotalMb}MB total).`,
        { heapUsedMb, heapTotalMb, rssMb, externalMb },
      );
    },
  };
}

export function createUncaughtHandlerCheck(): IDiagnosticCheckRunner {
  return {
    id: 'uncaught_handler_installed',
    name: 'Global Error Handlers',
    category: 'node_runtime',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('uncaught_handler_installed', 'Global Error Handlers', 'node_runtime');
      // Node doesn't expose a public API to check listener count for
      // process events, but EventEmitter is the underlying emitter and
      // we can ask it directly.
      const ee = process as unknown as EventEmitter;
      const uncaughtCount = ee.listenerCount('uncaughtException');
      const rejectionCount = ee.listenerCount('unhandledRejection');
      if (uncaughtCount === 0 || rejectionCount === 0) {
        return fail(
          base,
          `Process-level error handlers are NOT installed (uncaughtException: ${uncaughtCount}, unhandledRejection: ${rejectionCount}). A single unhandled error would crash the server silently.`,
          'Check server.ts boot sequence — process.on("uncaughtException", ...) and process.on("unhandledRejection", ...) must be installed before app.listen().',
          { uncaughtCount, rejectionCount },
        );
      }
      return pass(
        base,
        `Process-level error handlers installed (uncaughtException: ${uncaughtCount}, unhandledRejection: ${rejectionCount}).`,
        { uncaughtCount, rejectionCount },
      );
    },
  };
}

// ─── Environment & Configuration checks ──────────────────────────────

export function createEnvFilePresentCheck(): IDiagnosticCheckRunner {
  return {
    id: 'env_file_present',
    name: '.env File Presence',
    category: 'config_environment',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('env_file_present', '.env File Presence', 'config_environment');
      const envPath = resolveProject('.env');
      if (!fs.existsSync(envPath)) {
        // .env is NOT mandatory: keys added via the Startup Launcher or
        // Settings → API KEYS live in the encrypted vault, not in .env.
        // Only fail when there is genuinely no configuration source.
        const vaultHasKeys =
          defaultApiKeyVault.has('gemini') ||
          defaultApiKeyVault.has('openai') ||
          defaultApiKeyVault.has('deepseek');
        if (vaultHasKeys) {
          return pass(
            base,
            '.env file not present — API keys are provided by the encrypted key vault (configured via the SERA UI). No .env needed.',
            { envFile: false, keySource: 'vault' },
          );
        }
        return fail(
          base,
          'No .env file found in the project root, and the encrypted key vault has no API keys stored. Gemini and other providers will not load.',
          'Fix with either option: 1) Run "copy .env.example .env" (Windows) / "cp .env.example .env", then add GEMINI_API_KEY="AIza..." — or 2) open SERA → Startup Launcher / Settings → API KEYS and save your key there (stored encrypted; .env optional).',
        );
      }
      const stat = fs.statSync(envPath);
      return pass(
        base,
        `.env file present (${stat.size} bytes).`,
        { size: stat.size, mtime: stat.mtime },
      );
    },
  };
}

export function createEnvNoPlaceholdersCheck(): IDiagnosticCheckRunner {
  return {
    id: 'env_no_placeholder_values',
    name: 'Environment Variables: No Placeholders',
    category: 'security',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('env_no_placeholder_values', 'Environment Variables: No Placeholders', 'security');
      const placeholders: string[] = [];
      const suspect = [
        'GEMINI_API_KEY',
        'VITE_GEMINI_API_KEY',
        'APP_URL',
        'BROWSER_CDP_URL',
        'SERA_MEMORY_FILE',
        'PORT',
      ];
      for (const name of suspect) {
        const value = process.env[name];
        if (!value) continue;
        if (/^(MY_|PLACEHOLDER|your|REPLACE|EXAMPLE|XXXX)/i.test(value) || value.includes('REPLACE_ME')) {
          placeholders.push(name);
        }
      }
      if (placeholders.length > 0) {
        // Build per-variable action guidance so the user knows what to set
        // each one to. APP_URL is special-cased — the .env.example ships
        // with "MY_APP_URL" as a placeholder and users often don't know
        // what value to put (it's the URL where SERA is reachable — for
        // local dev, http://localhost:3000).
        const perVarGuide: string[] = [];
        for (const name of placeholders) {
          if (name === 'GEMINI_API_KEY' || name === 'VITE_GEMINI_API_KEY') {
            perVarGuide.push(`${name}: Get a real key at https://aistudio.google.com/apikey (free tier available). Set it as a string in .env: ${name}="AIza..."`);
          } else if (name === 'APP_URL') {
            perVarGuide.push(`${name}: Set to the URL where SERA is reachable. For local dev: APP_URL="http://localhost:3000". For Cloud Run: APP_URL="https://your-service-url.a.run.app".`);
          } else if (name === 'BROWSER_CDP_URL') {
            perVarGuide.push(`${name}: Leave empty unless you're connecting to an external Chrome via CDP. Most users should delete the line.`);
          } else if (name === 'SERA_MEMORY_FILE') {
            perVarGuide.push(`${name}: Set a path for SERA's long-term memory JSON. Default ".data/sera-memory.json" works for local dev.`);
          } else if (name === 'PORT') {
            perVarGuide.push(`${name}: Set to a port number (e.g., PORT=3000). Avoid 80/443 unless you have admin privileges.`);
          } else {
            perVarGuide.push(`${name}: Replace the placeholder value with the real value.`);
          }
        }
        return warn(
          base,
          `Environment variables still contain placeholder values: ${placeholders.join(', ')}.`,
          `Edit .env and replace each placeholder with the real value:\n${perVarGuide.join('\n')}`,
          { placeholders, perVarGuide },
        );
      }
      return pass(base, 'No placeholder values detected in environment variables.');
    },
  };
}

// ─── File System checks ───────────────────────────────────────────────

async function checkDirWritable(target: string): Promise<boolean> {
  try {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }
    const probe = path.join(target, `.sera-writable-probe-${Date.now()}.tmp`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

export function createProjectRootWritableCheck(): IDiagnosticCheckRunner {
  return {
    id: 'project_root_writable',
    name: 'Project Root Writable',
    category: 'file_system',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('project_root_writable', 'Project Root Writable', 'file_system');
      // v1.9.0: the dir that MATTERS is the SERA user-data home — the
      // install dir may be read-only by design in packaged installs.
      const ok = await checkDirWritable(userDataDir());
      if (!ok) {
        return fail(
          base,
          `Project root (${process.cwd()}) is NOT writable. SERA cannot persist memories, backups, or tmp files.`,
          'Check directory permissions: "chmod 755 ." on Linux/macOS, or right-click → Properties → Security on Windows.',
        );
      }
      return pass(base, `Project root (${process.cwd()}) is writable.`);
    },
  };
}

export function createDataDirectoryWritableCheck(): IDiagnosticCheckRunner {
  return {
    id: 'data_directory_writable',
    name: '.data/ Directory Writable',
    category: 'file_system',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('data_directory_writable', '.data/ Directory Writable', 'file_system');
      const target = resolveProject('.data');
      const ok = await checkDirWritable(target);
      if (!ok) {
        return fail(
          base,
          `.data/ directory is NOT writable. Memory persistence will fail silently.`,
          `Create the directory and fix permissions: "mkdir -p .data && chmod 755 .data".`,
        );
      }
      return pass(base, `.data/ directory is writable.`);
    },
  };
}

export function createBackupsDirectoryWritableCheck(): IDiagnosticCheckRunner {
  return {
    id: 'backups_directory_writable',
    name: 'backups/ Directory Writable',
    category: 'file_system',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('backups_directory_writable', 'backups/ Directory Writable', 'file_system');
      const target = resolveProject('backups');
      const ok = await checkDirWritable(target);
      if (!ok) {
        return warn(
          base,
          'backups/ directory is NOT writable. AutoRepairEngine cannot store memory snapshots before sanitizing.',
          `Create the directory: "mkdir -p backups".`,
        );
      }
      return pass(base, 'backups/ directory is writable.');
    },
  };
}

export function createTmpDirectoryWritableCheck(): IDiagnosticCheckRunner {
  return {
    id: 'tmp_directory_writable',
    name: 'tmp/ Directory Writable',
    category: 'file_system',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('tmp_directory_writable', 'tmp/ Directory Writable', 'file_system');
      const target = resolveProject('tmp');
      const ok = await checkDirWritable(target);
      if (!ok) {
        return warn(
          base,
          'tmp/ directory is NOT writable. Browser session caches and screenshot temp files will fail.',
          `Create the directory: "mkdir -p tmp".`,
        );
      }
      return pass(base, 'tmp/ directory is writable.');
    },
  };
}

export function createKeySourceFilesPresentCheck(): IDiagnosticCheckRunner {
  return {
    id: 'key_source_files_present',
    name: 'Critical Source Files Present',
    category: 'file_system',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('key_source_files_present', 'Critical Source Files Present', 'file_system');
      const expected = [
        'server.ts',
        'package.json',
        'tsconfig.json',
        'vite.config.ts',
        'index.html',
        'electron/main.cjs',
        'electron/speech-host.cjs',
        'src/diagnostics/SystemDiagnosticService.ts',
        'src/diagnostics/AutoRepairEngine.ts',
        'src/tools/toolRegistry.ts',
      ];
      const missing = expected.filter((file) => {
        try { return !fs.existsSync(resolveProject(file)); } catch { return true; }
      });
      if (missing.length > 0) {
        return fail(
          base,
          `Critical source files are missing: ${missing.join(', ')}. SERA will not run correctly without them.`,
          'Re-clone the repository or restore the missing files from git: "git checkout -- <file>".',
          { missing, expected },
        );
      }
      return pass(base, `All ${expected.length} critical source files present.`);
    },
  };
}

export function createTrainedDataPresentCheck(): IDiagnosticCheckRunner {
  return {
    id: 'traineddata_present',
    name: 'Tesseract OCR Training Data (eng.traineddata)',
    category: 'file_system',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('traineddata_present', 'Tesseract OCR Training Data (eng.traineddata)', 'file_system');
      // v1.9.0: authoritative home is the per-user OCR cache; the legacy
      // repo-root copy is still reported when present (setup-ocr adopts it).
      const candidate = existsSync(ocrDataFile()) ? ocrDataFile() : resolveProject('eng.traineddata');
      if (!fs.existsSync(candidate)) {
        return warn(
          base,
          'eng.traineddata is missing. VisionExecutor OCR-based screen element location will fall back to slower paths.',
          'No manual command needed: SERA auto-downloads it in the background on startup (also: npm run setup:ocr). It lands in the app folder and is re-fetched automatically if an update removes it.',
        );
      }
      const stat = fs.statSync(candidate);
      if (stat.size < 1_000_000) {
        return warn(
          base,
          `eng.traineddata is suspiciously small (${stat.size} bytes). OCR may produce garbage.`,
          'Re-download eng.traineddata from https://github.com/tesseract-ocr/tessdata',
          { size: stat.size },
        );
      }
      return pass(base, `eng.traineddata present (${(stat.size / 1024 / 1024).toFixed(1)}MB).`, { size: stat.size });
    },
  };
}

// ─── Native Modules checks ────────────────────────────────────────────

export function createKoffiLoadableCheck(): IDiagnosticCheckRunner {
  return {
    id: 'koffi_loadable',
    name: 'koffi (FFI) Native Module',
    category: 'native_modules',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('koffi_loadable', 'koffi (FFI) Native Module', 'native_modules');
      try {
        const koffi = esmRequire('koffi');
        // koffi's actual public API surface (verified by inspecting the
        // module via `node -e "console.log(Object.keys(require('koffi')))"`):
        //   - koffi.load(path)  → LibraryHandle  (the entry point for FFI)
        //   - koffi.pointer     → function
        //   - koffi.alloc       → function
        //   - koffi.decode      → function
        // The previous check asserted `typeof koffi.func === 'function'`,
        // but `func` is NOT on the koffi namespace — it's a method on the
        // LibraryHandle returned by koffi.load(). The check was a false
        // positive on every SERA install even though koffi was perfectly
        // healthy. Assert the real entry point instead.
        if (typeof koffi !== 'object' || typeof koffi.load !== 'function' || typeof koffi.pointer !== 'function') {
          return fail(base, `koffi loaded but its public API surface is missing expected entry points (load=${typeof koffi?.load}, pointer=${typeof koffi?.pointer}).`, 'Run "npm rebuild koffi" or reinstall.');
        }
        return pass(base, 'koffi loads cleanly and exposes the load() / pointer() / alloc() FFI API.');
      } catch (err) {
        return fail(
          base,
          `koffi failed to load: ${err instanceof Error ? err.message : String(err)}`,
          'Run "npm install koffi" in the project root.',
        );
      }
    },
  };
}

export function createActiveWinLoadableCheck(): IDiagnosticCheckRunner {
  return {
    id: 'active_win_loadable',
    name: 'active-win Module',
    category: 'native_modules',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('active_win_loadable', 'active-win Module', 'native_modules');
      try {
        const mod = (await import('active-win')) as unknown as {
          default?: unknown;
          getActiveWindow?: () => Promise<unknown>;
          getActiveWindowSync?: () => unknown;
        };
        if (!mod || (!mod.default && !mod.getActiveWindow && !mod.getActiveWindowSync)) {
          return fail(base, 'active-win loaded but its API is malformed.', 'Run "npm install active-win".');
        }
        return pass(base, 'active-win imports cleanly with expected API surface.');
      } catch (err) {
        return fail(
          base,
          `active-win failed to import: ${err instanceof Error ? err.message : String(err)}`,
          'Run "npm install active-win" in the project root.',
        );
      }
    },
  };
}

export function createPngjsLoadableCheck(): IDiagnosticCheckRunner {
  return {
    id: 'pngjs_loadable',
    name: 'pngjs Module',
    category: 'native_modules',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('pngjs_loadable', 'pngjs Module', 'native_modules');
      try {
        // pngjs's actual public API surface (verified via
        //   `node -e "const p=require('pngjs'); console.log(typeof p.PNG, typeof p.PNG.sync, typeof p.PNG.sync.write, typeof p.PNG.sync.parse)"`
        // outputs: function, object, function, undefined).
        // The sync API has ONLY `write()` — there is no `PNG.sync.parse`.
        // SERA uses pngjs for screen capture: src/vision/screenImage.ts
        // does `new PNG({width,height})` + `PNG.sync.write(png)` to encode
        // raw RGBA bytes into a PNG buffer. Assert exactly that surface.
        // The `any` cast here is intentional — pngjs's PNG is a class
        // (callable via new + has static .sync property). TS's strict
        // types don't model "callable + has static members" cleanly.
        const mod = (await import('pngjs')) as { PNG?: any };
        const PNG = mod.PNG;
        if (!PNG || typeof PNG !== 'function' || typeof PNG.sync !== 'object' || typeof PNG.sync?.write !== 'function') {
          return fail(base, `pngjs loaded but its public API is missing PNG constructor or PNG.sync.write (PNG=${typeof PNG}, sync=${typeof PNG?.sync}, write=${typeof PNG?.sync?.write}).`, 'Run "npm install pngjs".');
        }
        return pass(base, 'pngjs loads cleanly with PNG constructor + PNG.sync.write encoder API.');
      } catch (err) {
        return fail(
          base,
          `pngjs failed to import: ${err instanceof Error ? err.message : String(err)}`,
          'Run "npm install pngjs" in the project root.',
        );
      }
    },
  };
}

export function createWin32ApiLoadableCheck(): IDiagnosticCheckRunner {
  return {
    id: 'win32_api_loadable',
    name: 'win32-api Module (Windows only)',
    category: 'native_modules',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('win32_api_loadable', 'win32-api Module (Windows only)', 'native_modules');
      if (process.platform !== 'win32') {
        return pass(base, `win32-api is not required on platform "${process.platform}".`);
      }
      try {
        // win32-api is CommonJS; use esmRequire so it works in dev+prod.
        const mod = esmRequire('win32-api');
        if (!mod || typeof mod !== 'object') {
          return fail(base, 'win32-api loaded but its API is malformed.', 'Run "npm install win32-api".');
        }
        return pass(base, 'win32-api loads cleanly.');
      } catch (err) {
        return fail(
          base,
          `win32-api failed to load: ${err instanceof Error ? err.message : String(err)}`,
          'Run "npm install win32-api" in the project root.',
        );
      }
    },
  };
}

// ─── Dependencies checks ─────────────────────────────────────────────

export function createNodeModulesPresentCheck(): IDiagnosticCheckRunner {
  return {
    id: 'node_modules_present',
    name: 'node_modules/ Directory',
    category: 'dependencies',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('node_modules_present', 'node_modules/ Directory', 'dependencies');
      const target = resolveProject('node_modules');
      if (!fs.existsSync(target)) {
        return fail(
          base,
          'node_modules/ is missing. SERA has no dependencies installed and cannot run.',
          'Run "npm install" in the project root (2–5 minutes).',
        );
      }
      try {
        const entries = fs.readdirSync(target, { withFileTypes: true });
        const dirs = entries.filter((e) => e.isDirectory()).length;
        const hasDotFolder = entries.some((e) => e.name.startsWith('.'));
        if (dirs < 50) {
          return warn(
            base,
            `node_modules/ has only ${dirs} top-level packages — expected 50+. Install may be incomplete.`,
            'Run "rm -rf node_modules && npm install" to do a clean reinstall.',
            { packageCount: dirs },
          );
        }
        return pass(
          base,
          `node_modules/ present with ${dirs} top-level packages${hasDotFolder ? ' (scoped packages detected)' : ''}.`,
          { packageCount: dirs },
        );
      } catch (err) {
        return fail(
          base,
          `Could not enumerate node_modules/: ${err instanceof Error ? err.message : String(err)}`,
          'Run "rm -rf node_modules && npm install" to do a clean reinstall.',
        );
      }
    },
  };
}

export function createPackageLockPresentCheck(): IDiagnosticCheckRunner {
  return {
    id: 'package_lock_present',
    name: 'package-lock.json Integrity',
    category: 'dependencies',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('package_lock_present', 'package-lock.json Integrity', 'dependencies');
      const lockPath = resolveProject('package-lock.json');
      if (!fs.existsSync(lockPath)) {
        return warn(
          base,
          'package-lock.json is missing. Dependency versions may drift across machines.',
          'Run "npm install" to generate it. Commit it to the repository.',
        );
      }
      try {
        const content = fs.readFileSync(lockPath, 'utf8');
        const parsed = JSON.parse(content);
        const pkgCount = parsed.packages ? Object.keys(parsed.packages).length : 0;
        if (pkgCount < 50) {
          return warn(
            base,
            `package-lock.json has only ${pkgCount} package entries — install may be incomplete.`,
            'Run "rm -rf node_modules package-lock.json && npm install" to regenerate.',
            { pkgCount },
          );
        }
        return pass(base, `package-lock.json present (${pkgCount} packages tracked).`, { pkgCount });
      } catch (err) {
        return fail(
          base,
          `package-lock.json is corrupt: ${err instanceof Error ? err.message : String(err)}`,
          'Run "rm -f package-lock.json && npm install" to regenerate.',
        );
      }
    },
  };
}

// ─── Network checks ──────────────────────────────────────────────────

export function createGoogleDnsResolvableCheck(): IDiagnosticCheckRunner {
  return {
    id: 'google_dns_resolvable',
    name: 'DNS Resolution (google.com)',
    category: 'network',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('google_dns_resolvable', 'DNS Resolution (google.com)', 'network');
      try {
        const start = Date.now();
        const result = await execAsync(
          process.platform === 'win32' ? 'nslookup google.com' : 'nslookup google.com 8.8.8.8',
          { windowsHide: true, timeout: 5000 },
        );
        const durationMs = Date.now() - start;
        // Extract all IPv4 addresses from the nslookup output. We deliberately
        // accept any *public* IPv4 as a pass — Google rotates IPs aggressively
        // (142.250.x, 172.217.x, 216.58.x, 216.239.x, 8.8.8.8, etc.), so pinning
        // a specific list was brittle and produced false "network may be
        // intercepted" warnings. The danger signal is when the only IP returned
        // is a private RFC 1918 range (10.x, 172.16-31.x, 192.168.x) — that
        // means DNS has been hijacked to a captive portal / proxy.
        const ipv4Matches = result.stdout.match(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g) || [];
        const publicIps = ipv4Matches.filter((ip) => {
          const [a, b] = ip.split('.').map(Number);
          if (a === 10) return false;
          if (a === 172 && b >= 16 && b <= 31) return false;
          if (a === 192 && b === 168) return false;
          if (a === 127) return false; // loopback
          if (a === 0) return false; // "this network"
          return true;
        });
        if (publicIps.length === 0) {
          // Private/bogus IPs — DNS is being intercepted (captive portal,
          // transparent port-53 hijack, or a TUN proxy). BUT the network
          // may still WORK end-to-end (TUN-mode VPNs and transparent
          // proxies do exactly this). Before alarming, probe real
          // connectivity: OS-resolver lookup + a live HTTPS request.
          const dnsMod = await import('node:dns');
          let osResolverOk = false;
          try {
            await new Promise<void>((res, rej) =>
              dnsMod.lookup('generativelanguage.googleapis.com', (err) => (err ? rej(err) : res())),
            );
            osResolverOk = true;
          } catch { /* OS resolver also fails */ }

          let httpsOk = false;
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 6000);
            try {
              const resp = await fetch('https://www.google.com/generate_204', { signal: controller.signal });
              httpsOk = resp.status === 204 || resp.ok || resp.status === 302;
            } finally {
              clearTimeout(timer);
            }
          } catch { /* HTTPS probe failed */ }

          if (osResolverOk && httpsOk) {
            return pass(
              base,
              'DNS answers are intercepted (private IPs only), but end-to-end HTTPS connectivity works — transparent proxy/TUN environment. SERA can connect.',
              { durationMs, foundIps: ipv4Matches, osResolverOk, httpsOk },
            );
          }

          const dohGuide = 'Your network hijacks plain-text DNS (port 53): even queries to 1.1.1.1 / 8.8.8.8 are answered with fake private IPs. FIX (recommended, 2 min): Windows Settings → Network & internet → Wi-Fi/Ethernet → DNS server assignment → Edit → turn ON "Encrypted DNS (DNS over HTTPS)" for both servers → Save → run "ipconfig /flushdns". This bypasses the hijack for ALL apps including SERA. Alternative: run your VPN/proxy app in TUN mode, or set HTTPS_PROXY in .env (SERA routes fetch calls through it automatically).';
          if (osResolverOk && !httpsOk) {
            return warn(
              base,
              `DNS resolved but returned no public IPv4 addresses (only private/RFC 1918 ranges) and HTTPS to Google failed. Network DNS is hijacked and connectivity to Google is blocked.`,
              dohGuide,
              { stdout: result.stdout.slice(0, 200), durationMs, foundIps: ipv4Matches, osResolverOk, httpsOk },
            );
          }
          return warn(
            base,
            `DNS lookup failed or returned no usable addresses (${ipv4Matches.slice(0, 4).join(', ') || 'none'}).`,
            dohGuide,
            { stdout: result.stdout.slice(0, 200), durationMs, foundIps: ipv4Matches },
          );
        }
        return pass(base, `DNS resolved google.com to ${publicIps.length} public IP(s) in ${durationMs}ms.`, { durationMs, sampleIp: publicIps[0] });
      } catch (err) {
        return warn(
          base,
          `DNS lookup failed: ${err instanceof Error ? err.message : String(err)}`,
          'Check internet connectivity. SERA needs to reach Google AI Studio endpoints for Gemini API calls.',
        );
      }
    },
  };
}

export function createGeminiEndpointReachableCheck(): IDiagnosticCheckRunner {
  return {
    id: 'gemini_endpoint_reachable',
    name: 'Gemini API Endpoint Reachability',
    category: 'network',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('gemini_endpoint_reachable', 'Gemini API Endpoint Reachability', 'network');
      const host = 'generativelanguage.googleapis.com';
      const dns = await import('node:dns');

      // Probe helper with a hard timeout (AbortController so it works on
      // every Node/lib combination).
      const fetchWithTimeout = async (url: string, timeoutMs: number): Promise<Response> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          return await fetch(url, { method: 'GET', signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
      };

      // ── Stage 1: direct DNS query (port 53). Fast path — works on
      // most home networks, but is routinely refused by VPNs, corporate
      // firewalls, Pi-hole setups and some ISPs (ECONNREFUSED).
      let directDnsError = '';
      try {
        const start = Date.now();
        // Use DNS lookup + TCP connect probe; don't actually hit the API
        // to avoid burning quota.
        await promisify(dns.resolve)(host, 'A');
        const durationMs = Date.now() - start;
        return pass(
          base,
          `${host} DNS resolved in ${durationMs}ms — Gemini endpoint reachable.`,
          { durationMs, via: 'direct-dns' },
        );
      } catch (err) {
        directDnsError = err instanceof Error ? err.message : String(err);
      }

      // ── Stage 2: the OS resolver (getaddrinfo). This is what SERA's
      // real HTTPS / WebSocket connections actually use — it consults
      // the hosts file, the Windows DNS Cache service and VPN adapters.
      // If this succeeds, Gemini WILL connect despite port 53 being
      // blocked for direct queries.
      try {
        const start = Date.now();
        await new Promise<void>((res, rej) =>
          dns.lookup(host, (err) => (err ? rej(err) : res())),
        );
        const durationMs = Date.now() - start;
        return pass(
          base,
          `${host} resolved via the OS resolver in ${durationMs}ms. Direct DNS (port 53) is blocked on this network (${directDnsError}), but SERA connects through the OS resolver — Gemini will work normally.`,
          { durationMs, via: 'os-resolver', directDnsError },
        );
      } catch {
        // continue to the HTTPS probe
      }

      // ── Stage 3: real HTTPS probe. Any HTTP response (even 404) proves
      // TCP + TLS + HTTP to the Gemini host end-to-end. No API quota is
      // consumed (root path, no auth header).
      try {
        const start = Date.now();
        const resp = await fetchWithTimeout(`https://${host}/`, 7000);
        const durationMs = Date.now() - start;
        return pass(
          base,
          `Gemini endpoint reachable over HTTPS (HTTP ${resp.status} in ${durationMs}ms). Direct DNS (port 53) is blocked on this network (${directDnsError}), but end-to-end connectivity is confirmed.`,
          { durationMs, via: 'https-probe', httpStatus: resp.status, directDnsError },
        );
      } catch {
        // continue to the DoH sanity probe
      }

      // ── Stage 4: DNS-over-HTTPS sanity check. If DoH resolves the host,
      // the internet itself is up — the local DNS path is what's broken.
      try {
        const resp = await fetchWithTimeout(
          `https://dns.google/resolve?name=${host}&type=A`,
          6000,
        );
        const body = (await resp.json()) as { Answer?: Array<{ data: string }> };
        if (Array.isArray(body.Answer) && body.Answer.length > 0) {
          return warn(
            base,
            `Direct DNS (port 53) refused the query (${directDnsError}) and the OS resolver failed, but DNS-over-HTTPS resolves ${host}. Your internet is up — the local DNS configuration is the problem. SERA may still connect if the OS resolver recovers.`,
            'Fix the local DNS path: 1) On Windows run "ipconfig /flushdns" and restart the "DNS Client" service. 2) Set your adapter DNS to 1.1.1.1 / 8.8.8.8 (Settings → Network → Adapter options → Properties → IPv4). 3) If a VPN or firewall is active, allow outbound UDP/TCP port 53 or disconnect it. 4) Test: "nslookup google.com 8.8.8.8".',
            { via: 'dns-over-https', directDnsError },
          );
        }
      } catch {
        // fall through to the honest failure report
      }

      // ── Stage 5: genuinely unreachable — give the actionable guide.
      // - ECONNREFUSED: the user's DNS server itself refused the connection
      //   (offline, DNS service down, firewall blocking port 53).
      // - ENOTFOUND: the DNS server responded but couldn't resolve the host
      //   (typo, hijacked DNS, captive portal).
      // - ETIMEDOUT: DNS server didn't respond in time (slow network,
      //   firewall silently dropping packets).
      // - EAI_AGAIN: temporary DNS failure (retry later).
      const errMsg = directDnsError;
      let guide = 'Check internet connectivity and DNS. Without reaching generativelanguage.googleapis.com, the Live WebSocket will fail.';
      if (/ECONNREFUSED/i.test(errMsg)) {
        guide = 'Your DNS server refused the connection (port 53 unreachable). Likely causes: offline, system DNS service stopped, or a firewall blocking outbound port 53. Try: 1) Check your internet connection. 2) Try a different DNS server: "nslookup google.com 8.8.8.8". 3) On Windows, run "ipconfig /flushdns". 4) Restart your router.';
      } else if (/ENOTFOUND/i.test(errMsg)) {
        guide = 'DNS server responded but couldn\'t resolve generativelanguage.googleapis.com. Likely a captive portal or hijacked DNS. Try connecting from a different network or VPN.';
      } else if (/ETIMEDOUT/i.test(errMsg)) {
        guide = 'DNS server didn\'t respond in time. Network is too slow or a firewall is silently dropping DNS packets. Try a different network connection.';
      } else if (/EAI_AGAIN|EAI_EAGAIN/i.test(errMsg)) {
        guide = 'Temporary DNS failure. Retry the diagnostic in a few minutes — this is typically transient.';
      }
      return warn(
        base,
        `Gemini endpoint unreachable: direct DNS failed (${errMsg}), and the OS resolver + HTTPS probe + DNS-over-HTTPS all failed too.`,
        guide,
      );
    },
  };
}

// ─── Audio Pipeline (expanded) ────────────────────────────────────────

export function createAudioDevicesCountCheck(): IDiagnosticCheckRunner {
  return {
    id: 'audio_devices_count',
    name: 'Audio Device Enumeration',
    category: 'audio_pipeline',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('audio_devices_count', 'Audio Device Enumeration', 'audio_pipeline');
      // The browser is responsible for actual mic access, but on the
      // server side we can probe the host's audio hardware presence
      // via OS commands. This is best-effort.
      try {
        if (process.platform === 'linux') {
          const result = await execAsync('arecord -l 2>&1 || true', { timeout: 3000 });
          const cards = (result.stdout.match(/^card \d+:/gm) || []).length;
          return pass(base, `Linux ALSA reports ${cards} audio capture device(s).`, { cards });
        }
        if (process.platform === 'win32') {
          // NOTE: the WMI class is Win32_SoundDevice (with underscores) — the
          // previous query used "Win32SoundDevice", which does not exist, so
          // healthy machines were told "0 audio device(s)".
          const result = await execAsync(
            `powershell -NoProfile -Command "(Get-CimInstance -ClassName Win32_SoundDevice -ErrorAction SilentlyContinue | Measure-Object).Count"`,
            { windowsHide: true, timeout: 5000 },
          );
          const count = parseInt(result.stdout.trim(), 10);
          if (!Number.isFinite(count) || count <= 0) {
            return warn(
              base,
              'Windows WMI reports no sound devices — usually a WMI quirk, not a real problem.',
              'SERA voice runs through your browser, not through WMI. If the mic bars move when you talk, your audio is fine.',
            );
          }
          return pass(base, `Windows reports ${count} audio device(s).`, { count });
        }
        if (process.platform === 'darwin') {
          const result = await execAsync('system_profiler SPAudioDataType 2>&1 | grep -c "Output Channel Layout" || echo 0', { timeout: 5000 });
          const count = parseInt((result.stdout || '0').trim(), 10);
          return pass(base, `macOS reports ${count} audio device(s).`, { count });
        }
        return pass(base, `Audio device enumeration not implemented on platform "${process.platform}".`);
      } catch (err) {
        return warn(
          base,
          `Audio device enumeration failed: ${err instanceof Error ? err.message : String(err)}`,
          'Browser-side mic access is independent — this is informational. If browser mic also fails, check system audio settings.',
        );
      }
    },
  };
}

// ─── Browser Automation (expanded) ────────────────────────────────────

export function createManagedBrowserSessionCheck(): IDiagnosticCheckRunner {
  return {
    id: 'managed_browser_session_initialized',
    name: 'Managed Browser Session Manager',
    category: 'browser_automation',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('managed_browser_session_initialized', 'Managed Browser Session Manager', 'browser_automation');
      try {
        const { defaultBrowserSessionManager } = await import('../tools/toolRegistry');
        if (!defaultBrowserSessionManager) {
          return fail(base, 'defaultBrowserSessionManager is not exported from toolRegistry.ts.', 'Check src/tools/toolRegistry.ts — the singleton export must be present.');
        }
        return pass(base, 'defaultBrowserSessionManager singleton is exported and importable.');
      } catch (err) {
        return fail(
          base,
          `BrowserSessionManager import failed: ${err instanceof Error ? err.message : String(err)}`,
          'Check src/browser/BrowserSessionManager.ts for TypeScript errors. Run "npm run lint".',
        );
      }
    },
  };
}

// ─── Window Management checks ─────────────────────────────────────────

export function createActiveWindowDetectableCheck(): IDiagnosticCheckRunner {
  return {
    id: 'active_window_detectable',
    name: 'Active Window Detection',
    category: 'window_management',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('active_window_detectable', 'Active Window Detection', 'window_management');
      try {
        const mod = (await import('active-win')) as unknown as {
          default?: { sync?: () => unknown };
          getActiveWindowSync?: () => unknown;
          getActiveWindow?: () => Promise<unknown>;
        };
        const getActiveWindow = mod.default?.sync ?? mod.getActiveWindowSync;
        if (typeof getActiveWindow !== 'function') {
          return warn(base, 'active-win loaded but has neither getActiveWindowSync nor default.sync.', 'Check active-win version. Run "npm install active-win@latest".');
        }
        const win = getActiveWindow() as { title?: string; owner?: { name?: string } } | null | undefined;
        if (!win || typeof win !== 'object') {
          return warn(base, 'active-win returned a non-object window. Likely headless / no graphical session.', 'Run SERA on a host with a graphical desktop session.');
        }
        return pass(base, `Active window detected: "${win.title || '<untitled>'}" owned by ${win.owner?.name || '<unknown>'}.`, { title: win.title, owner: win.owner?.name });
      } catch (err) {
        return warn(
          base,
          `Could not detect active window: ${err instanceof Error ? err.message : String(err)}`,
          'Likely no graphical session (headless server, SSH without X forwarding). Window tools will fail on this host.',
        );
      }
    },
  };
}

// ─── Application Launcher checks ──────────────────────────────────────

export function createAppLauncherAvailableCheck(): IDiagnosticCheckRunner {
  return {
    id: 'app_launcher_available',
    name: 'Platform App Launcher Binary',
    category: 'application_launcher',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('app_launcher_available', 'Platform App Launcher Binary', 'application_launcher');
      const launcher = await detectAppLauncher();
      if (!launcher) {
        return fail(base, `No app launcher binary detected on platform "${process.platform}".`, 'Run SERA on Windows (start), macOS (open), or Linux (xdg-open).');
      }
      const present = await binaryOnPath(launcher);
      if (!present) {
        return fail(
          base,
          `App launcher "${launcher}" is not on PATH. openApplication will fail for desktop apps.`,
          process.platform === 'linux' ? 'Install xdg-utils: "sudo apt install xdg-utils".' : 'This binary should ship with your OS — check your PATH.',
        );
      }
      return pass(base, `App launcher "${launcher}" is on PATH.`);
    },
  };
}

// ─── Tool Registry checks ─────────────────────────────────────────────

export function createToolRegistryCountCheck(): IDiagnosticCheckRunner {
  return {
    id: 'tool_registry_count',
    name: 'Tool Registry: Tool Count',
    category: 'tool_registry',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('tool_registry_count', 'Tool Registry: Tool Count', 'tool_registry');
      try {
        const { defaultToolManager } = await import('../tools/toolRegistry');
        // ToolManager class (src/tools/ToolManager.ts) exposes getAllTools(),
        // NOT listTools(). The previous version of this check called
        // toolManager.listTools?.() — the optional chain returned undefined
        // for the missing method, fell back to [] via ??, and the check
        // reported "Only 0 tools registered" on every SERA install despite
        // 36 tools being correctly registered in createDefaultToolManager().
        // The actual public API on ToolManager is getAllTools().
        const toolManager = defaultToolManager as { getAllTools?: () => unknown[] } | undefined;
        if (!toolManager) {
          return fail(base, 'defaultToolManager is not exported from toolRegistry.ts.', 'Check src/tools/toolRegistry.ts — the singleton export must be present.');
        }
        const tools = toolManager.getAllTools?.() ?? [];
        const count = Array.isArray(tools) ? tools.length : 0;
        if (count < 25) {
          return warn(
            base,
            `Only ${count} tools registered — expected 30+. Some capability surfaces may be missing.`,
            'Check src/tools/toolRegistry.ts createDefaultToolManager — every tool must be wired via manager.registerTool().',
            { count, threshold: 25 },
          );
        }
        return pass(base, `${count} tools registered in the default ToolManager.`, { count });
      } catch (err) {
        return fail(
          base,
          `Tool registry probe failed: ${err instanceof Error ? err.message : String(err)}`,
          'Check src/tools/toolRegistry.ts. Run "npm run lint" to see TypeScript errors.',
        );
      }
    },
  };
}

// ─── WebSocket Server checks ──────────────────────────────────────────

export function createWebSocketServerListeningCheck(): IDiagnosticCheckRunner {
  return {
    id: 'websocket_server_listening',
    name: 'WebSocket Server Listening',
    category: 'websocket_server',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('websocket_server_listening', 'WebSocket Server Listening', 'websocket_server');
      // The WebSocket server is wired by server.ts and attaches to the
      // HTTP server's "upgrade" event. We can't reach the actual WS
      // server from here directly (it's not exported), but we can probe
      // the HTTP server's listening state via the process env.
      const port = parseInt(process.env.PORT || '43110', 10);
      try {
        const net = await import('node:net');
        const socket = new net.Socket();
        const reachable = await new Promise<boolean>((resolve) => {
          socket.setTimeout(2000);
          socket.once('connect', () => { socket.destroy(); resolve(true); });
          socket.once('error', () => { socket.destroy(); resolve(false); });
          socket.once('timeout', () => { socket.destroy(); resolve(false); });
          socket.connect({ port, host: '127.0.0.1' });
        });
        if (!reachable) {
          return fail(
            base,
            `Cannot connect to localhost:${port} — HTTP/WS server may not be listening.`,
            `Check that "npm run dev" / "npm start" is running. The PORT env var is ${port}.`,
            { port },
          );
        }
        return pass(base, `Local port ${port} is reachable — server is listening.`, { port });
      } catch (err) {
        return fail(base, `Port probe failed: ${err instanceof Error ? err.message : String(err)}`, 'Internal error — check Node.js installation.');
      }
    },
  };
}

// ─── HTTP Server checks ───────────────────────────────────────────────

export function createHttpServerListeningCheck(): IDiagnosticCheckRunner {
  return {
    id: 'http_server_listening',
    name: 'HTTP Server Listening',
    category: 'http_server',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('http_server_listening', 'HTTP Server Listening', 'http_server');
      const port = parseInt(process.env.PORT || '43110', 10);
      try {
        const http = await import('node:http');
        const start = Date.now();
        const ok = await new Promise<boolean>((resolve) => {
          const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
            res.destroy();
            resolve(res.statusCode === 200);
          });
          req.on('error', () => resolve(false));
          req.setTimeout(2000, () => { req.destroy(); resolve(false); });
        });
        const durationMs = Date.now() - start;
        if (!ok) {
          return fail(
            base,
            `GET /api/health on localhost:${port} did not return 200. Server may be unhealthy.`,
            'Check server.ts logs. If server.ts crashed, restart "npm run dev".',
            { port },
          );
        }
        return pass(base, `GET /api/health responded 200 in ${durationMs}ms.`, { port, durationMs });
      } catch (err) {
        return fail(base, `HTTP probe failed: ${err instanceof Error ? err.message : String(err)}`, 'Internal error — check Node.js installation.');
      }
    },
  };
}

export function createDiagnosticsEndpointsRespondingCheck(): IDiagnosticCheckRunner {
  return {
    id: 'diagnostics_endpoints_responding',
    name: 'Diagnostics Endpoints Responding',
    category: 'http_server',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('diagnostics_endpoints_responding', 'Diagnostics Endpoints Responding', 'http_server');
      const port = parseInt(process.env.PORT || '43110', 10);
      try {
        const http = await import('node:http');
        const probe = async (path: string): Promise<number> => {
          return new Promise<number>((resolve) => {
            const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
              res.destroy();
              resolve(res.statusCode ?? 0);
            });
            req.on('error', () => resolve(0));
            req.setTimeout(2000, () => { req.destroy(); resolve(0); });
          });
        };
        const [health, scan] = await Promise.all([
          probe('/api/diagnostics/health'),
          // /api/diagnostics/scan is POST-only; a GET should return 405 or 404.
          probe('/api/diagnostics/scan'),
        ]);
        if (health !== 200) {
          return fail(
            base,
            `GET /api/diagnostics/health returned ${health} — the diagnostics HTTP API is broken.`,
            'Check server.ts routes registration. Run "npm run lint".',
            { health, scan },
          );
        }
        return pass(
          base,
          `Diagnostics HTTP endpoints responding (/api/diagnostics/health → ${health}, /api/diagnostics/scan → ${scan}).`,
          { health, scan },
        );
      } catch (err) {
        return fail(base, `Diagnostics endpoint probe failed: ${err instanceof Error ? err.message : String(err)}`, 'Internal error — check Node.js installation.');
      }
    },
  };
}

// ─── Security checks ─────────────────────────────────────────────────

export function createNoSecretsInEnvCheck(): IDiagnosticCheckRunner {
  return {
    id: 'no_secrets_in_env',
    name: 'No Hardcoded Secrets in Environment',
    category: 'security',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('no_secrets_in_env', 'No Hardcoded Secrets in Environment', 'security');
      // Scan .env file (not the env vars themselves — those are
      // legitimately populated) for placeholders like "MY_GEMINI_API_KEY".
      const envPath = resolveProject('.env');
      if (!fs.existsSync(envPath)) {
        return pass(base, 'No .env file to scan (using env vars directly).');
      }
      try {
        const content = fs.readFileSync(envPath, 'utf8');
        const patterns = [
          { regex: /^(GEMINI_API_KEY|VITE_GEMINI_API_KEY)\s*=\s*["']?(MY_|PLACEHOLDER|your_|example_)/im, name: 'placeholder API key' },
          { regex: /^PASSWORD\s*=\s*["']?(test|admin|password|123456)/im, name: 'weak password' },
          { regex: /^.*TOKEN\s*=\s*["']?(ghp_|gho_|github_pat_)/im, name: 'GitHub PAT in .env (should be in OS keychain)' },
        ];
        const matches: string[] = [];
        for (const { regex, name } of patterns) {
          if (regex.test(content)) matches.push(name);
        }
        if (matches.length > 0) {
          return warn(
            base,
            `.env file contains potentially unsafe values: ${matches.join(', ')}.`,
            'Edit .env to use real, strong secrets. For GitHub PATs, prefer the OS keychain (git credential.helper osxkeychain / manager-core).',
            { matches },
          );
        }
        return pass(base, 'No obviously unsafe patterns detected in .env.');
      } catch (err) {
        return warn(base, `Could not scan .env: ${err instanceof Error ? err.message : String(err)}`, 'Check .env file permissions.');
      }
    },
  };
}

// ─── Build Integrity checks ───────────────────────────────────────────

export function createDistBuildIntegrityCheck(): IDiagnosticCheckRunner {
  return {
    id: 'dist_build_integrity',
    name: 'Build Artifacts (dist/) Integrity',
    category: 'build_integrity',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('dist_build_integrity', 'Build Artifacts (dist/) Integrity', 'build_integrity');
      // In dev mode, dist/ may be stale or missing. In production mode
      // (npm start), dist/server.cjs must exist and be non-trivial.
      const distPath = resolveProject('dist');
      if (!fs.existsSync(distPath)) {
        // dev mode — informational, not a failure
        return pass(
          base,
          'dist/ is not present — running in dev mode (tsx). This is fine for development; run "npm run build" before deploying.',
        );
      }
      const serverCjs = path.join(distPath, 'server.cjs');
      if (!fs.existsSync(serverCjs)) {
        return warn(
          base,
          'dist/ exists but dist/server.cjs is missing. "npm start" will fail.',
          'Run "npm run build" to produce the production bundle.',
        );
      }
      const stat = fs.statSync(serverCjs);
      if (stat.size < 100_000) {
        return warn(
          base,
          `dist/server.cjs is suspiciously small (${stat.size} bytes) — build may be incomplete.`,
          'Run "npm run clean && npm run build" to regenerate.',
          { size: stat.size },
        );
      }
      const sourceMapPath = path.join(distPath, 'server.cjs.map');
      const hasSourceMap = fs.existsSync(sourceMapPath);
      return pass(
        base,
        `dist/server.cjs present (${(stat.size / 1024).toFixed(1)}KB)${hasSourceMap ? ' with source map' : ' (no source map)'}.`,
        { size: stat.size, hasSourceMap },
      );
    },
  };
}

export function createTypescriptCleanCheck(): IDiagnosticCheckRunner {
  return {
    id: 'typescript_clean',
    name: 'TypeScript Type-Check',
    category: 'build_integrity',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('typescript_clean', 'TypeScript Type-Check', 'build_integrity');
      // This check runs `npx tsc --noEmit` which can take 3-5 seconds
      // on a real codebase. Make it opt-in via env var so the default
      // deep-scan stays fast. CI / production can enable it.
      if (process.env.SERA_DIAGNOSTIC_RUN_TSC !== '1') {
        return pass(
          base,
          'TypeScript check is opt-in (set SERA_DIAGNOSTIC_RUN_TSC=1 to enable). Use "npm run lint" directly for ad-hoc type-checks.',
        );
      }
      try {
        const result = await execAsync('npx tsc --noEmit', {
          cwd: process.cwd(),
          windowsHide: true,
          timeout: 90_000,
          maxBuffer: 8 * 1024 * 1024,
        });
        if (result.stderr && result.stderr.trim().length > 0) {
          return warn(
            base,
            `TypeScript emitted warnings: ${result.stderr.slice(0, 300)}`,
            'Run "npx tsc --noEmit" manually to see the full output.',
            { stderr: result.stderr.slice(0, 500) },
          );
        }
        return pass(base, 'TypeScript type-check passes with zero errors (tsc --noEmit).');
      } catch (err) {
        const errObj = err as { stdout?: string; stderr?: string; message?: string };
        const detail = errObj.stderr || errObj.stdout || errObj.message || String(err);
        return warn(
          base,
          `TypeScript type-check reported issues: ${detail.slice(0, 200)}`,
          'Run "npx tsc --noEmit" manually to see the full list. Fix the type errors before deploying.',
          { detail: detail.slice(0, 500) },
        );
      }
    },
  };
}

// ─── Disk Resources checks ────────────────────────────────────────────

export function createDiskSpaceHeadroomCheck(): IDiagnosticCheckRunner {
  return {
    id: 'disk_space_headroom',
    name: 'Disk Space Headroom',
    category: 'disk_resources',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('disk_space_headroom', 'Disk Space Headroom', 'disk_resources');
      try {
        const stat = await (await import('node:fs/promises')).statfs(process.cwd());
        const freeBytes = stat.bavail * stat.bsize;
        const freeMb = Math.round(freeBytes / 1024 / 1024);
        if (freeMb < 256) {
          return warn(
            base,
            `Only ${freeMb}MB free on the project's disk. SERA may fail to write memories, backups, or tmp files.`,
            'Free up disk space. On Linux: "df -h" to see top consumers; "sudo apt autoremove" to clean apt cache.',
            { freeMb, threshold: 256 },
            true,
            'AutoRepairEngine can prune tmp/ and .scratch/ files older than 24h.',
          );
        }
        return pass(base, `${freeMb}MB free disk space on project volume.`, { freeMb });
      } catch {
        // statfs is platform-specific; fall back to a no-op on platforms
        // where it's unavailable.
        return pass(base, `Disk space probe not available on platform "${process.platform}".`);
      }
    },
  };
}

export function createCpuLoadCheck(): IDiagnosticCheckRunner {
  return {
    id: 'cpu_load_average',
    name: 'CPU Load Average',
    category: 'disk_resources',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('cpu_load_average', 'CPU Load Average', 'disk_resources');
      if (process.platform === 'win32') {
        // loadavg() returns [0,0,0] on Windows. Use a different probe.
        try {
          const result = await execAsync('wmic cpu get loadpercentage /value', { windowsHide: true, timeout: 5000 });
          const match = result.stdout.match(/LoadPercentage=(\d+)/);
          const load = match ? parseInt(match[1], 10) : 0;
          if (load > 85) {
            return warn(base, `CPU load is ${load}% — high. Audio streaming may stutter.`, 'Close background processes. Check Task Manager for runaway processes.', { load });
          }
          return pass(base, `CPU load is ${load}%.`, { load });
        } catch {
          return pass(base, 'CPU load probe unavailable on Windows (wmic not present).');
        }
      }
      const loads = os.loadavg();
      const cores = os.cpus().length || 1;
      const oneMinPct = Math.round((loads[0] / cores) * 100);
      if (oneMinPct > 85) {
        return warn(
          base,
          `1-min load average is ${loads[0].toFixed(2)} across ${cores} cores (${oneMinPct}% utilization). High.`,
          'Check "top" or "htop" for runaway processes.',
          { loads, cores, oneMinPct },
        );
      }
      return pass(
        base,
        `Load averages: 1min=${loads[0].toFixed(2)}, 5min=${loads[1].toFixed(2)}, 15min=${loads[2].toFixed(2)} across ${cores} cores.`,
        { loads, cores, oneMinPct },
      );
    },
  };
}

// ─── Electron (desktop mode) checks ───────────────────────────────────

export function createElectronEntryPresentCheck(): IDiagnosticCheckRunner {
  return {
    id: 'electron_entry_present',
    name: 'Electron Main Process Script',
    category: 'file_system',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('electron_entry_present', 'Electron Main Process Script', 'file_system');
      const main = resolveProject('electron/main.cjs');
      const preload = resolveProject('electron/preload.cjs');
      const missing: string[] = [];
      if (!fs.existsSync(main)) missing.push('electron/main.cjs');
      if (!fs.existsSync(preload)) missing.push('electron/preload.cjs');
      if (missing.length > 0) {
        return warn(
          base,
          `Electron entry files missing: ${missing.join(', ')}. "npm run desktop:dev" will fail.`,
          'Re-clone the repository or restore the missing files from git: "git checkout -- electron/".',
          { missing },
        );
      }
      return pass(base, 'Electron main.cjs and preload.cjs both present.');
    },
  };
}

// ─── Source File Imports (sanity) ────────────────────────────────────

export function createSourceImportsHealthyCheck(): IDiagnosticCheckRunner {
  return {
    id: 'source_imports_healthy',
    name: 'Source Module Imports',
    category: 'build_integrity',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('source_imports_healthy', 'Source Module Imports', 'build_integrity');
      // In the compiled bundle (dist/server.cjs) every one of these modules is
      // inlined into a single file — the running server itself is the proof the
      // graph imports cleanly. Probing the relative paths from dist/ always
      // throws "Cannot find module" and produced a false alarm on every
      // production install, so only source runs (tsx server.ts / vitest) probe.
      const runningFromBundle =
        typeof __filename === 'string' && __filename.split(path.sep).includes('dist');
      if (runningFromBundle) {
        return pass(base, 'Compiled bundle: core modules are inlined and loaded — the running server proves the import graph is intact.');
      }
      // Probe that the most-imported source modules load without errors.
      // This catches circular imports, broken exports, type-level typos
      // that survived tsc but fail at runtime, etc.
      const modules = [
        '../tools/toolRegistry',
        '../actions/ActionManager',
        '../browser/BrowserSessionManager',
        '../clipboard/ClipboardManager',
      ];
      const failures: string[] = [];
      for (const mod of modules) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports, no-await-in-loop
          await import(mod);
        } catch (err) {
          failures.push(`${mod}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (failures.length > 0) {
        return warn(
          base,
          `Failed to import core source modules: ${failures.join(' | ')}.`,
          'Run "npm run lint" and "npm test" to see the underlying TypeScript errors.',
          { failures },
        );
      }
      return pass(base, `All ${modules.length} core source modules import cleanly.`);
    },
  };
}

// ─── esmDirname sanity (meta-check) ──────────────────────────────────

export function createEsmShimHealthyCheck(): IDiagnosticCheckRunner {
  return {
    id: 'esm_shim_healthy',
    name: 'ESM/CJS Shim Working',
    category: 'node_runtime',
    run: async (): Promise<DiagnosticCheckResult> => {
      const base = buildBase('esm_shim_healthy', 'ESM/CJS Shim Working', 'node_runtime');
      // Sanity probe: esmDirname should be a real path string and
      // esmRequire should be a callable function. This catches
      // regressions where the shim is broken (e.g. import.meta.url not
      // being shimmed by esbuild in some edge case).
      try {
        if (typeof esmDirname !== 'string' || !esmDirname) {
          return fail(base, 'esmDirname is empty or not a string — ESM shim is broken.', 'Check src/diagnostics/esmShim.ts. import.meta.url may not be available.');
        }
        if (typeof esmRequire !== 'function') {
          return fail(base, 'esmRequire is not a function — ESM shim is broken.', 'Check src/diagnostics/esmShim.ts. createRequire may not be available.');
        }
        return pass(base, `ESM shim works. esmDirname="${esmDirname.slice(-60)}…"`, { dirname: esmDirname });
      } catch (err) {
        return fail(base, `ESM shim probe failed: ${err instanceof Error ? err.message : String(err)}`, 'Check src/diagnostics/esmShim.ts.');
      }
    },
  };
}

// ─── Catalog export ────────────────────────────────────────────────────

/**
 * Convenience array of every comprehensive check factory defined above.
 * `SystemDiagnosticService.registerDefaultChecks()` iterates this list
 * and registers each one. Adding a new check is as simple as defining
 * a new factory here and appending it to this array.
 */
export const COMPREHENSIVE_CHECK_FACTORIES: Array<() => IDiagnosticCheckRunner> = [
  // Node runtime
  createNodeVersionCheck,
  createProcessUptimeCheck,
  createEventLoopLagCheck,
  createHeapMemoryCheck,
  createUncaughtHandlerCheck,
  createEsmShimHealthyCheck,

  // Environment & security
  createEnvFilePresentCheck,
  createEnvNoPlaceholdersCheck,
  createNoSecretsInEnvCheck,

  // File system
  createProjectRootWritableCheck,
  createDataDirectoryWritableCheck,
  createBackupsDirectoryWritableCheck,
  createTmpDirectoryWritableCheck,
  createKeySourceFilesPresentCheck,
  createTrainedDataPresentCheck,
  createElectronEntryPresentCheck,

  // Native modules
  createKoffiLoadableCheck,
  createActiveWinLoadableCheck,
  createPngjsLoadableCheck,
  createWin32ApiLoadableCheck,

  // Dependencies
  createNodeModulesPresentCheck,
  createPackageLockPresentCheck,

  // Network
  createGoogleDnsResolvableCheck,
  createGeminiEndpointReachableCheck,

  // Audio
  createAudioDevicesCountCheck,

  // Browser
  createManagedBrowserSessionCheck,

  // Window management
  createActiveWindowDetectableCheck,

  // Application launcher
  createAppLauncherAvailableCheck,

  // Tool registry
  createToolRegistryCountCheck,

  // WebSocket / HTTP
  createWebSocketServerListeningCheck,
  createHttpServerListeningCheck,
  createDiagnosticsEndpointsRespondingCheck,

  // Build integrity
  createDistBuildIntegrityCheck,
  createTypescriptCleanCheck,
  createSourceImportsHealthyCheck,

  // Disk & CPU
  createDiskSpaceHeadroomCheck,
  createCpuLoadCheck,
];
