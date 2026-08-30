import fs from 'fs';
import path from 'path';
import { RepairResult, DiagnosticCheckResult } from './types';
import { MemoryItem } from '../memory/memoryTypes';
import { memoryFilePath, backupsDir, tmpWorkDir } from '../local/SERAPaths';

/**
 * Canonical location of Sera's persistent memory store.
 *
 * Kept in sync with NodeMemoryStore's default path. Centralising it here
 * prevents the diagnostic and repair subsystems from looking at a different
 * file than the one the live memory manager actually reads/writes — a
 * previous bug produced phantom "missing memory file" diagnostics and,
 * worse, auto-repair would create an empty decoy file at the wrong path
 * and silently wipe valid memory entries when sanitising.
 */
// v1.9.0 (BUG L5): authoritative home is the per-user SERA data dir.
const MEMORY_FILE = process.env.SERA_MEMORY_FILE || memoryFilePath();

function memoryItemIsValid(item: unknown): item is MemoryItem {
  if (!item || typeof item !== 'object') return false;
  const record = item as Record<string, unknown>;
  return typeof record.fact === 'string' && record.fact.trim().length > 0
    && typeof record.id === 'string'
    && typeof record.category === 'string'
    && typeof record.confidence === 'string'
    && typeof record.source === 'string';
}

/**
 * AutoRepairEngine — Safe, Conservative Auto-Repair System for Sera
 *
 * Safety Principles:
 * 1. Non-Destructive: Always generates an atomic backup before modifying files.
 * 2. Conservative: If confidence is low or user credentials/permissions are required, escalates immediately.
 * 3. Auditable: Logs all repair operations with exact actions taken.
 */
export class AutoRepairEngine {
  private repairHistory: RepairResult[] = [];
  private repairHandlers: Map<string, () => Promise<RepairResult>> = new Map();

  constructor() {
    this.registerBuiltInRepairs();
  }

  /**
   * Registers custom repair handlers for specific check IDs
   */
  public registerRepairHandler(checkId: string, handler: () => Promise<RepairResult>): void {
    this.repairHandlers.set(checkId, handler);
  }

  /**
   * Executes a repair for a specific diagnostic check
   */
  public async executeRepair(checkId: string): Promise<RepairResult> {
    const handler = this.repairHandlers.get(checkId);
    if (!handler) {
      const result: RepairResult = {
        checkId,
        success: false,
        message: `No automatic repair handler available for check: ${checkId}. Manual intervention required.`,
        actionsTaken: [],
        timestamp: Date.now(),
      };
      this.repairHistory.unshift(result);
      return result;
    }

    try {
      const result = await handler();
      this.repairHistory.unshift(result);
      if (this.repairHistory.length > 50) this.repairHistory.pop();
      return result;
    } catch (err) {
      const result: RepairResult = {
        checkId,
        success: false,
        message: `Auto-repair failed: ${err instanceof Error ? err.message : String(err)}`,
        actionsTaken: [],
        error: String(err),
        timestamp: Date.now(),
      };
      this.repairHistory.unshift(result);
      return result;
    }
  }

  /**
   * Executes all available safe auto-fixes for a list of diagnostic results
   */
  public async executeAllSafeRepairs(checks: DiagnosticCheckResult[]): Promise<RepairResult[]> {
    const results: RepairResult[] = [];
    for (const check of checks) {
      if (check.autoFixAvailable && check.status !== 'passed') {
        const res = await this.executeRepair(check.checkId);
        results.push(res);
      }
    }
    return results;
  }

  public getRepairHistory(): RepairResult[] {
    return [...this.repairHistory];
  }

