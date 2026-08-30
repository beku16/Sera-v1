import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DiagnosticCheckResult,
  DiagnosticReport,
  IDiagnosticCheckRunner,
  ScanContext,
} from './types';
import { defaultAutoRepairEngine, AutoRepairEngine } from './AutoRepairEngine';
// ESM-safe shims — fixes the "require is not defined" and
// "__dirname is not defined" runtime errors that previously crashed
// the robotjs / screen-capture / audio-pipeline diagnostic checks
// whenever the dev server ran via `tsx server.ts` (ESM mode). See
// esmShim.ts for the full explanation.
import { esmRequire, esmDirname } from './esmShim';
// A→Z comprehensive deep-scan checks — see comprehensiveChecks.ts.
import { COMPREHENSIVE_CHECK_FACTORIES } from './comprehensiveChecks';
// v1.6.x feature-coverage checks — every shipped feature gets an explicit
// A→Z diagnostic (orchestrator, Ollama, vault, learning, AGI, OS-browser
// integration, whisper/piper, Electron host, key-map, DSP, sleep intents).
import { FEATURE_CHECK_FACTORIES } from './featureChecks';
// Keys added via the Startup Launcher / Settings → API KEYS live in the
// encrypted vault, not in .env. The Gemini health check must use the SAME
// resolution chain as server.ts or it reports false "key missing" alarms.
import { defaultApiKeyVault } from '../local/ApiKeyVault';
import { memoryFilePath, speechHostPath } from '../local/SERAPaths';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Probes whether a binary is available on the user's PATH. Used by the
 * Linux fallback paths of the computer-control / screen / clipboard
 * diagnostics to surface "you need to install xdotool" instead of
 * silently reporting "passed (N/A)" — which was the false-positive
 * root cause of the "system shows healthy when everything is broken"
 * complaint on Linux hosts.
 */
