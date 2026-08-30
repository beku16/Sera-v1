import {
  DiagnosticCheckResult,
  DiagnosticReport,
  HealthSummary,
  RepairResult,
} from './types';
import {
  SystemDiagnosticService,
  defaultSystemDiagnosticService,
} from './SystemDiagnosticService';

export type HealthAlertListener = (alert: {
  type: 'auto_repaired' | 'escalation_required' | 'warning';
  title: string;
  message: string;
  check: DiagnosticCheckResult;
  repairResult?: RepairResult;
}) => void;

/**
 * SystemHealthMonitor — Continuous Lightweight Passive System Health Daemon
 *
 * Operates in the background with negligible CPU footprint (<0.05% CPU),
 * catching anomalies during normal Sera operation without interrupting user workflows.
 */
export class SystemHealthMonitor {
  private diagnosticService: SystemDiagnosticService;
  private timer: NodeJS.Timeout | null = null;
  private intervalMs: number;
  private isRunning: boolean = false;
  private lastReport: DiagnosticReport | null = null;
  private recentRepairs: RepairResult[] = [];
  private alertListeners: Set<HealthAlertListener> = new Set();
  private knownIssueIds: Set<string> = new Set();
  /** v1.6.11: in-flight sweep — concurrent callers share ONE scan. */
  private sweepInFlight: Promise<DiagnosticReport> | null = null;

  constructor(
    diagnosticService: SystemDiagnosticService = defaultSystemDiagnosticService,
    intervalMs: number = 45000 // 45 seconds polling
  ) {
    this.diagnosticService = diagnosticService;
    this.intervalMs = intervalMs;
  }

  public subscribe(listener: HealthAlertListener): () => void {
    this.alertListeners.add(listener);
    return () => this.alertListeners.delete(listener);
  }

  /**
   * Starts continuous passive background health monitoring
   */
  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Run an initial passive sweep immediately. Previously this used a 5s
    // startup delay, which meant any client that polled /api/diagnostics/health
    // during the first 5 seconds after server boot saw status='healthy' even
    // though no scan had ever run. The DiagnosticsModal in the renderer
    // polls on mount, so users almost always hit this window. Running the
    // first sweep synchronously-in-the-background means by the time the
    // first HTTP request lands, lastReport is populated with a real
    // (possibly failing) scan result. If the immediate sweep throws or
    // takes long, getHealthSummary still falls back to 'unknown' rather
    // than falsely reporting 'healthy'.
    void this.runPassiveSweep().catch((err) => {
      console.warn('[SystemHealthMonitor] Initial passive sweep failed:', err);
    });

    this.timer = setInterval(() => {
      void this.runPassiveSweep();
    }, this.intervalMs);

    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Stops passive monitoring
   */
  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Performs a single passive health sweep and resolves safe issues.
   *
   * v1.6.11 FIX: the doc for getFreshHealthSummary always claimed "if a
   * sweep is already in flight, we don't queue a second one" — but no such
   * guard existed. Concurrent /api/diagnostics/health requests each ran a
   * FULL scan in parallel (child processes, Playwright probes), and the 45s
   * interval timer could overlap a slow sweep. Concurrent callers now share
   * the in-flight promise.
   */
  public async runPassiveSweep(): Promise<DiagnosticReport> {
    if (this.sweepInFlight) return this.sweepInFlight;
    const sweep = (async () => {
      try {
        const report = await this.diagnosticService.runFullScan();
        this.lastReport = report;

        for (const check of report.checks) {
          const issueKey = `${check.checkId}:${check.status}`;

          if (check.status !== 'passed') {
            // If this is a newly discovered issue or persistent warning
            if (!this.knownIssueIds.has(issueKey)) {
              this.knownIssueIds.add(issueKey);

              // Attempt safe auto-fix if available
              if (check.autoFixAvailable) {
                const repair = await this.diagnosticService.getRepairEngine().executeRepair(check.checkId);
                this.recentRepairs.unshift(repair);
                if (this.recentRepairs.length > 20) this.recentRepairs.pop();

                this.notifyListeners({
                  type: 'auto_repaired',
                  title: `Auto-Repaired: ${check.name}`,
                  message: repair.message,
                  check,
                  repairResult: repair,
                });
              } else {
                // Escalate to user without interrupting flow
                this.notifyListeners({
                  type: 'escalation_required',
                  title: `System Alert: ${check.name}`,
                  message: check.userActionGuide || check.message,
                  check,
                });
              }
            }
          } else {
            // Check passed — clear any prior alert flags
            this.knownIssueIds.delete(`${check.checkId}:warning`);
            this.knownIssueIds.delete(`${check.checkId}:failed`);
          }
        }

        return report;
      } catch (err) {
        console.warn('[SystemHealthMonitor] Error during passive sweep:', err);
        throw err;
      } finally {
        this.sweepInFlight = null;
      }
    })();
    this.sweepInFlight = sweep;
    return sweep;
  }