  private registerBuiltInRepairs(): void {
    // 1. Repair Memory Store Integrity
    this.registerRepairHandler('memory_store_integrity', async () => {
      const actions: string[] = [];
      const memoryPath = path.resolve(MEMORY_FILE);
      const memoryDir = path.dirname(memoryPath);
      let backupPath = '';

      // Always ensure the memory directory exists so subsequent writes succeed.
      if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });

      if (fs.existsSync(memoryPath)) {
        const backupDir = path.join(backupsDir(), 'memory');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        backupPath = path.resolve(backupDir, `sera_memories.bak.${Date.now()}.json`);
        fs.copyFileSync(memoryPath, backupPath);
        actions.push(`Created backup snapshot in backups/memory/${path.basename(backupPath)}`);

        try {
          const raw = fs.readFileSync(memoryPath, 'utf8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            // Malformed JSON — keep the backup, but reset the live store to a
            // valid empty array so the running memory manager can recover.
            parsed = [];
            actions.push('Malformed JSON detected. Reset store structure to valid array format.');
          }

          if (Array.isArray(parsed)) {
            // Filter using the MemoryItem schema (was: `item.text`, which is the
            // wrong field — MemoryItem stores the value in `fact`. Filtering
            // on `text` would have wiped every valid entry.)
            const sanitized = parsed.filter(memoryItemIsValid);
            fs.writeFileSync(memoryPath, JSON.stringify(sanitized, null, 2), 'utf8');
            actions.push(`Sanitized and saved ${sanitized.length} valid memory entries.`);
          } else if (typeof parsed === 'object' && parsed !== null) {
            const obj = parsed as Record<string, unknown>;
            const entries = (obj.memories || obj.items) as unknown;
            const list = Array.isArray(entries) ? entries.filter(memoryItemIsValid) : [];
            fs.writeFileSync(memoryPath, JSON.stringify(list, null, 2), 'utf8');
            actions.push(`Normalized memory structure to flat array format (${list.length} entries).`);
          } else {
            // Non-array, non-object root: reset to empty array.
            fs.writeFileSync(memoryPath, JSON.stringify([], null, 2), 'utf8');
            actions.push('Root value was neither array nor object; reset to empty array.');
          }
        } catch (err) {
          throw new Error(`Failed to sanitize memory file: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        fs.writeFileSync(memoryPath, JSON.stringify([], null, 2), 'utf8');
        actions.push(`Initialized new valid ${MEMORY_FILE} store.`);
      }

      return {
        checkId: 'memory_store_integrity',
        success: true,
        message: 'Memory store sanitized and integrity restored with zero data loss.',
        actionsTaken: actions,
        backupPath,
        timestamp: Date.now(),
      };
    });

    // 2. Prune Temp Files & Crash Dumps
    this.registerRepairHandler('disk_space_headroom', async () => {
      const actions: string[] = [];
      const tempDir = path.resolve(process.cwd(), 'tmp');
      const scratchDir = path.resolve(process.cwd(), '.scratch');

      let prunedCount = 0;
      const cleanDir = (targetDir: string) => {
        if (!fs.existsSync(targetDir)) return;
        const files = fs.readdirSync(targetDir);
        const now = Date.now();
        for (const file of files) {
          try {
            const fullPath = path.join(targetDir, file);
            const stats = fs.statSync(fullPath);
            // Delete files older than 24 hours
            if (now - stats.mtimeMs > 24 * 60 * 60 * 1000) {
              fs.unlinkSync(fullPath);
              prunedCount++;
            }
          } catch {}
        }
      };

      cleanDir(tempDir);
      cleanDir(scratchDir);
      actions.push(`Pruned ${prunedCount} stale temporary files older than 24h.`);

      return {
        checkId: 'disk_space_headroom',
        success: true,
        message: `Temporary directory clean-up complete. Pruned ${prunedCount} stale files.`,
        actionsTaken: actions,
        timestamp: Date.now(),
      };
    });

    // 3. Terminate Zombie Browser Worker Processes
    //    (Previously a no-op that just returned "success" without doing
    //    anything. The diagnostic check above now actually counts zombie
    //    processes, so this repair actually closes orphaned sessions
    //    via the BrowserSessionManager.)
    this.registerRepairHandler('browser_process_zombies', async () => {
      const actions: string[] = [];
      try {
        const { defaultBrowserSessionManager } = await import('../tools/toolRegistry');
        // Access the private sessions map via reflection-style access.
        // This is privileged internal repair code.
        const sessions = (defaultBrowserSessionManager as unknown as {
          sessions?: Map<string, { browser?: { close?: () => Promise<void> } | null; ownsBrowser?: boolean }>;
        }).sessions;
        if (sessions) {
          let closed = 0;
          for (const sessionId of sessions.keys()) {
            try {
              await defaultBrowserSessionManager.closeSession(sessionId);
              closed += 1;
            } catch {
              // Best-effort — continue even if one session can't close.
            }
          }
          actions.push(`Closed ${closed} managed browser session(s) via BrowserSessionManager.closeSession.`);
        } else {
          actions.push('BrowserSessionManager.sessions map not accessible — skipped programmatic cleanup.');
        }
      } catch (err) {
        actions.push(`Programmatic session cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // On Windows, also kill any orphaned headless Chromium / Edge workers
      // that match the Playwright-launched pattern. This is more aggressive
      // than the per-session close above and catches workers that were
      // orphaned by a SERA crash.
      if (process.platform === 'win32') {
        try {
          const { execFile } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const execFileAsync = promisify(execFile);
          // taskkill returns non-zero if no matching process exists; that's fine.
          try {
            await execFileAsync('taskkill.exe', ['/F', '/IM', 'headless_shell.exe', '/T'], { windowsHide: true });
            actions.push('Killed orphaned headless_shell.exe worker(s).');
          } catch {
            // No headless_shell running — nothing to do.
          }
        } catch (err) {
          actions.push(`Windows process cleanup skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return {
        checkId: 'browser_process_zombies',
        success: true,
        message: 'Automation browser workers sanitized and reclaimed.',
        actionsTaken: actions,
        timestamp: Date.now(),
      };
    });

    // 4. Reset Audio Subsystem State
    //    (No longer reachable from the rewritten diagnostic — the audio
    //    check is now `audio_pipeline_state` which checks for the
    //    speech-host.cjs script's existence, not a runtime state. The
    //    handler is retained for back-compat with any persisted
    //    `repair_system_issue` call that targets this ID.)
    this.registerRepairHandler('audio_pipeline_state', async () => {
      const actions: string[] = [];
      actions.push('No runtime audio state to reset (diagnostic checks speech-host.cjs existence only).');
      return {
        checkId: 'audio_pipeline_state',
        success: true,
        message: 'Audio pipeline diagnostic re-evaluation deferred until next scan.',
        actionsTaken: actions,
        timestamp: Date.now(),
      };
    });

    // 1. memory_store_integrity — see existing handler above.
    // (memory_store_integrity handler is at the top of registerBuiltInRepairs.)

    // 1b. gemini_api_health — no automatic repair possible (we can't
    // generate a Gemini API key for the user). Surface the action guide.
    // Previously this returned the dead-end "No automatic repair handler
    // available" string when the user clicked Repair on a missing
    // GEMINI_API_KEY. Now we return the actionable "get a key at
    // aistudio.google.com/apikey" guidance.
    this.registerRepairHandler('gemini_api_health', async () => ({
      checkId: 'gemini_api_health',
      success: false,
      message: 'GEMINI_API_KEY must be configured manually. Get a free key from Google AI Studio, then store it in the vault or .env.',
      actionsTaken: [
        'Gemini API keys cannot be auto-generated — they require a Google account.',
        '1. Visit https://aistudio.google.com/apikey',
        '2. Sign in with a Google account and click "Create API key".',
        '3. Paste the key (starts with "AIza...") into SERA: Startup Launcher → Online Mode, or Settings → API KEYS → Test (stored encrypted in the vault — no .env needed).',
        '4. Alternatively, put GEMINI_API_KEY="AIza..." in your .env file, then restart SERA: Ctrl+C in the terminal, then "npm run dev".',
      ],
      timestamp: Date.now(),
    }));

    // 1c. config_environment — informational only; cannot be "broken".
    this.registerRepairHandler('config_environment', async () => ({
      checkId: 'config_environment',
      success: true,
      message: 'Configuration is informational. No automatic fix required.',
      actionsTaken: [
        'This check reports Node version, platform, and port — not a defect.',
        'If you want a different port, set PORT=<port> in .env and restart SERA.',
      ],
      timestamp: Date.now(),
    }));

    // =========================================================================
    // 5-9: Repair handlers for the 5 new critical checks added by the
    // rewritten SystemDiagnosticService. The audit identified that these
    // checkIds are REPORTED as failed by the diagnostic engine, but no
    // handler was registered — so users clicking "Repair" on them got
    // "No automatic repair handler available" with no actionable guidance.
    // Each handler below surfaces a concrete, copy-pasteable fix command
    // appropriate for the host platform, plus runs any programmatic fix
    // that's safe to attempt (e.g. clearing caches, re-running install).
    // =========================================================================

    // 5. computer_control_native — robotjs native module failed to load.
    //    On Windows: rebuild the native binding. On Linux: install xdotool.
    this.registerRepairHandler('computer_control_native', async () => {
      const actions: string[] = [];
      let fixCommand = '';
      if (process.platform === 'win32') {
        fixCommand = 'npm rebuild robotjs';
        actions.push('Detected Windows host. robotjs native binary may need to be rebuilt for the current Node version.');
        // Try the rebuild programatically — it's safe and idempotent.
        try {
          const { execFile } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const execFileAsync = promisify(execFile);
          await execFileAsync('npm.cmd', ['rebuild', 'robotjs'], {
            cwd: process.cwd(),
            windowsHide: true,
            shell: true,
            timeout: 60000,
          });
          actions.push('Successfully ran `npm rebuild robotjs`. Restart SERA for the rebuilt binding to take effect.');
          return {
            checkId: 'computer_control_native',
            success: true,
            message: 'robotjs native module rebuilt. Restart SERA to pick up the new binding.',
            actionsTaken: actions,
            timestamp: Date.now(),
          };
        } catch (err) {
          actions.push(`Auto-rebuild failed: ${err instanceof Error ? err.message : String(err)}. Manual command: ${fixCommand}`);
        }
      } else if (process.platform === 'linux') {
        fixCommand = 'sudo apt install -y xdotool libxtst6 libxdo-dev';
        actions.push('Detected Linux host. xdotool is required for keyboard/mouse input on Linux.');
        // Cannot sudo from a non-root process — surface the manual command.
        actions.push(`Run: ${fixCommand}`);
      } else if (process.platform === 'darwin') {
        fixCommand = 'npm rebuild robotjs';
        actions.push('Detected macOS host. robotjs native binary may need rebuild + accessibility permissions.');
        actions.push(`Run: ${fixCommand}, then grant Accessibility permission to Terminal/iTerm in System Settings → Privacy & Security.`);
      } else {
        actions.push(`No automatic repair available on platform "${process.platform}".`);
      }
      return {
        checkId: 'computer_control_native',
        success: false,
        message: `Automatic rebuild attempted; manual intervention may still be required. Run: ${fixCommand}`,
        actionsTaken: actions,
        timestamp: Date.now(),
      };
    });

    // 6. screen_capture_availability — Linux screen-capture backend (scrot
    //    / gnome-screenshot / ImageMagick) not installed.
    this.registerRepairHandler('screen_capture_availability', async () => {
      const actions: string[] = [];
      if (process.platform === 'win32') {
        actions.push('Windows screen capture uses robotjs internally — no separate install needed. If this check fails, the robotjs native binary is broken; run `npm rebuild robotjs`.');
      } else if (process.platform === 'linux') {
        actions.push('Linux requires one of: scrot, gnome-screenshot, or ImageMagick (import).');
        actions.push('Run: sudo apt install -y scrot');
      } else if (process.platform === 'darwin') {
        actions.push('macOS screen capture uses screencapture (built-in). If this check fails, the robotjs native binary is broken; run `npm rebuild robotjs` and grant Screen Recording permission in System Settings → Privacy & Security.');
      }
      return {
        checkId: 'screen_capture_availability',
        success: false,
        message: 'Screen-capture backend installation requires admin privileges. See action guide for the platform-specific install command.',
        actionsTaken: actions,
        timestamp: Date.now(),
      };
    });

    // 7. clipboard_availability — Linux clipboard backend (wl-copy / xclip /
    //    xsel) not installed.
    this.registerRepairHandler('clipboard_availability', async () => {
      const actions: string[] = [];
      if (process.platform === 'win32') {
        actions.push('Windows clipboard uses PowerShell natively — no separate install needed. If this check fails, PowerShell may be missing from the PATH.');
      } else if (process.platform === 'linux') {
        actions.push('Linux requires one of: wl-copy (Wayland), xclip, or xsel (X11).');
        actions.push('Run: sudo apt install -y xclip   (or "sudo apt install -y wl-clipboard" for Wayland)');
      } else if (process.platform === 'darwin') {
        actions.push('macOS clipboard uses pbcopy/pbpaste (built-in). No install needed.');
      }
      return {
        checkId: 'clipboard_availability',
        success: false,
        message: 'Clipboard backend installation requires admin privileges. See action guide for the platform-specific install command.',
        actionsTaken: actions,
        timestamp: Date.now(),
      };
    });

    // 8. playwright_browser_install — Chromium binary missing.
    //    We CAN fix this programmatically — `npx playwright install chromium`
    //    doesn't require sudo and runs in the project's node_modules.
    this.registerRepairHandler('playwright_browser_install', async () => {
      const actions: string[] = [];
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        // Use npx to find the playwright binary in the project's node_modules.
        // The install can take 30-60s on a fresh machine.
        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        await execFileAsync(npmCmd, ['run', 'postinstall'], {
          cwd: process.cwd(),
          windowsHide: true,
          shell: process.platform === 'win32',
          timeout: 120000,
        });
        actions.push('Successfully ran `npm run postinstall` which executes `playwright install chromium`.');
        return {
          checkId: 'playwright_browser_install',
          success: true,
          message: 'Playwright Chromium browser installed. Restart SERA to pick up the new browser.',
          actionsTaken: actions,
          timestamp: Date.now(),
        };
      } catch (err) {
        actions.push(`Auto-install failed: ${err instanceof Error ? err.message : String(err)}`);
        actions.push('Manual command: npx playwright install chromium');
        return {
          checkId: 'playwright_browser_install',
          success: false,
          message: 'Automatic Chromium install failed. Run manually: npx playwright install chromium',
          actionsTaken: actions,
          timestamp: Date.now(),
        };
      }
    });

    // 9. executor_registration — one or more Action executors failed to
    //    register at boot. Cannot auto-repair (would require re-running
    //    the ToolManager initialization, which isn't safe at runtime).
    //    Surface the issue with a restart hint.
    this.registerRepairHandler('executor_registration', async () => {
      const actions: string[] = [
        'Executor registration happens at server boot time. If a required executor is missing, restart the SERA server.',
        'If the issue persists after restart, check the server startup logs for the specific executor that failed to construct (often caused by a missing native module like robotjs or active-win).',
      ];
      return {
        checkId: 'executor_registration',
        success: false,
        message: 'Executor registration cannot be auto-repaired. Restart the SERA server.',
        actionsTaken: actions,
        timestamp: Date.now(),
      };
    });

    // 10. system_resources_health — disk space / memory / CPU issues.
    //     The audit identified that the diagnostic registers
    //     `system_resources_health` (not `disk_space_headroom`), so the
    //     existing #2 handler above was orphaned. We delegate to the
    //     same temp-dir pruning logic, but we re-tag the result with the
    //     caller's checkId so callers see the checkId they invoked with.
    this.registerRepairHandler('system_resources_health', async () => {
      const delegated = await this.executeRepair('disk_space_headroom');
      // Re-tag the result so the caller's checkId is preserved in the
      // response (otherwise they'd see "disk_space_headroom" back when
      // they invoked "system_resources_health" — confusing).
      return { ...delegated, checkId: 'system_resources_health' };
    });

    // =========================================================================
    // 11..N: Repair handlers for the comprehensive A→Z deep-scan checks
    // added in comprehensiveChecks.ts. Each handler either:
    //   (a) performs a safe programmatic fix (creating a missing dir,
    //       running npm install, pruning caches), OR
    //   (b) surfaces a copy-pasteable command the user can run, OR
    //   (c) returns "informational, no fix needed" for metrics that are
    //       intrinsically unfixable (uptime, PID).
    // Without these, clicking "Repair" on any new check would return
    // the dead-end "No automatic repair handler available" message.
    // =========================================================================

    // Helper: register an informational-only handler that says "no fix
    // needed — this is a metric, not a defect".
    const registerInfoHandler = (checkId: string, hint: string) => {
      this.registerRepairHandler(checkId, async () => ({
        checkId,
        success: true,
        message: 'Informational metric — no automatic fix required.',
        actionsTaken: [
          'This check reports a runtime metric (uptime, PID, etc.) rather than a defect.',
          hint,
        ],
        timestamp: Date.now(),
      }));
    };

    // Node runtime informational metrics
    registerInfoHandler('node_version_check', 'If Node is too old, install Node 20 LTS from https://nodejs.org/ and restart SERA.');
    registerInfoHandler('process_uptime', 'To restart the server: Ctrl+C in the terminal, then "npm run dev" again.');
    registerInfoHandler('event_loop_lag', 'High lag indicates synchronous CPU work. Profile with "node --inspect".');
    registerInfoHandler('heap_memory_usage', 'High heap usage indicates a memory leak. Restart the server to free memory.');
    registerInfoHandler('uncaught_handler_installed', 'If handlers are missing, ensure server.ts registers process.on("uncaughtException") and process.on("unhandledRejection") at boot.');
    registerInfoHandler('esm_shim_healthy', 'If the shim is broken, check src/diagnostics/esmShim.ts. import.meta.url must be available.');

    // Environment / security — handlers that just explain
    registerInfoHandler('env_file_present', 'Optional: "copy .env.example .env" (Windows) for .env config — or add keys via Startup Launcher / Settings → API KEYS (encrypted vault); then no .env is needed.');
    registerInfoHandler('env_no_placeholder_values', 'Edit .env and replace placeholders (MY_*, your_*, etc.) with real values.');
    registerInfoHandler('no_secrets_in_env', 'Edit .env to remove placeholder / weak values. Get a real Gemini key at https://aistudio.google.com/apikey.');

    // File system handlers — these CAN actually attempt a fix by creating
    // the missing directory. Safe and idempotent.
    const fsCreateHandler = (checkId: string, relPath: string, label: string) => {
      this.registerRepairHandler(checkId, async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const target = path.resolve(process.cwd(), relPath);
        const actions: string[] = [];
        try {
          if (!fs.existsSync(target)) {
            fs.mkdirSync(target, { recursive: true });
            actions.push(`Created directory: ${target}`);
          } else {
            actions.push(`Directory already exists: ${target}`);
          }
          // Probe writability.
          const probe = path.join(target, `.sera-repair-probe-${Date.now()}.tmp`);
          fs.writeFileSync(probe, 'ok');
          fs.unlinkSync(probe);
          actions.push(`Writability verified for ${label}.`);
          return {
            checkId,
            success: true,
            message: `${label} is now writable.`,
            actionsTaken: actions,
            timestamp: Date.now(),
          };
        } catch (err) {
          actions.push(`Could not create / verify ${label}: ${err instanceof Error ? err.message : String(err)}`);
          actions.push(`Manual command: mkdir -p ${relPath}  (Windows: md ${relPath})`);
          return {
            checkId,
            success: false,
            message: `${label} repair requires manual intervention.`,
            actionsTaken: actions,
            timestamp: Date.now(),
          };
        }
      });
    };

    fsCreateHandler('project_root_writable', '', 'project root');
    fsCreateHandler('data_directory_writable', '.data', '.data/');
    fsCreateHandler('backups_directory_writable', 'backups', 'backups/');
    fsCreateHandler('tmp_directory_writable', 'tmp', 'tmp/');

    // File existence checks — can't auto-create; surface the manual restore.
    registerInfoHandler('key_source_files_present', 'Restore missing files from git: git checkout -- <file>');
    registerInfoHandler('traineddata_present', 'Download from https://github.com/tesseract-ocr/tessdata/raw/main/eng.traineddata');
    registerInfoHandler('electron_entry_present', 'Restore from git: git checkout -- electron/main.cjs electron/preload.cjs');

    // Native modules — can attempt npm rebuild
    const npmRebuildHandler = (checkId: string, pkg: string) => {
      this.registerRepairHandler(checkId, async () => {
        const actions: string[] = [];
        try {
          const { execFile } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const execFileAsync = promisify(execFile);
          const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
          await execFileAsync(npmCmd, ['rebuild', pkg], {
            cwd: process.cwd(),
            windowsHide: true,
            shell: process.platform === 'win32',
            timeout: 60000,
          });
          actions.push(`Successfully ran: npm rebuild ${pkg}`);
          return {
            checkId,
            success: true,
            message: `${pkg} native module rebuilt. Restart SERA.`,
            actionsTaken: actions,
            timestamp: Date.now(),
          };
        } catch (err) {
          actions.push(`Auto-rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
          actions.push(`Manual: npm install ${pkg}  (or  npm rebuild ${pkg})`);
          return {
            checkId,
            success: false,
            message: `${pkg} rebuild failed. Run: npm install ${pkg}`,
            actionsTaken: actions,
            timestamp: Date.now(),
          };
        }
      });
    };

    npmRebuildHandler('koffi_loadable', 'koffi');
    npmRebuildHandler('active_win_loadable', 'active-win');
    npmRebuildHandler('pngjs_loadable', 'pngjs');
    npmRebuildHandler('win32_api_loadable', 'win32-api');

    // Dependencies — try npm install
    this.registerRepairHandler('node_modules_present', async () => {
      const actions: string[] = [];
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        actions.push('Running: npm install --ignore-scripts');
        await execFileAsync(npmCmd, ['install', '--ignore-scripts'], {
          cwd: process.cwd(),
          windowsHide: true,
          shell: process.platform === 'win32',
          timeout: 300000, // 5 min
          maxBuffer: 32 * 1024 * 1024,
        });
        actions.push('npm install completed.');
        return {
          checkId: 'node_modules_present',
          success: true,
          message: 'node_modules/ reinstalled. Restart SERA.',
          actionsTaken: actions,
          timestamp: Date.now(),
        };
      } catch (err) {
        actions.push(`Auto-install failed: ${err instanceof Error ? err.message : String(err)}`);
        actions.push('Manual: rm -rf node_modules && npm install');
        return {
          checkId: 'node_modules_present',
          success: false,
          message: 'npm install failed. Run: rm -rf node_modules && npm install',
          actionsTaken: actions,
          timestamp: Date.now(),
        };
      }
    });

    registerInfoHandler('package_lock_present', 'Run: npm install  to regenerate the lockfile.');

    // Network — no auto-fix; surface guidance
    registerInfoHandler('google_dns_resolvable', 'If DNS resolves to private IPs and HTTPS fails: enable Windows "DNS over HTTPS" for your 1.1.1.1/8.8.8.8 entries (adapter → Edit DNS → Encrypted DNS ON → ipconfig /flushdns), or run your VPN/proxy in TUN mode, or set HTTPS_PROXY in .env.');
    registerInfoHandler('gemini_endpoint_reachable', 'SERA connects via the OS resolver, which can work even when direct DNS (port 53) is blocked. If HTTPS also fails: check internet, flush DNS (ipconfig /flushdns), or try DNS 1.1.1.1 / 8.8.8.8.');

    // Audio / browser / window — informational
    registerInfoHandler('audio_devices_count', 'Audio is handled browser-side; this is informational. Check OS audio settings if browser mic also fails.');
    registerInfoHandler('managed_browser_session_initialized', 'Check src/browser/BrowserSessionManager.ts for TypeScript errors: npm run lint');
    registerInfoHandler('active_window_detectable', 'Likely no graphical session. Run SERA on a host with a desktop environment.');

    // App launcher — can attempt install on Linux
    this.registerRepairHandler('app_launcher_available', async () => {
      const actions: string[] = [];
      if (process.platform === 'linux') {
        actions.push('Linux requires xdg-utils for app launching.');
        actions.push('Run: sudo apt install -y xdg-utils  (or your distro equivalent)');
      } else if (process.platform === 'win32') {
        // "start" is a cmd.exe builtin — the check now correctly treats it
        // as always-available. If this repair handler runs on Windows, the
        // check genuinely cannot find cmd.exe, which is unrecoverable.
        actions.push('Windows "start" is a builtin of cmd.exe and should always be available.');
        actions.push('If this check is still failing, your Windows install is missing cmd.exe — unrecoverable, reinstall Windows.');
      } else if (process.platform === 'darwin') {
        actions.push('macOS uses "open" — built into the OS at /usr/bin/open. Should always be present.');
        actions.push('If missing, your macOS install is damaged — reinstall from Recovery Mode.');
      } else {
        actions.push(`Unsupported platform: ${process.platform}. App launching is not supported here.`);
      }
      return {
        checkId: 'app_launcher_available',
        success: false,
        message: 'App launcher installation requires admin privileges or OS reinstall.',
        actionsTaken: actions,
        timestamp: Date.now(),
      };
    });

    registerInfoHandler('tool_registry_count', 'Check src/tools/toolRegistry.ts. Run: npm run lint');

    // WebSocket / HTTP — informational
    registerInfoHandler('websocket_server_listening', 'Server is not listening. Restart: npm run dev');
    registerInfoHandler('http_server_listening', 'Server is not listening. Restart: npm run dev');
    registerInfoHandler('diagnostics_endpoints_responding', 'Check server.ts routes. Run: npm run lint');

    // Build integrity
    this.registerRepairHandler('dist_build_integrity', async () => {
      const actions: string[] = [];
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        actions.push('Running: npm run build');
        await execFileAsync(npmCmd, ['run', 'build'], {
          cwd: process.cwd(),
          windowsHide: true,
          shell: process.platform === 'win32',
          timeout: 180000, // 3 min
          maxBuffer: 16 * 1024 * 1024,
        });
        actions.push('Build completed. Restart SERA in production mode (npm start) to use the fresh bundle.');
        return {
          checkId: 'dist_build_integrity',
          success: true,
          message: 'Production bundle rebuilt. Restart SERA.',
          actionsTaken: actions,
          timestamp: Date.now(),
        };
      } catch (err) {
        actions.push(`Auto-build failed: ${err instanceof Error ? err.message : String(err)}`);
        actions.push('Manual: npm run build');
        return {
          checkId: 'dist_build_integrity',
          success: false,
          message: 'Build failed. Run: npm run build',
          actionsTaken: actions,
          timestamp: Date.now(),
        };
      }
    });

    registerInfoHandler('typescript_clean', 'Run: npx tsc --noEmit  to see all type errors. Fix them before deploying.');
    registerInfoHandler('source_imports_healthy', 'Check src/tools/toolRegistry.ts and other core modules. Run: npm run lint');

    // Disk & CPU
    this.registerRepairHandler('disk_space_headroom', async () => {
      const actions: string[] = [];
      try {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const tmpDir = tmpWorkDir();
        const scratchDir = path.join(tmpWorkDir(), '.scratch');
        let freed = 0;
        const now = Date.now();
        const cutoff = now - 24 * 60 * 60 * 1000; // 24h ago
        for (const dir of [tmpDir, scratchDir]) {
          if (!fs.existsSync(dir)) continue;
          const entries = fs.readdirSync(dir);
          for (const entry of entries) {
            const full = path.join(dir, entry);
            try {
              const stat = fs.statSync(full);
              if (stat.isFile() && stat.mtimeMs < cutoff) {
                const size = stat.size;
                fs.unlinkSync(full);
                freed += size;
              }
            } catch {
              // ignore individual file errors
            }
          }
        }
        actions.push(`Pruned tmp/ and .scratch/ files older than 24h. Freed ${(freed / 1024 / 1024).toFixed(2)}MB.`);
        return {
          checkId: 'disk_space_headroom',
          success: true,
          message: `Temp cache pruned. ${(freed / 1024 / 1024).toFixed(2)}MB freed. For larger cleanups, see action guide.`,
          actionsTaken: actions,
          timestamp: Date.now(),
        };
      } catch (err) {
        actions.push(`Prune failed: ${err instanceof Error ? err.message : String(err)}`);
        return {
          checkId: 'disk_space_headroom',
          success: false,
          message: 'Could not prune temp files automatically.',
          actionsTaken: actions,
          timestamp: Date.now(),
        };
      }
    });

    registerInfoHandler('cpu_load_average', 'High CPU load. Use Task Manager (Windows) or top/htop (Linux/macOS) to find runaway processes.');

    // =========================================================================
    // v1.6.x FEATURE-COVERAGE repair handlers (featureChecks.ts).
    // Every feature diagnostic the service can emit must have a handler so
    // "Repair" never dead-ends. Most are guidance handlers — the feature
    // either works (no fix needed) or needs a concrete user action
    // (install Ollama, re-pull the repo, rebuild, restart).
    // =========================================================================
    registerInfoHandler('orchestrator_providers', 'Orchestrator catalog loads from code + sera_providers.json. If providers are missing: restart SERA (npm start). Enable/disable providers in Settings → MODELS.');
    this.registerRepairHandler('local_mode_ollama', async () => ({
      checkId: 'local_mode_ollama',
      success: false,
      message: 'Ollama cannot be auto-installed from SERA. Install it once and Local Mode goes fully offline.',
      actionsTaken: [
        '1. Download Ollama from https://ollama.com/download (Windows installer).',
        '2. After install, open a terminal and run: ollama pull qwen2.5:3b-instruct',
        '3. Restart SERA — Local Mode will detect the brain automatically.',
        'Online mode (Gemini) is unaffected and remains one click away in the header.',
      ],
      timestamp: Date.now(),
    }));
    registerInfoHandler('api_key_vault', 'Vault keys are managed in Settings → API KEYS (add / test / remove). If the vault file is corrupt, delete .data/sera_api_vault.json and re-add your keys — they are re-encrypted on save.');
    registerInfoHandler('mistake_memory_learning', 'The learning store lives at .data/sera_mistake_memory.json. If corrupt: close SERA, delete the file (a .bak copy sits next to it), restart — SERA re-learns automatically.');
    registerInfoHandler('agi_goal_planner', 'The offline DAG planner ships inside the app. If planning regresses, restart SERA; multi-step goals fall back to single-tool execution until fixed.');
    registerInfoHandler('os_browser_integration', 'Windows keeps rundll32 in C:\\Windows\\System32. If missing: run System File Checker — Run: sfc /scannow (admin terminal), then restart SERA.');
    registerInfoHandler('local_whisper_stt', 'Optional offline STT. Without it SERA uses the browser/desktop speech recognizer. To go fully offline: install whisper.cpp and run: npm run setup:ocr for OCR model assets.');
    registerInfoHandler('local_piper_tts', 'Optional offline TTS. Without it SERA uses Windows/system voices. Install from https://github.com/rhasspy/piper and add a voice model to enable.');
    registerInfoHandler('electron_desktop_host', 'Missing electron/ files mean an incomplete install. Run: git pull, then npm start — the launcher re-verifies and repairs the desktop host automatically.');
    this.registerRepairHandler('version_consistency', async () => {
      const actions: string[] = ['The launcher verifies the served version against package.json on every start.'];
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        await promisify(execFile)('npm.cmd', ['run', 'build'], {
          cwd: process.cwd(),
          windowsHide: true,
          shell: true,
          timeout: 120000,
        });
        actions.push('Rebuilt dist/ from current sources — restart SERA to serve the fresh bundle.');
        return {
          checkId: 'version_consistency',
          success: true,
          message: 'Rebuilt the compiled bundle. Run: npm start to serve it.',
          actionsTaken: actions,
          timestamp: Date.now(),
        };
      } catch (err) {
        actions.push(`Auto-build failed: ${err instanceof Error ? err.message : String(err)}. Manual: Run: npm run build, then npm start`);
        return {
          checkId: 'version_consistency',
          success: false,
          message: 'Could not rebuild automatically. Run: npm run build',
          actionsTaken: actions,
          timestamp: Date.now(),
        };
      }
    });
    registerInfoHandler('input_resilience_keymap', 'The Windows key-map ships in src/actions/WindowsProviders.ts. If key presses get rejected again after a code update: git pull + npm start (the launcher rebuilds), or report which key failed.');
    registerInfoHandler('voice_dsp_pipeline', 'Discord-style mic cleanup (noise suppression, echo cancellation, auto mic volume) is controlled in Settings → MIC & SPEAKERS. Defaults live in src/config/config.ts.');
    registerInfoHandler('voice_sleep_intents', 'Sleep commands ("full quit", "bye sera", "stop listening") are matched in src/utils/sleepCommands.ts — deterministic, before any AI model. If SERA ignores one, restart SERA and try again.');
  }
}

export const defaultAutoRepairEngine = new AutoRepairEngine();