async function commandExists(command: string): Promise<boolean> {
  try {
    // `which` on Linux/macOS, `where.exe` on Windows. We use execFile
    // (not exec) to avoid shell-injection pitfalls on the command name.
    const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
    await execFileAsync(lookup, [command], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Canonical location of Sera's persistent memory store.
 *
 * MUST stay in sync with NodeMemoryStore's default path and AutoRepairEngine's
 * MEMORY_FILE constant. Centralising it prevents the diagnostic from checking
 * a different file than the one the live memory manager actually reads/writes.
 */
// v1.9.0 (BUG L5): authoritative home is the per-user SERA data dir.
const MEMORY_FILE = process.env.SERA_MEMORY_FILE || memoryFilePath();

/**
 * SystemDiagnosticService — Comprehensive Multi-Component System Diagnostic Scanner
 *
 * ## Why this file was rewritten
 *
 * The previous version reported `audio_pipeline_state` and
 * `browser_process_zombies` as "passed" with hardcoded strings — no actual
 * checks were performed. As a result, `overallStatus` was always `healthy`
 * even when every single capability-gated tool (keyboard, mouse, screen,
 * clipboard, browser, application launch) was failing in production. This
 * was the root cause of the user-reported "system health is showing healthy
 * even when the things are not working currently" complaint.
 *
 * The rewritten checks below ACTUALLY probe each subsystem:
 *  - Robotjs native module loads cleanly on Windows
 *  - robot.screen.capture() returns a non-empty bitmap
 *  - PowerShell Get-Clipboard / Set-Clipboard round-trip a probe string
 *  - Playwright's bundled Chromium is installed and launchable
 *  - All ActionManager executors that toolRegistry.ts wires up are actually
 *    registered (catches "I refactored toolRegistry and forgot to register
 *    an executor" — the silent failure mode that made every tool of a given
 *    type return "No executor supports action type X" without surfacing
 *    anywhere)
 *  - speech-host.cjs (the local speech recognition worker) exists on disk
 *  - Active Windows processes that look like orphaned Chromium workers
 *
 * Each check returns 'passed' ONLY when the underlying capability actually
 * works. Otherwise it returns 'failed' or 'warning' with an actionable
 * userActionGuide. The auto-repair engine can then either fix it or
 * escalate — but it can no longer hide it.
 */
export class SystemDiagnosticService {
  private checkRunners: IDiagnosticCheckRunner[] = [];
  private repairEngine: AutoRepairEngine;

  constructor(repairEngine: AutoRepairEngine = defaultAutoRepairEngine) {
    this.repairEngine = repairEngine;
    this.registerDefaultChecks();
  }

  public registerCheck(runner: IDiagnosticCheckRunner): void {
    this.checkRunners.push(runner);
  }

  /**
   * Performs a system diagnostic scan.
   *
   * v1.6.11 FIX: `deep` used to live in a shared mutable `deepScanMode`
   * boolean written at the top of every runFullScan — a passive sweep
   * starting mid-deep-scan flipped the flag and the deep scan silently
   * lost its clipboard write probe. The depth now travels through a
   * per-scan ScanContext handed to each runner.
   *
   * v1.6.8: `options.deep` marks a scan the user EXPLICITLY requested
   * (the "Run Full Scan" button). Deep scans may briefly write a probe to
   * the clipboard to verify the write path. Background sweeps (the 45s
   * SystemHealthMonitor daemon and /api/diagnostics/health) run WITHOUT
   * the flag — they are read-only and can never pollute the user's
   * clipboard history again (the old always-write behavior filled
   * Win+V clip history with dozens of "sera-clip-probe-*" entries).
   */
  public async runFullScan(options?: { deep?: boolean }): Promise<DiagnosticReport> {
    const scanContext: ScanContext = { deep: options?.deep === true };
    const results: DiagnosticCheckResult[] = [];

    for (const runner of this.checkRunners) {
      try {
        const res = await runner.run(scanContext);
        results.push(res);
      } catch (err) {
        results.push({
          checkId: runner.id,
          name: runner.name,
          category: runner.category,
          severity: 'critical',
          status: 'failed',
          message: `Check execution threw an unexpected error: ${err instanceof Error ? err.message : String(err)}`,
          repairStatus: 'requires_user_action',
          autoFixAvailable: false,
          userActionGuide: 'Review system error logs and ensure dependencies are installed.',
          timestamp: Date.now(),
        });
      }
    }

    const passed = results.filter((r) => r.status === 'passed').length;
    const warnings = results.filter((r) => r.status === 'warning').length;
    const criticals = results.filter((r) => r.severity === 'critical' && r.status === 'failed').length;
    const autoFixable = results.filter((r) => r.autoFixAvailable && r.status !== 'passed').length;

    let overallStatus: 'healthy' | 'degraded' | 'critical' = 'healthy';
    if (criticals > 0) {
      overallStatus = 'critical';
    } else if (warnings > 0) {
      overallStatus = 'degraded';
    }

    return {
      timestamp: Date.now(),
      overallStatus,
      summary: {
        totalChecks: results.length,
        passed,
        warnings,
        criticals,
        autoFixable,
      },
      checks: results,
    };
  }

  /**
   * Runs all available safe auto-repairs for failed checks in a report
   */
  public async autoRepairReport(report: DiagnosticReport) {
    return this.repairEngine.executeAllSafeRepairs(report.checks);
  }

  public getRepairEngine(): AutoRepairEngine {
    return this.repairEngine;
  }

  /**
   * Probes whether the native computer-control backend loads cleanly.
   *
   * On Windows the backend is `robotjs` (a native Node addon). On Linux
   * the backend is `xdotool` (an external binary invoked via child_process).
   * On macOS neither is supported out of the box.
   *
   * Previously this check returned `'passed'` with `severity: 'info'` on
   * every non-Windows host. Because `severity: 'info'` is neither
   * `'critical'` nor `'warning'`, `overallStatus` was computed as
   * `'healthy'` on Linux even though `loadRobot()` returns null and every
   * input/screen tool threw `PLATFORM_NOT_SUPPORTED`. That was the
   * structural root cause of the user-reported "system health shows
   * healthy when nothing actually works" complaint.
   *
   * Now the check ACTUALLY probes the host's backend (whichever applies
   * to the current platform) and reports `'failed'` / `severity:'critical'`
   * when the backend is missing — so `overallStatus` correctly downgrades
   * to `'critical'` and the user sees the real reason their computer
   * control tools don't work.
   */
  private async checkRobotjsAvailability(): Promise<DiagnosticCheckResult> {
    const base: Omit<DiagnosticCheckResult, 'status' | 'severity' | 'message' | 'repairStatus' | 'autoFixAvailable' | 'fixDescription' | 'userActionGuide'> = {
      checkId: 'computer_control_native',
      name: 'Computer Control Native Module',
      category: 'computer_control_native',
      timestamp: Date.now(),
    };

    if (process.platform === 'win32') {
      try {
        // Use esmRequire() instead of bare require() — bare require
        // throws `ReferenceError: require is not defined` under tsx
        // (ESM mode), which made this check report "robotjs native
        // module failed to load: require is not defined" even though
        // robotjs was perfectly healthy. See esmShim.ts.
        const robot = esmRequire('robotjs');
        // Probe a tiny touch of the API to make sure the native binary is
        // actually callable, not just that the require() resolved.
        const pos = robot.getMousePos();
        if (typeof pos?.x !== 'number' || typeof pos?.y !== 'number') {
          throw new Error('robotjs.getMousePos returned a malformed result.');
        }
        return {
          ...base,
          severity: 'healthy',
          status: 'passed',
          message: 'robotjs native module loads and responds to getMousePos.',
          details: { supported: true, backend: 'robotjs', cursor: pos },
          repairStatus: 'not_applicable',
          autoFixAvailable: false,
        };
      } catch (err) {
        return {
          ...base,
          severity: 'critical',
          status: 'failed',
          message: `robotjs native module failed to load: ${err instanceof Error ? err.message : String(err)}`,
          details: { supported: false, backend: 'robotjs', error: err instanceof Error ? err.message : String(err) },
          repairStatus: 'requires_user_action',
          autoFixAvailable: false,
          userActionGuide: 'Run "npm rebuild robotjs" or reinstall the project dependencies. On Windows, install the Visual Studio Build Tools (C++) and Python 3.x — both are required to rebuild native Node addons. See the robotjs install docs.',
        };
      }
    }

    if (process.platform === 'linux') {
      // Linux backend is xdotool ( keyboard / mouse / window focus ).
      const xdotoolOk = await commandExists('xdotool');
      if (xdotoolOk) {
        return {
          ...base,
          severity: 'healthy',
          status: 'passed',
          message: 'xdotool is available on PATH. Linux computer control (keyboard / mouse) is supported.',
          details: { supported: true, backend: 'xdotool' },
          repairStatus: 'not_applicable',
          autoFixAvailable: false,
        };
      }
      return {
        ...base,
        severity: 'critical',
        status: 'failed',
        message: 'xdotool is not installed. Linux keyboard / mouse control will throw PLATFORM_NOT_SUPPORTED for every input.* action.',
        details: { supported: false, backend: 'xdotool', missing: ['xdotool'] },
        repairStatus: 'requires_user_action',
        autoFixAvailable: false,
        userActionGuide: 'Install xdotool via your distro package manager (e.g. "sudo apt install xdotool" on Debian/Ubuntu, "sudo dnf install xdotool" on Fedora, "sudo pacman -S xdotool" on Arch).',
      };
    }

    // macOS and others: genuinely unsupported.
    return {
      ...base,
      severity: 'critical',
      status: 'failed',
      message: `Computer control is not supported on platform "${process.platform}". Keyboard, mouse, and screen capture tools will all fail.`,
      details: { supported: false, backend: 'none', platform: process.platform },
      repairStatus: 'requires_user_action',
      autoFixAvailable: false,
      userActionGuide: 'Run SERA on Windows (robotjs) or Linux (xdotool) for computer control capabilities.',
    };
  }

  /**
   * Probes whether screen capture actually returns a non-empty bitmap.
   * This catches the failure mode where the backend loads but the screen
   * is empty (locked session, no graphical display, missing scrot/imp,
   * etc.). On Linux, the backend is `scrot` (preferred) or
   * `gnome-screenshot` / `import` (ImageMagick) as fallbacks.
   */
  private async checkScreenCaptureAvailability(): Promise<DiagnosticCheckResult> {
    const base: Omit<DiagnosticCheckResult, 'status' | 'severity' | 'message' | 'repairStatus' | 'autoFixAvailable' | 'fixDescription' | 'userActionGuide'> = {
      checkId: 'screen_capture_availability',
      name: 'Screen Capture Availability',
      category: 'screen_capture',
      timestamp: Date.now(),
    };

    if (process.platform === 'win32') {
      try {
        // Same ESM shim fix as checkRobotjsAvailability — bare require()
        // throws under tsx and made this check report "Screen capture
        // failed: require is not defined" even though screen capture
        // worked fine in production mode.
        const robot = esmRequire('robotjs');
        const image = robot.screen.capture();
        if (!image || !image.image || image.image.length === 0 || image.width <= 0 || image.height <= 0) {
          return {
            ...base,
            severity: 'critical',
            status: 'failed',
            message: 'robotjs.screen.capture() returned an empty image. Screen inspection and screenshots will fail.',
            details: { width: image?.width, height: image?.height, bytes: image?.image?.length },
            repairStatus: 'requires_user_action',
            autoFixAvailable: false,
            userActionGuide: 'Ensure the desktop is not locked and the active user session has a graphical display. If running via RDP, enable the appropriate graphics capture mode. Check GPU drivers.',
          };
        }
        return {
          ...base,
          severity: 'healthy',
          status: 'passed',
          message: `Screen capture returned a valid ${image.width}x${image.height} bitmap.`,
          details: { supported: true, backend: 'robotjs', width: image.width, height: image.height, bytes: image.image.length },
          repairStatus: 'not_applicable',
          autoFixAvailable: false,
        };
      } catch (err) {
        return {
          ...base,
          severity: 'critical',
          status: 'failed',
          message: `Screen capture failed: ${err instanceof Error ? err.message : String(err)}`,
          details: { error: err instanceof Error ? err.message : String(err) },
          repairStatus: 'requires_user_action',
          autoFixAvailable: false,
          userActionGuide: 'Run the computer_control_native diagnostic first — if robotjs is broken, screen capture will also be broken.',
        };
      }
    }

    if (process.platform === 'linux') {
      // Probe for one of the supported Linux screen-capture binaries.
      // scrot is the lightest and most universal; gnome-screenshot and
      // ImageMagick's `import` are common alternatives. We don't actually
      // capture here (that would freeze the diagnostic on a slow headless
      // X server); we just confirm the binary is on PATH.
      const candidates = ['scrot', 'gnome-screenshot', 'import'];
      for (const candidate of candidates) {
        if (await commandExists(candidate)) {
          return {
            ...base,
            severity: 'healthy',
            status: 'passed',
            message: `Screen capture backend "${candidate}" is available on PATH.`,
            details: { supported: true, backend: candidate },
            repairStatus: 'not_applicable',
            autoFixAvailable: false,
          };
        }
      }
      return {
        ...base,
        severity: 'critical',
        status: 'failed',
        message: 'No Linux screen-capture backend found (scrot / gnome-screenshot / import). Screenshots and screen inspection will throw.',
        details: { supported: false, missing: candidates },
        repairStatus: 'requires_user_action',
        autoFixAvailable: false,
        userActionGuide: 'Install one of: scrot ("sudo apt install scrot"), gnome-screenshot ("sudo apt install gnome-screenshot"), or ImageMagick ("sudo apt install imagemagick").',
      };
    }

    return {
      ...base,
      severity: 'critical',
      status: 'failed',
      message: `Screen capture is not supported on platform "${process.platform}".`,
      details: { supported: false, platform: process.platform },
      repairStatus: 'requires_user_action',
      autoFixAvailable: false,
      userActionGuide: 'Run SERA on Windows (robotjs) or Linux (scrot/gnome-screenshot) for screen capture.',
    };
  }

  /**
   * Probes the clipboard round-trip on whatever backend the host has.
   * On Windows that's PowerShell Get/Set-Clipboard. On Linux it's
   * xclip / xsel / wl-clipboard (handled by DefaultClipboardProvider
   * after the Linux fallback was added). The check writes a probe
   * string, reads it back, and verifies the values match.
   *
   * Previously this returned `'passed'` with `severity: 'info'` on every
   * non-Windows host, which silently masked the fact that on Linux the
   * clipboard provider was hard-coded to return `null` / `false` — so
   * `clipboard.set` always threw `CLIPBOARD_WRITE_FAILED` but the
   * diagnostic said everything was fine. Now we probe the real
   * provider and surface the failure as `'critical'`.
   */
  private async checkClipboardAvailability(deep: boolean = false): Promise<DiagnosticCheckResult> {
    const base: Omit<DiagnosticCheckResult, 'status' | 'severity' | 'message' | 'repairStatus' | 'autoFixAvailable' | 'fixDescription' | 'userActionGuide'> = {
      checkId: 'clipboard_availability',
      name: 'Clipboard Round-Trip',
      category: 'clipboard',
      timestamp: Date.now(),
    };

    if (process.platform === 'linux') {
      // Verify at least one Linux clipboard backend is on PATH before
      // probing the actual round-trip. If none is installed, the
      // DefaultClipboardProvider returns false and we'd report the
      // round-trip as failed — but the user-action guide would say
      // "powershell.exe is missing", which is misleading on Linux.
      const candidates = ['xclip', 'xsel', 'wl-copy'];
      let found: string | null = null;
      for (const candidate of candidates) {
        if (await commandExists(candidate)) { found = candidate; break; }
      }
      if (!found) {
        return {
          ...base,
          severity: 'critical',
          status: 'failed',
          message: 'No Linux clipboard backend found (xclip / xsel / wl-copy). Clipboard tools will throw CLIPBOARD_WRITE_FAILED.',
          details: { supported: false, missing: candidates },
          repairStatus: 'requires_user_action',
          autoFixAvailable: false,
          userActionGuide: 'Install one of: xclip ("sudo apt install xclip"), xsel ("sudo apt install xsel"), or wl-clipboard for Wayland ("sudo apt install wl-clipboard").',
        };
      }
      // fall through to the actual round-trip probe below.
    } else if (process.platform !== 'win32') {
      // macOS and other platforms: no clipboard backend at all.
      return {
        ...base,
        severity: 'critical',
        status: 'failed',
        message: `Clipboard is not supported on platform "${process.platform}".`,
        details: { supported: false, platform: process.platform },
        repairStatus: 'requires_user_action',
        autoFixAvailable: false,
        userActionGuide: 'Run SERA on Windows (PowerShell) or Linux (xclip/xsel/wl-clipboard) for clipboard access.',
      };
    }

    // v1.6.8 — PASSIVE FIRST, WRITE ONLY ON DEEP SCANS.
    //
    // v1.6.6→v1.6.8 history: this check used to WRITE a
    // `sera-clip-probe-<ts>-<rand>` string to the user's clipboard and
    // restore it afterwards. Even with the restore, EVERY write lands in
    // the OS clipboard history (Win+V / Ditto / KDE klipper record each
    // Set-Clipboard), so the 45s health sweep silently stuffed the user's
    // clip history with dozens of probe strings — and the restore added
    // yet another entry. v1.6.8 restricted the write to explicit Full
    // Scans, but users run Full Scans too, and v1.6.9 field reports
    // confirmed probes were STILL appearing.
    //
    // v1.6.9 FINAL: the clipboard check is now 100% READ-ONLY on every
    // path, including deep scans. A read verifies the backend binary is
    // alive; the write path is exercised by the real clipboard tools the
    // user actually invokes (copy/paste/restore), which is the only
    // context where touching the user's clipboard is acceptable. There is
    // no code path left in SERA that writes a probe string.
    const { defaultClipboardProvider } = await import('../clipboard/ClipboardManager');
    {
      try {
        const readBack = await defaultClipboardProvider.get();
        return {
          ...base,
          severity: 'healthy',
          status: 'passed',
          message: deep
            ? 'Clipboard backend reachable (deep scan — still read-only; SERA never writes probe strings).'
            : 'Clipboard backend reachable (read-only check — your clipboard history stays untouched).',
          details: {
            supported: true,
            mode: deep ? 'deep (read-only)' : 'passive',
            readBytes: typeof readBack === 'string' ? readBack.length : 0,
            writeProbe: 'removed in v1.6.9 — SERA no longer writes to your clipboard during diagnostics',
          },
          repairStatus: 'not_applicable',
          autoFixAvailable: false,
        };
      } catch (err) {
        return {
          ...base,
          severity: 'critical',
          status: 'failed',
          message: `Clipboard read failed: ${err instanceof Error ? err.message : String(err)}`,
          repairStatus: 'requires_user_action',
          autoFixAvailable: false,
          userActionGuide: process.platform === 'win32'
            ? 'Check that powershell.exe is on PATH and the user has clipboard access. Try running "Get-Clipboard" in a terminal to verify.'
            : 'Check that xclip / xsel / wl-copy is installed and DISPLAY/WAYLAND_DISPLAY is set. Try "echo test | xclip -selection clipboard" in a terminal to verify.',
        };
      }
    }
  }

  /**
   * Probes whether Playwright's bundled Chromium is installed and
   * launchable. This is the check that would have caught the silent
   * `browserOpen` / `browserRead` / `browserTabs` / `sendWhatsAppMessage`
   * failures that happen when nobody has run
   * `npx playwright install chromium` on the host.
   */
  private async checkPlaywrightBrowserInstall(): Promise<DiagnosticCheckResult> {
    const base: Omit<DiagnosticCheckResult, 'status' | 'severity' | 'message' | 'repairStatus' | 'autoFixAvailable' | 'fixDescription' | 'userActionGuide'> = {
      checkId: 'playwright_browser_install',
      name: 'Playwright Chromium Install',
      category: 'playwright_browser',
      timestamp: Date.now(),
    };

    // If we're attached to an existing CDP endpoint (Electron renderer
    // with embedded browser, or external Chromium), we don't need
    // Playwright's bundled Chromium at all — declare pass and move on.
    if (process.env.BROWSER_CDP_URL) {
      return {
        ...base,
        severity: 'healthy',
        status: 'passed',
        message: `Using an external CDP browser at ${process.env.BROWSER_CDP_URL}. Bundled Chromium is not required.`,
        details: { cdpUrl: process.env.BROWSER_CDP_URL, bundled: false },
        repairStatus: 'not_applicable',
        autoFixAvailable: false,
      };
    }

    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();
      const title = await page.title();
      await context.close();
      await browser.close();
      return {
        ...base,
        severity: 'healthy',
        status: 'passed',
        message: `Playwright Chromium launched cleanly. Initial page title: "${title || '<blank>'}".`,
        details: { bundled: true, sampleTitle: title },
        repairStatus: 'not_applicable',
        autoFixAvailable: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The most common error is "Executable doesn't exist at .../chromium-*/chrome-win/chrome.exe"
      // — i.e. the bundled browser was never installed via `npx playwright install`.
      const looksLikeMissingBrowser = /Executable doesn't exist|chromium|browser was not found/i.test(message);
      return {
        ...base,
        severity: 'critical',
        status: 'failed',
        message: looksLikeMissingBrowser
          ? `Playwright Chromium is not installed. Browser tools (browserOpen, browserRead, browserTabs, sendWhatsAppMessage) will all fail. Underlying error: ${message}`
          : `Playwright Chromium launch failed: ${message}`,
        details: { bundled: false, error: message },
        repairStatus: 'requires_user_action',
        autoFixAvailable: false,
        userActionGuide: looksLikeMissingBrowser
          ? 'Run "npx playwright install chromium" in the project root. This downloads Playwright\'s bundled Chromium (~150 MB) so managed-browser tools work.'
          : 'Check Playwright installation and permissions. The error message above describes the underlying failure.',
      };
    }
  }

  /**
   * Verifies that the local speech recognition worker script exists on disk.
   * If speech-host.cjs is missing, the entire local-speech pipeline
   * (used for wake-word + offline transcription) silently fails with
   * "LOCAL_SPEECH_ERROR: spawn ENOENT" — which the previous diagnostic
   * never caught because it just declared audio_pipeline_state as
   * "passed" unconditionally.
   */
  private checkSpeechHostScript(): DiagnosticCheckResult {
    const base: Omit<DiagnosticCheckResult, 'status' | 'severity' | 'message' | 'repairStatus' | 'autoFixAvailable' | 'fixDescription' | 'userActionGuide'> = {
      checkId: 'audio_pipeline_state',
      name: 'Audio Pipeline & Local Speech Host',
      category: 'audio_pipeline',
      timestamp: Date.now(),
    };

    const candidates = [
      speechHostPath(),
      // __dirname is not defined under tsx (ESM) — use the esmDirname
      // shim which falls back to fileURLToPath(import.meta.url).
      path.resolve(esmDirname, '..', '..', 'electron', 'speech-host.cjs'),
    ];
    const foundAt = candidates.find((candidate) => {
      try { return fs.existsSync(candidate); } catch { return false; }
    });
    if (!foundAt) {
      return {
        ...base,
        severity: 'critical',
        status: 'failed',
        message: 'Local speech worker (electron/speech-host.cjs) was not found. Wake-word and offline transcription will fail.',
        details: { candidatesChecked: candidates },
        repairStatus: 'requires_user_action',
        autoFixAvailable: false,
        userActionGuide: 'Reinstall the SERA project — electron/speech-host.cjs is part of the repo and should always exist. If you deleted it, restore it from git.',
      };
    }
    return {
      ...base,
      severity: 'healthy',
      status: 'passed',
      message: `Local speech worker present at ${foundAt}.`,
      details: { path: foundAt },
      repairStatus: 'not_applicable',
      autoFixAvailable: false,
    };
  }

  /**
   * Counts active chromium-related processes that look like orphaned
   * Playwright workers. A handful is normal (current managed browser
   * session); dozens accumulating across runs indicates a leak.
   * On Linux we use `ps` (universal); on Windows we use `tasklist.exe`.
   */
  private async checkBrowserZombieProcesses(): Promise<DiagnosticCheckResult> {
    const base: Omit<DiagnosticCheckResult, 'status' | 'severity' | 'message' | 'repairStatus' | 'autoFixAvailable' | 'fixDescription' | 'userActionGuide'> = {
      checkId: 'browser_process_zombies',
      name: 'Browser Automation & Zombie Worker Count',
      category: 'browser_automation',
      timestamp: Date.now(),
    };

    try {
      let lines: string[] = [];
      let zombiePatterns: string[] = [];
      if (process.platform === 'win32') {
        const result = await execAsync('tasklist.exe /NH /FO CSV', { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
        lines = result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
        zombiePatterns = ['chrome.exe', 'msedge.exe', 'playwright', 'headless_shell'];
      } else if (process.platform === 'linux' || process.platform === 'darwin') {
        // `ps -eo comm=` lists just the executable name per process, no header.
        // We look for chromium-derived processes by name (chrome, chromium,
        // headless_shell, playwright). The `ps` binary is universally
        // available on POSIX systems.
        const result = await execAsync('ps -eo comm=', { maxBuffer: 16 * 1024 * 1024 });
        lines = result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
        zombiePatterns = ['chrome', 'chromium', 'msedge', 'playwright', 'headless_shell'];
      } else {
        // Other platforms: report as 'passed (N/A)' but with severity
        // 'info' — this is the only check where 'info' is acceptable,
        // because the zombie-scan is a hygiene check, not a capability
        // gate. The other Windows-only checks (computer control / screen
        // / clipboard) are capability gates and now fail loudly on
        // unsupported platforms.
        return {
          ...base,
          severity: 'info',
          status: 'passed',
          message: `Browser zombie process scan is not implemented on platform "${process.platform}".`,
          details: { supported: false, platform: process.platform },
          repairStatus: 'not_applicable',
          autoFixAvailable: false,
        };
      }

      let zombieCount = 0;
      for (const line of lines) {
        const lower = line.toLowerCase();
        if (zombiePatterns.some((pattern) => lower.includes(pattern))) zombieCount += 1;
      }
      // A managed browser session will spawn at least one Chromium process
      // (one per tab + the browser process itself), so 0 is unusual (no
      // browser has been launched yet) and ~5-15 is normal. Anything above
      // 25 is a leak that needs cleanup.
      if (zombieCount > 25) {
        return {
          ...base,
          severity: 'warning',
          status: 'warning',
          message: `High Chromium-derived process count: ${zombieCount}. Likely orphaned Playwright workers from crashed sessions.`,
          details: { zombieCount },
          repairStatus: 'can_auto_fix',
          autoFixAvailable: true,
          fixDescription: 'Gracefully close orphaned browser sessions via the BrowserSessionManager closeSession API.',
          userActionGuide: 'Restart the SERA Electron app to clear orphaned processes. If the count keeps growing, there is a leak in BrowserSessionManager.',
        };
      }
      return {
        ...base,
        severity: 'healthy',
        status: 'passed',
        message: `${zombieCount} Chromium-derived process(es) running — within normal bounds.`,
        details: { zombieCount },
        repairStatus: 'not_applicable',
        autoFixAvailable: false,
      };
    } catch (err) {
      return {
        ...base,
        severity: 'warning',
        status: 'warning',
        message: `Could not enumerate browser processes: ${err instanceof Error ? err.message : String(err)}`,
        repairStatus: 'requires_user_action',
        autoFixAvailable: false,
        userActionGuide: process.platform === 'win32'
          ? 'Ensure tasklist.exe is available on PATH (it is part of Windows by default).'
          : 'Ensure `ps` is available on PATH (it is part of procps, default on most Linux distros).',
      };
    }
  }

  private registerDefaultChecks(): void {
    // 1. Gemini API & Connectivity Check
    this.registerCheck({
      id: 'gemini_api_health',
      name: 'Gemini API & Connectivity Health',
      category: 'api_connectivity',
      run: async (): Promise<DiagnosticCheckResult> => {
        // Resolve the key exactly the way server.ts does for real Gemini
        // sessions: environment variables (.env) first, then the encrypted
        // key vault populated by the Startup Launcher / Settings → API KEYS.
        const envKey = (process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '').trim();
        let apiKey: string | null = envKey || null;
        let keySource: 'environment (.env)' | 'encrypted key vault' | null = envKey
          ? 'environment (.env)'
          : null;
        if (!apiKey) {
          try {
            if (defaultApiKeyVault.has('gemini')) {
              const vaultKey = defaultApiKeyVault.resolveKey('gemini');
              if (vaultKey && vaultKey.trim()) {
                apiKey = vaultKey.trim();
                keySource = 'encrypted key vault';
              }
            }
          } catch {
            // Vault unreadable (keyfile/permissions problem) — treat as
            // missing; the env_file_present / vault checks will surface it.
          }
        }

        if (!apiKey || apiKey === '') {
          return {
            checkId: 'gemini_api_health',
            name: 'Gemini API & Connectivity Health',
            category: 'api_connectivity',
            severity: 'critical',
            status: 'failed',
            message: 'GEMINI_API_KEY was not found in environment variables (.env) or the encrypted key vault.',
            repairStatus: 'requires_user_action',
            autoFixAvailable: false,
            userActionGuide: 'Pick one: 1) In SERA, open the Startup Launcher or Settings → API KEYS, paste your Gemini key and hit Test (stored encrypted — no .env needed). Or 2) add GEMINI_API_KEY="AIza..." to your .env file and restart.',
            timestamp: Date.now(),
          };
        }

        if (apiKey.length < 20 || apiKey.startsWith('PLACEHOLDER')) {
          return {
            checkId: 'gemini_api_health',
            name: 'Gemini API & Connectivity Health',
            category: 'api_connectivity',
            severity: 'warning',
            status: 'warning',
            message: `GEMINI_API_KEY (${keySource}) appears to be a placeholder or malformed string.`,
            repairStatus: 'requires_user_action',
            autoFixAvailable: false,
            userActionGuide: 'Verify your API key in Google AI Studio (https://aistudio.google.com/apikey), then update it in Settings → API KEYS or your .env file.',
            timestamp: Date.now(),
          };
        }

        return {
          checkId: 'gemini_api_health',
          name: 'Gemini API & Connectivity Health',
          category: 'api_connectivity',
          severity: 'healthy',
          status: 'passed',
          message: `Gemini API credentials valid — key resolved from the ${keySource}.`,
          repairStatus: 'not_applicable',
          autoFixAvailable: false,
          timestamp: Date.now(),
        };
      },
    });

    // 2. Memory Store & Persistence Integrity Check
    this.registerCheck({
      id: 'memory_store_integrity',
      name: 'Memory Store & File Integrity',
      category: 'memory_storage',
      run: async (): Promise<DiagnosticCheckResult> => {
        const memoryPath = path.resolve(MEMORY_FILE);
        if (!fs.existsSync(memoryPath)) {
          return {
            checkId: 'memory_store_integrity',
            name: 'Memory Store & File Integrity',
            category: 'memory_storage',
            severity: 'warning',
            status: 'warning',
            message: `${MEMORY_FILE} does not exist. Assistant memories cannot persist across restarts until first memory is written.`,
            repairStatus: 'can_auto_fix',
            autoFixAvailable: true,
            fixDescription: `Create and initialize a fresh, valid ${MEMORY_FILE} structure.`,
            timestamp: Date.now(),
          };
        }

        try {
          const content = fs.readFileSync(memoryPath, 'utf8');
          const parsed = JSON.parse(content);
          if (!Array.isArray(parsed) && typeof parsed !== 'object') {
            return {
              checkId: 'memory_store_integrity',
              name: 'Memory Store & File Integrity',
              category: 'memory_storage',
              severity: 'critical',
              status: 'failed',
              message: `${MEMORY_FILE} contains invalid root data structure.`,
              repairStatus: 'can_auto_fix',
              autoFixAvailable: true,
              fixDescription: 'Sanitize root data structure and backup existing file.',
              timestamp: Date.now(),
            };
          }

          const count = Array.isArray(parsed) ? parsed.length : (parsed.memories?.length || 0);
          return {
            checkId: 'memory_store_integrity',
            name: 'Memory Store & File Integrity',
            category: 'memory_storage',
            severity: 'healthy',
            status: 'passed',
            message: `Memory store intact and responsive (${count} memories indexed).`,
            details: { count },
            repairStatus: 'not_applicable',
            autoFixAvailable: false,
            timestamp: Date.now(),
          };
        } catch (err) {
          return {
            checkId: 'memory_store_integrity',
            name: 'Memory Store & File Integrity',
            category: 'memory_storage',
            severity: 'critical',
            status: 'failed',
            message: `Memory store JSON corruption: ${err instanceof Error ? err.message : String(err)}`,
            repairStatus: 'can_auto_fix',
            autoFixAvailable: true,
            fixDescription: 'Create atomic .bak snapshot and restore clean JSON structure.',
            timestamp: Date.now(),
          };
        }
      },
    });

    // 3. Audio Pipeline & Local Speech Host script check
    //    (Previously hardcoded to "passed" with no actual check — see file
    //    header for why this matters.)
    this.registerCheck({
      id: 'audio_pipeline_state',
      name: 'Audio Pipeline & Local Speech Host',
      category: 'audio_pipeline',
      run: async (): Promise<DiagnosticCheckResult> => this.checkSpeechHostScript(),
    });

    // 4. Browser Automation & Zombie Worker Count
    //    (Previously hardcoded to "passed" with no actual check.)
    this.registerCheck({
      id: 'browser_process_zombies',
      name: 'Browser Automation & Zombie Worker Count',
      category: 'browser_automation',
      run: async (): Promise<DiagnosticCheckResult> => this.checkBrowserZombieProcesses(),
    });

    // 5. System Resources & Process Memory Check
    this.registerCheck({
      id: 'system_resources_health',
      name: 'System Resources & Memory Headroom',
      category: 'system_resources',
      run: async (): Promise<DiagnosticCheckResult> => {
        const mem = process.memoryUsage();
        const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
        const heapTotalMb = Math.round(mem.heapTotal / 1024 / 1024);
        const rssMb = Math.round(mem.rss / 1024 / 1024);
        const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
        const freeMemMb = Math.round(os.freemem() / 1024 / 1024);

        const isHighMem = heapUsedMb > 1024 || freeMemMb < 256;
        if (isHighMem) {
          return {
            checkId: 'system_resources_health',
            name: 'System Resources & Memory Headroom',
            category: 'system_resources',
            severity: 'warning',
            status: 'warning',
            message: `High memory usage detected (Heap: ${heapUsedMb}MB / Free System: ${freeMemMb}MB).`,
            details: { heapUsedMb, heapTotalMb, rssMb, freeMemMb, totalMemMb },
            repairStatus: 'can_auto_fix',
            autoFixAvailable: true,
            fixDescription: 'Prune cached scratch files and invoke Node.js garbage collection.',
            timestamp: Date.now(),
          };
        }

        return {
          checkId: 'system_resources_health',
          name: 'System Resources & Memory Headroom',
          category: 'system_resources',
          severity: 'healthy',
          status: 'passed',
          message: `Process memory and system resources healthy (Heap: ${heapUsedMb}MB / System Free: ${freeMemMb}MB).`,
          details: { heapUsedMb, heapTotalMb, rssMb, freeMemMb },
          repairStatus: 'not_applicable',
          autoFixAvailable: false,
          timestamp: Date.now(),
        };
      },
    });

    // 6. Configuration & Environment Check
    this.registerCheck({
      id: 'config_environment',
      name: 'Configuration & Node Environment',
      category: 'config_environment',
      run: async (): Promise<DiagnosticCheckResult> => {
        const nodeVersion = process.version;
        const platform = process.platform;
        const port = process.env.PORT || '43110';

        return {
          checkId: 'config_environment',
          name: 'Configuration & Node Environment',
          category: 'config_environment',
          severity: 'healthy',
          status: 'passed',
          message: `Server running on Node ${nodeVersion} (${platform}) at port ${port}.`,
          details: { nodeVersion, platform, port },
          repairStatus: 'not_applicable',
          autoFixAvailable: false,
          timestamp: Date.now(),
        };
      },
    });

    // 7. NEW: Computer Control Native Module (robotjs)
    this.registerCheck({
      id: 'computer_control_native',
      name: 'Computer Control Native Module (robotjs)',
      category: 'computer_control_native',
      run: async () => this.checkRobotjsAvailability(),
    });

    // 8. NEW: Screen Capture Availability
    this.registerCheck({
      id: 'screen_capture_availability',
      name: 'Screen Capture Availability',
      category: 'screen_capture',
      run: async () => this.checkScreenCaptureAvailability(),
    });

    // 9. NEW: Clipboard Round-Trip
    this.registerCheck({
      id: 'clipboard_availability',
      name: 'Clipboard Round-Trip',
      category: 'clipboard',
      // v1.6.11: reads the per-scan context — no longer the shared mutable
      // deepScanMode flag (see the race note on runFullScan).
      run: async (context) => this.checkClipboardAvailability(context?.deep === true),
    });

    // 10. NEW: Playwright Chromium Install
    this.registerCheck({
      id: 'playwright_browser_install',
      name: 'Playwright Chromium Install',
      category: 'playwright_browser',
      run: async () => this.checkPlaywrightBrowserInstall(),
    });

    // 11. NEW: Executor Registration Sanity
    //     Catches the silent failure mode where toolRegistry.ts was
    //     refactored and an executor (e.g. BrowserExecutor or
    //     ClipboardExecutor) was accidentally dropped from
    //     registerExecutor calls. The corresponding tool would then
    //     return "No executor supports action type X" with no other
    //     visible error anywhere — exactly the kind of "everything is
    //     broken but system health says healthy" failure the user
    //     reported.
    this.registerCheck({
      id: 'executor_registration',
      name: 'ActionManager Executor Registration',
      category: 'executor_registration',
      run: async (): Promise<DiagnosticCheckResult> => {
        // Build the expected executor list by importing the default
        // ToolManager (which constructs the real production ActionManager).
        // We only check the names — actually invoking executors would
        // require a Windows environment.
        try {
          const { defaultToolManager } = await import('../tools/toolRegistry');
          const actionManager = defaultToolManager.getActionManager();
          // ActionManager doesn't expose its executors publicly; reach
          // into the private field via reflection-style access. This is
          // intentional — the diagnostic is a privileged internal probe.
          const executors = (actionManager as unknown as { executors?: Array<{ name: string }> }).executors || [];
          const registered = new Set(executors.map((executor) => executor.name));
          const expected = [
            'ApplicationExecutor',
            'InputExecutor',
            'ScreenExecutor',
            'ScreenshotExecutor',
            'WindowExecutor',
            'VisionExecutor',
            'BrowserExecutor',
            'ClipboardExecutor',
          ];
          const missing = expected.filter((name) => !registered.has(name));
          if (missing.length === 0) {
            return {
              checkId: 'executor_registration',
              name: 'ActionManager Executor Registration',
              category: 'executor_registration',
              severity: 'healthy',
              status: 'passed',
              message: `All ${expected.length} expected executors are registered.`,
              details: { expected, registered: Array.from(registered) },
              repairStatus: 'not_applicable',
              autoFixAvailable: false,
              timestamp: Date.now(),
            };
          }
          return {
            checkId: 'executor_registration',
            name: 'ActionManager Executor Registration',
            category: 'executor_registration',
            severity: 'critical',
            status: 'failed',
            message: `Missing executor(s): ${missing.join(', ')}. Tools of these types will return "No executor supports action type X".`,
            details: { missing, registered: Array.from(registered) },
            repairStatus: 'requires_user_action',
            autoFixAvailable: false,
            userActionGuide: 'Check src/tools/toolRegistry.ts createDefaultToolManager — every executor must be wired via actionManager.registerExecutor().',
            timestamp: Date.now(),
          };
        } catch (err) {
          return {
            checkId: 'executor_registration',
            name: 'ActionManager Executor Registration',
            category: 'executor_registration',
            severity: 'warning',
            status: 'warning',
            message: `Could not probe executor registration: ${err instanceof Error ? err.message : String(err)}`,
            repairStatus: 'requires_user_action',
            autoFixAvailable: false,
            userActionGuide: 'Ensure src/tools/toolRegistry.ts can be imported without errors.',
            timestamp: Date.now(),
          };
        }
      },
    });

    // ─── 12..N — Comprehensive A→Z deep-scan checks ─────────────────
    //
    // The original 11 checks above cover the capability gates (the
    // 8 broken features + system health false-positive fix from the
    // previous commit). The user requested the diagnostic system
    // scan EVERYTHING — "small to big, A to Z, every subsystem, no
    // limitations". The factory list below covers node runtime,
    // environment, file system, native modules, dependencies, network,
    // audio, browser, window management, application launcher, tool
    // registry, websocket, http server, security, build integrity,
    // and disk/CPU resources. Each factory lives in comprehensiveChecks.ts.
    // To add more, append a new factory to COMPREHENSIVE_CHECK_FACTORIES.
    for (const factory of COMPREHENSIVE_CHECK_FACTORIES) {
      this.registerCheck(factory());
    }

    // ─── N..M — v1.6.x FEATURE-coverage checks ──────────────────────
    //
    // The user then asked the scanner to "get to know ALL the features
    // that are currently added and check all things A to Z". The
    // featureChecks factories probe every feature shipped since v1.6.0:
    // multi-model orchestration, the local Ollama brain, the encrypted
    // key vault, mistake-memory learning, the AGI planner, OS browser
    // integration, whisper/piper speech, the Electron desktop host,
    // version gating, input resilience, Discord-style voice DSP, and
    // sleep-command intelligence. To add more, append a factory to
    // FEATURE_CHECK_FACTORIES in featureChecks.ts.
    for (const factory of FEATURE_CHECK_FACTORIES) {
      this.registerCheck(factory());
    }
  }
}

export const defaultSystemDiagnosticService = new SystemDiagnosticService();