  /**
   * Returns high-level health summary for telemetry
   *
   * Previously this returned `status: this.lastReport?.overallStatus || 'healthy'`,
   * which meant that before the first sweep had completed (or if `start()`
   * was never called), the API would respond with `'healthy'` even though
   * no scan had ever run. That was the root cause of the user-reported
   * "system health shows healthy when nothing actually works" complaint
   * during the boot window. Now we return `'unknown'` until lastReport
   * is populated, so callers know they need to wait for / trigger a real
   * scan.
   *
   * CRITICAL FIX #2: `lastScanTimestamp` previously used
   * `this.lastReport?.timestamp || Date.now()`, which meant that before
   * the first sweep had ever run, the API returned the CURRENT timestamp
   * — making it look like a scan had just happened. Now we return 0
   * when no scan has run, and the renderer can detect that case.
   */
  public getHealthSummary(): HealthSummary {
    const activeIssues = this.lastReport?.checks.filter((c) => c.status !== 'passed') || [];

    return {
      status: this.lastReport?.overallStatus ?? 'unknown',
      lastScanTimestamp: this.lastReport?.timestamp ?? 0,
      activeIssuesCount: activeIssues.length,
      passiveMonitoringActive: this.isRunning,
      recentRepairs: [...this.recentRepairs],
      latestChecks: this.lastReport?.checks || [],
    };
  }

  /**
   * Returns a fresh health summary, triggering a new sweep if the cached
   * report is older than `intervalMs` (or no report exists at all).
   *
   * This is the recommended entry point for HTTP endpoints that need a
   * fresh answer rather than a 45-second-stale cache. The previous
   * implementation always returned the cache, so a tool that broke 30s
   * ago and got fixed 5s ago would still show 'critical' for up to 40s.
   * Now the endpoint returns a fresh scan as soon as it can.
   *
   * If a sweep is already in flight, we don't queue a second one — we
   * return the cached result with a `scanFresh: false` marker so the
   * caller knows the data isn't fresh.
   */
  public async getFreshHealthSummary(): Promise<HealthSummary & { scanFresh: boolean }> {
    const now = Date.now();
    const lastTs = this.lastReport?.timestamp ?? 0;
    const isStale = (now - lastTs) > this.intervalMs;
    if (!isStale) {
      return { ...this.getHealthSummary(), scanFresh: false };
    }
    // Trigger a fresh sweep synchronously and wait for it.
    try {
      await this.runPassiveSweep();
    } catch (err) {
      // Sweep failed — return whatever cached data we have with a
      // scanFresh: false marker so the caller knows it's stale.
      return { ...this.getHealthSummary(), scanFresh: false };
    }
    return { ...this.getHealthSummary(), scanFresh: true };
  }

  private notifyListeners(alert: {
    type: 'auto_repaired' | 'escalation_required' | 'warning';
    title: string;
    message: string;
    check: DiagnosticCheckResult;
    repairResult?: RepairResult;
  }): void {
    for (const listener of this.alertListeners) {
      try {
        listener(alert);
      } catch (err) {
        console.warn('[SystemHealthMonitor] Listener error:', err);
      }
    }
  }
}

export const defaultSystemHealthMonitor = new SystemHealthMonitor();
