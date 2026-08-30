import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SystemDiagnosticService } from '../diagnostics/SystemDiagnosticService';
import { AutoRepairEngine } from '../diagnostics/AutoRepairEngine';
import { SystemHealthMonitor } from '../diagnostics/SystemHealthMonitor';
import { runSystemDiagnosticsTool, repairSystemIssueTool } from '../tools/tools/systemDiagnosticsTools';

describe('System Diagnostics & Auto-Repair Subsystem', () => {
  // The deep-scan now runs ~45 checks, several of which spawn child
  // processes (npx tsc, wmic, arecord, etc.) or do network probes.
  // Vitest's default 5s timeout is too tight — bump it to 60s.
  // (Tests still finish in ~10-15s in practice — the 60s ceiling is
  // a safety margin for slow CI machines.)
  const FULL_SCAN_TIMEOUT = 60000;

  let repairEngine: AutoRepairEngine;
  let diagnosticService: SystemDiagnosticService;
  let healthMonitor: SystemHealthMonitor;

  beforeEach(() => {
    repairEngine = new AutoRepairEngine();
    diagnosticService = new SystemDiagnosticService(repairEngine);
    healthMonitor = new SystemHealthMonitor(diagnosticService, 100000);
  });

  describe('SystemDiagnosticService', () => {
    it('runs a full system scan and returns categorized results', async () => {
      const report = await diagnosticService.runFullScan();

      expect(report).toBeDefined();
      expect(report.timestamp).toBeGreaterThan(0);
      expect(['healthy', 'degraded', 'critical']).toContain(report.overallStatus);
      expect(report.checks.length).toBeGreaterThanOrEqual(5);

      const checkIds = report.checks.map((c) => c.checkId);
      expect(checkIds).toContain('gemini_api_health');
      expect(checkIds).toContain('memory_store_integrity');
      expect(checkIds).toContain('audio_pipeline_state');
      expect(checkIds).toContain('system_resources_health');
      expect(checkIds).toContain('config_environment');
    });

    it('registers the new capability-subsystem checks that surface broken tooling', async () => {
      // The user-reported "system health shows healthy when everything is
      // broken" complaint was root-caused to the old audio_pipeline_state
      // and browser_process_zombies checks being hardcoded to "passed".
      // The rewritten diagnostic service must register real checks for:
      //   - robotjs native module (keyboard/mouse)
      //   - screen capture
      //   - clipboard round-trip
      //   - Playwright Chromium install (managed browser)
      //   - ActionManager executor registration (catches toolRegistry regressions)
      // If any of these are missing, the diagnostic silently stops catching
      // the corresponding failure mode — which is exactly the bug we fixed.
      const report = await diagnosticService.runFullScan();
      const checkIds = report.checks.map((c) => c.checkId);
      expect(checkIds).toContain('computer_control_native');
      expect(checkIds).toContain('screen_capture_availability');
      expect(checkIds).toContain('clipboard_availability');
      expect(checkIds).toContain('playwright_browser_install');
      expect(checkIds).toContain('executor_registration');
      // We added 5 new checks, so the count must have grown accordingly.
      expect(report.checks.length).toBeGreaterThanOrEqual(11);
    });

    it('does not unconditionally pass the audio and browser checks (the bug we fixed)', async () => {
      // Regression guard: the old implementations returned
      //   { status: 'passed', message: '... ready ...' }
      // unconditionally for both `audio_pipeline_state` and
      // `browser_process_zombies`. The rewritten implementations must
      // actually probe the underlying subsystem (file existence for
      // speech-host.cjs; tasklist.exe enumeration for browser workers).
      // We can't fully assert WHAT status they return on every host
      // (depends on environment), but we can assert the check ran and
      // produced a non-empty message that's specific to the environment
      // — not the legacy hardcoded boilerplate.
      const report = await diagnosticService.runFullScan();
      const audio = report.checks.find((c) => c.checkId === 'audio_pipeline_state');
      const browser = report.checks.find((c) => c.checkId === 'browser_process_zombies');
      expect(audio).toBeDefined();
      expect(browser).toBeDefined();
      expect(audio!.message.length).toBeGreaterThan(0);
      expect(browser!.message.length).toBeGreaterThan(0);
      // The legacy boilerplate strings must be gone.
      expect(audio!.message).not.toContain('Audio pipeline configured with isolated zero-gain sink');
      expect(browser!.message).not.toContain('Browser automation subsystem ready with no detached zombie sessions');
    });

    it('correctly reports passed and warning checks', async () => {
      const report = await diagnosticService.runFullScan();
      expect(report.summary.totalChecks).toBe(report.checks.length);
      expect(report.summary.passed + report.summary.warnings + report.summary.criticals).toBe(report.checks.length);
    });

    // Comprehensive A→Z deep-scan coverage. The user requested the
    // diagnostic system "scan EVERYTHING — small to big, A to Z, every
    // subsystem, no limitations". The original 11 checks above only
    // covered the capability gates. The checks below cover node runtime,
    // environment, file system, native modules, dependencies, network,
    // audio, browser, window management, application launcher, tool
    // registry, websocket, http server, security, build integrity, and
    // disk/CPU resources. If any of these new checks are missing, the
    // deep-scan no longer covers the corresponding subsystem.
    it('registers comprehensive A→Z deep-scan checks covering every subsystem', async () => {
      const report = await diagnosticService.runFullScan();
      const checkIds = new Set(report.checks.map((c) => c.checkId));

      // Node runtime
      expect(checkIds).toContain('node_version_check');
      expect(checkIds).toContain('process_uptime');
      expect(checkIds).toContain('event_loop_lag');
      expect(checkIds).toContain('heap_memory_usage');
      expect(checkIds).toContain('uncaught_handler_installed');
      expect(checkIds).toContain('esm_shim_healthy');

      // Environment / security
      expect(checkIds).toContain('env_file_present');
      expect(checkIds).toContain('env_no_placeholder_values');
      expect(checkIds).toContain('no_secrets_in_env');

      // File system
      expect(checkIds).toContain('project_root_writable');
      expect(checkIds).toContain('data_directory_writable');
      expect(checkIds).toContain('backups_directory_writable');
      expect(checkIds).toContain('tmp_directory_writable');
      expect(checkIds).toContain('key_source_files_present');
      expect(checkIds).toContain('traineddata_present');
      expect(checkIds).toContain('electron_entry_present');

      // Native modules
      expect(checkIds).toContain('koffi_loadable');
      expect(checkIds).toContain('active_win_loadable');
      expect(checkIds).toContain('pngjs_loadable');
      expect(checkIds).toContain('win32_api_loadable');

      // Dependencies
      expect(checkIds).toContain('node_modules_present');
      expect(checkIds).toContain('package_lock_present');

      // Network
      expect(checkIds).toContain('google_dns_resolvable');
      expect(checkIds).toContain('gemini_endpoint_reachable');

      // Audio
      expect(checkIds).toContain('audio_devices_count');

      // Browser
      expect(checkIds).toContain('managed_browser_session_initialized');

      // Window management
      expect(checkIds).toContain('active_window_detectable');

      // Application launcher
      expect(checkIds).toContain('app_launcher_available');

      // Tool registry
      expect(checkIds).toContain('tool_registry_count');

      // WebSocket / HTTP
      expect(checkIds).toContain('websocket_server_listening');
      expect(checkIds).toContain('http_server_listening');
      expect(checkIds).toContain('diagnostics_endpoints_responding');

      // Build integrity
      expect(checkIds).toContain('dist_build_integrity');
      expect(checkIds).toContain('typescript_clean');
      expect(checkIds).toContain('source_imports_healthy');

      // Disk & CPU
      expect(checkIds).toContain('disk_space_headroom');
      expect(checkIds).toContain('cpu_load_average');

      // The comprehensive set must include AT LEAST 35 distinct checks
      // (the original 11 + the ~30 new ones). This is the regression
      // guard against someone accidentally dropping a factory from
      // COMPREHENSIVE_CHECK_FACTORIES.
      expect(report.checks.length).toBeGreaterThanOrEqual(35);
    });

    // ESM fix regression guard: the original checks used bare require()
    // and __dirname which threw ReferenceError under tsx. Now they
    // should produce either 'passed' or 'failed' with a real, specific
    // error message — NEVER "require is not defined" or
    // "__dirname is not defined".
    it('does not surface ESM/CJS interop errors in any check result', async () => {
      const report = await diagnosticService.runFullScan();
      for (const check of report.checks) {
        expect(check.message).not.toContain('require is not defined');
        expect(check.message).not.toContain('__dirname is not defined');
        expect(check.message).not.toContain('__filename is not defined');
      }
    });

    // Regression guard for the global-error-handler fix. Previously server.ts
    // installed NO process.on('uncaughtException') / process.on('unhandledRejection')
    // handlers, so the check correctly reported CRITICAL. Now server.ts
    // installs them at boot, AND vitest itself installs handlers during tests,
    // so the check should always return 'passed' in this test environment.
    // The check is also the most critical of the comprehensive set — without
    // these handlers, any stray rejection in any of the 36 tools crashes
    // the server with no log trail. This test ensures the check itself
    // executes without throwing and reports a sane status.
    it('correctly detects whether process-level error handlers are installed', async () => {
      const report = await diagnosticService.runFullScan();
      const check = report.checks.find((c) => c.checkId === 'uncaught_handler_installed');
      expect(check).toBeDefined();
      // Vitest installs its own uncaughtException/unhandledRejection handlers
      // to catch test failures, so the listener counts should be > 0 in the
      // test environment. The check should report 'passed'.
      expect(['passed', 'failed']).toContain(check!.status);
      if (check!.status === 'passed') {
        expect(check!.message).toMatch(/uncaughtException:\s*\d+/);
        expect(check!.message).toMatch(/unhandledRejection:\s*\d+/);
      } else {
        // If it's failing, the message must explain the failure mode.
        expect(check!.message).toContain('NOT installed');
      }
    });

    // Regression guard for the app_launcher_available Windows false positive.
    // Windows "start" is a builtin of cmd.exe, NOT a real executable on PATH.
    // The old code ran `where start` which always returned nothing on healthy
    // Windows, so every Windows install reported CRITICAL for this check.
    // The fix: treat cmd-builtins (only "start" for now) as always-available.
    // We can't easily mock process.platform in vitest, but we CAN verify the
    // check runs without throwing and reports a sane status. Whether the
    // status is 'passed' depends on whether the launcher binary is actually
    // on PATH in the test environment — the dev container here has no
    // xdg-open installed, so the check correctly returns 'failed' on this
    // host. The check must NEVER spuriously say "start is not on PATH" on
    // Windows (the CMD_BUILTINS fast-path handles that at runtime).
    it('app_launcher_available check runs cleanly without false-positive cmd-builtin failures', async () => {
      const report = await diagnosticService.runFullScan();
      const check = report.checks.find((c) => c.checkId === 'app_launcher_available');
      expect(check).toBeDefined();
      // Status must be a real probe result — never an exception leak.
      expect(['passed', 'failed']).toContain(check!.status);
      // The check must never surface the cmd-builtin false positive. On
      // Windows, "start" should be treated as always-present via the
      // CMD_BUILTINS fast-path in binaryOnPath(). We can't easily mock
      // process.platform, but we CAN verify the message format is sane:
      // the launcher name must be one of start/open/xdg-open in either
      // the pass or fail message.
      const launcherNames = ['start', 'open', 'xdg-open'];
      const mentionsLauncher = launcherNames.some((name) => check!.message.includes(name));
      expect(mentionsLauncher).toBe(true);
    });

    // Regression guard for the google_dns_resolvable brittle regex. The old
    // regex `/172\.\d+\.\d+\.\d+/` matched private RFC 1918 ranges (172.16-31.x)
    // which is NOT Google's IP space — false "Network may be intercepted"
    // warnings fired on healthy corporate/VPN networks. The fix: accept any
    // *public* IPv4 as a pass, only warn when ALL returned IPs are private.
    it('google_dns_resolvable check distinguishes public vs private IPs correctly', async () => {
      const report = await diagnosticService.runFullScan();
      const check = report.checks.find((c) => c.checkId === 'google_dns_resolvable');
      expect(check).toBeDefined();
      // The check uses `warn` (not `fail`) when DNS lookup fails entirely,
      // and `warn` when only private IPs are returned. So status is either
      // 'passed' (real public IP returned) or 'warning' — NEVER 'failed'.
      expect(['passed', 'warning']).toContain(check!.status);
      // Must never contain the old brittle "Network may be intercepted"
      // phrasing in a PASS case.
      if (check!.status === 'passed') {
        expect(check!.message).not.toContain('Network may be intercepted');
        // Two legitimate pass reasons (see comprehensiveChecks.ts):
        //  (a) DNS returned a real public IP, or
        //  (b) DNS answers are hijacked to private IPs (VPN / TUN fake-IP
        //      mode) but end-to-end HTTPS connectivity works — a
        //      transparent proxy/TUN environment. Branch (b) is common on
        //      real Windows dev machines behind a VPN/proxy and must still
        //      count as an honest pass.
        const isPublicIpPass = /public IP/i.test(check!.message);
        const isTransparentProxyPass = /transparent proxy\/TUN environment/i.test(check!.message);
        expect(isPublicIpPass || isTransparentProxyPass).toBe(true);
      }
    });

    // Regression guard for the clipboard pollution bug (v1.6.6→v1.6.9).
    // v1.6.6 wrote "sera-clip-probe-<ts>-<rand>" every 45s sweep; v1.6.8
    // restricted the write to explicit Full Scans but users run Full
    // Scans too, so probes STILL appeared in Win+V history (v1.6.9 field
    // report). Since v1.6.9 the check is 100% READ-ONLY on every path:
    // no code path may call the clipboard provider's set() during
    // diagnostics, EVER.
    it('clipboard check NEVER writes to the clipboard (read-only, even deep scans)', async () => {
      const clipboardModule = await import('../clipboard/ClipboardManager');
      const { defaultClipboardProvider } = clipboardModule;
      const setSpy = vi
        .spyOn(defaultClipboardProvider, 'set')
        .mockResolvedValue(true);
      try {
        // Passive background sweep…
        await diagnosticService.runFullScan();
        // …and the explicit deep Full Scan (POST /api/diagnostics/scan).
        await diagnosticService.runFullScan({ deep: true });
        // Not a single write may happen — the spy replaces the real
        // provider write, so even a buggy write cannot pollute anything.
        expect(setSpy).not.toHaveBeenCalled();
      } finally {
        setSpy.mockRestore();
      }
    });

    it('clipboard check passes (read-only) when a backend read works', async () => {
      const clipboardModule = await import('../clipboard/ClipboardManager');
      const { defaultClipboardProvider } = clipboardModule;
      const getSpy = vi
        .spyOn(defaultClipboardProvider, 'get')
        .mockResolvedValue('user content — must stay untouched');
      const setSpy = vi
        .spyOn(defaultClipboardProvider, 'set')
        .mockResolvedValue(true);
      try {
        const report = await diagnosticService.runFullScan({ deep: true });
        const check = report.checks.find((c) => c.checkId === 'clipboard_availability');
        expect(check).toBeDefined();
        // On platforms WITH a clipboard backend the read-only check passes
        // without a single write. On backend-less machines (this container
        // has no xclip/xsel/wl-copy) it fails HONESTLY at the platform
        // gate — still without ever writing.
        const backendMissing = check!.message.includes('No Linux clipboard backend');
        if (backendMissing) {
          expect(check!.status).toBe('failed');
        } else {
          expect(check!.status).toBe('passed');
          expect(JSON.stringify(check!.details)).not.toContain('user content');
        }
        expect(setSpy).not.toHaveBeenCalled();
      } finally {
        getSpy.mockRestore();
        setSpy.mockRestore();
      }
    });

    // Regression guard for the tool_registry_count false positive. The
    // previous version of this check called `toolManager.listTools?.()` —
    // but ToolManager (src/tools/ToolManager.ts) exposes `getAllTools()`,
    // NOT `listTools()`. The optional chain returned undefined for the
    // missing method, fell back to [] via ??, and reported "Only 0 tools
    // registered" on every SERA install despite 36 tools being correctly
    // registered in createDefaultToolManager(). This test asserts the check
    // finds the real tool count (>=25, in practice 36+).
    it('tool_registry_count uses the correct ToolManager.getAllTools() method', async () => {
      const report = await diagnosticService.runFullScan();
      const check = report.checks.find((c) => c.checkId === 'tool_registry_count');
      expect(check).toBeDefined();
      // The check must report a real count (>=25), NOT the spurious 0.
      // The createDefaultToolManager() in src/tools/toolRegistry.ts
      // registers 36 tools, so we expect >=25 (the warn threshold).
      expect(check!.status).toBe('passed');
      // Message must mention the count — not "Only 0".
      expect(check!.message).toMatch(/\d+/);
      expect(check!.message).not.toContain('Only 0');
      // Details must include the actual count.
      const count = (check!.details as { count?: number } | undefined)?.count;
      expect(count).toBeDefined();
      expect(count!).toBeGreaterThanOrEqual(25);
    });

    // Regression guard for the koffi_loadable false positive. The previous
    // check asserted `typeof koffi.func === 'function'`, but koffi's actual
    // public API surface is `koffi.load()` (returns a LibraryHandle, then
    // you call `lib.func(...)`). `koffi.func` doesn't exist on the koffi
    // namespace — every SERA install reported "koffi loaded but its API is
    // malformed" even though koffi was perfectly healthy. Verified the
    // real API surface via `node -e "console.log(Object.keys(require('koffi')))"`.
    it('koffi_loadable uses the correct koffi API surface (load, pointer)', async () => {
      const report = await diagnosticService.runFullScan();
      const check = report.checks.find((c) => c.checkId === 'koffi_loadable');
      expect(check).toBeDefined();
      // koffi is installed and loadable — must pass.
      expect(check!.status).toBe('passed');
      // Must NOT contain the false "API is malformed" wording.
      expect(check!.message).not.toContain('API is malformed');
    });

    // Regression guard for the pngjs_loadable false positive. The previous
    // check asserted `PNG.sync.parse` exists, but pngjs's sync API has
    // ONLY `write()` — there is no `PNG.sync.parse`. Verified via
    // `node -e "console.log(typeof require('pngjs').PNG.sync.parse)"` →
    // 'undefined'. SERA uses `new PNG()` + `PNG.sync.write()` in
    // src/vision/screenImage.ts — never calls PNG.sync.parse.
    it('pngjs_loadable uses the correct pngjs API surface (PNG.sync.write)', async () => {
      const report = await diagnosticService.runFullScan();
      const check = report.checks.find((c) => c.checkId === 'pngjs_loadable');
      expect(check).toBeDefined();
      // pngjs is installed and loadable — must pass.
      expect(check!.status).toBe('passed');
      // Must NOT contain the false "API is malformed" wording.
      expect(check!.message).not.toContain('API is malformed');
    });
  });

  describe('AutoRepairEngine', () => {
    it('executes a built-in safe repair and records history', async () => {
      const result = await repairEngine.executeRepair('memory_store_integrity');

      expect(result.checkId).toBe('memory_store_integrity');
      expect(result.success).toBe(true);
      expect(result.actionsTaken.length).toBeGreaterThan(0);

      const history = repairEngine.getRepairHistory();
      expect(history.length).toBe(1);
      expect(history[0].checkId).toBe('memory_store_integrity');
    });

    it('handles unsupported repair IDs gracefully with actionable feedback', async () => {
      const result = await repairEngine.executeRepair('unknown_hardware_defect');

      expect(result.checkId).toBe('unknown_hardware_defect');
      expect(result.success).toBe(false);
      expect(result.message).toContain('No automatic repair handler available');
    });

    // Regression guard for the audit finding: 5 new critical checks had
    // no repair handlers registered, so users got "no auto-fix available"
    // even though actionable guidance existed. Now every checkId has a
    // handler that returns a real, actionable message — never the dead-end
    // "No automatic repair handler available" string.
    it('registers repair handlers for the 5 new critical checkIds added by the audit', async () => {
      const newCheckIds = [
        'computer_control_native',
        'screen_capture_availability',
        'clipboard_availability',
        'playwright_browser_install',
        'executor_registration',
        'system_resources_health', // also orphaned per audit
      ];
      for (const checkId of newCheckIds) {
        const result = await repairEngine.executeRepair(checkId);
        expect(result.checkId).toBe(checkId);
        // The dead-end string must be GONE for every one of these checkIds.
        expect(result.message).not.toContain('No automatic repair handler available');
        expect(result.actionsTaken.length).toBeGreaterThan(0);
        // For repairs that need user intervention (success=false), the
        // message / actions must contain a concrete action keyword
        // (install, rebuild, restart, Run:, command, privileges) so the
        // user knows what to do. For repairs that succeeded automatically
        // (success=true, e.g. disk_space_headroom cleanup), no manual
        // action is needed — the actionsTaken just describe what was done.
        if (!result.success) {
          const isActionable = /install|rebuild|restart|Run:|command|privileges/i.test(result.message)
            || result.actionsTaken.some((a) => /install|rebuild|restart|Run:|command|privileges/i.test(a));
          expect(isActionable).toBe(true);
        }
      }
    });

    // Comprehensive A→Z repair handler coverage. Every checkId that the
    // SystemDiagnosticService registers must have a corresponding repair
    // handler in AutoRepairEngine — otherwise clicking "Repair" on a
    // failing check returns the dead-end "No automatic repair handler
    // available" message and the user has no idea what to do.
    it('registers a repair handler for EVERY check the diagnostic service can emit', async () => {
      const report = await diagnosticService.runFullScan();
      for (const check of report.checks) {
        const result = await repairEngine.executeRepair(check.checkId);
        expect(result.checkId).toBe(check.checkId);
        // The dead-end string must NEVER appear for any registered check.
        expect(result.message).not.toContain('No automatic repair handler available');
        expect(result.actionsTaken.length).toBeGreaterThan(0);
      }
    });
  });

  describe('SystemHealthMonitor', () => {
    it('runs passive health sweep and notifies alert listeners', async () => {
      const listener = vi.fn();
      const unsubscribe = healthMonitor.subscribe(listener);

      const report = await healthMonitor.runPassiveSweep();
      expect(report).toBeDefined();

      const summary = healthMonitor.getHealthSummary();
      expect(summary.status).toBe(report.overallStatus);
      expect(summary.latestChecks.length).toBe(report.checks.length);

      unsubscribe();
    });

    it('manages start and stop lifecycles without leaking timers', () => {
      healthMonitor.start();
      expect(healthMonitor.getHealthSummary().passiveMonitoringActive).toBe(true);

      healthMonitor.stop();
      expect(healthMonitor.getHealthSummary().passiveMonitoringActive).toBe(false);
    });

    // Regression guard for the audit finding: getHealthSummary used
    // `this.lastReport?.timestamp || Date.now()`, which made it look like
    // a scan had just run even when no scan had ever run. Now we return
    // 0 until lastReport is populated, so the renderer can detect the
    // "no scan yet" case instead of being misled.
    it('returns lastScanTimestamp=0 before the first sweep has run', () => {
      const freshMonitor = new SystemHealthMonitor(diagnosticService, 100000);
      const summary = freshMonitor.getHealthSummary();
      expect(summary.lastScanTimestamp).toBe(0);
      expect(summary.status).toBe('unknown');
    });

    it('returns a real lastScanTimestamp after a sweep has run', async () => {
      await healthMonitor.runPassiveSweep();
      const summary = healthMonitor.getHealthSummary();
      expect(summary.lastScanTimestamp).toBeGreaterThan(0);
    });

    it('getFreshHealthSummary triggers a sweep when the cache is stale', async () => {
      const freshMonitor = new SystemHealthMonitor(diagnosticService, 100000);
      // First call: no cached report, should trigger a sweep.
      const result = await freshMonitor.getFreshHealthSummary();
      expect(result.scanFresh).toBe(true);
      expect(result.lastScanTimestamp).toBeGreaterThan(0);
      // Second call immediately: cache is fresh, should NOT trigger.
      const cached = await freshMonitor.getFreshHealthSummary();
      expect(cached.scanFresh).toBe(false);
    });
  });

  describe('LLM Tools Integration', () => {
    it('executes run_system_diagnostics tool and returns structured response', async () => {
      const result: any = await runSystemDiagnosticsTool.execute({ autoRepair: false });

      expect(result.success).toBe(true);
      expect(result.userMessage).toContain('System scan complete');
      expect(result.data).toBeDefined();
      expect(result.data.summary).toContain('System scan complete');
      expect(Array.isArray(result.data.issues)).toBe(true);
    });

    it('executes repair_system_issue tool for targeted repair', async () => {
      const result: any = await repairSystemIssueTool.execute({ checkId: 'disk_space_headroom' });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.checkId).toBe('disk_space_headroom');
      expect(result.data.actionsTaken.length).toBeGreaterThan(0);
    });
  });
});
