/**
 * System Diagnostic and Auto-Repair Types for Sera
 */

export type DiagnosticSeverity = 'critical' | 'warning' | 'info' | 'healthy';

export type RepairStatus = 'auto_fixed' | 'can_auto_fix' | 'requires_user_action' | 'not_applicable' | 'fix_failed';

export type DiagnosticCategory =
  | 'api_connectivity'
  | 'memory_storage'
  | 'audio_pipeline'
  | 'browser_automation'
  | 'system_resources'
  | 'config_environment'
  | 'computer_control_native'
  | 'screen_capture'
  | 'clipboard'
  | 'playwright_browser'
  | 'executor_registration'
  // Comprehensive A→Z deep-scan categories (added so the diagnostic
  // system covers every subsystem from small to big, not just the
  // original 11 capability gates).
  | 'node_runtime'              // process uptime, event-loop lag, heap, uncaught handlers
  | 'file_system'              // project root / data / backups / tmp / dist writability
  | 'native_modules'           // koffi, active-win, pngjs, win32-api loadability
  | 'dependencies'             // node_modules presence, lockfile integrity
  | 'network'                  // DNS, Gemini endpoint reachability, latency
  | 'window_management'        // active-win + WindowExecutor probes
  | 'application_launcher'     // xdg-open / start / open binary availability
  | 'tool_registry'            // 36 tools + validators + permissions
  | 'websocket_server'         // ws server bound + accepting
  | 'http_server'              // express listening + diagnostic endpoints respond
  | 'security'                // no leaked secrets in env, no placeholder values
  | 'build_integrity'          // dist artifacts + source maps + TypeScript clean
  | 'disk_resources'          // free disk + CPU load + file descriptor count
  // Feature-coverage categories (v1.6.x features — every shipped
  // subsystem gets its own explicit diagnostic, A to Z).
  | 'orchestration'            // multi-model free-first provider routing
  | 'local_mode'               // Ollama offline brain
  | 'learning'                 // mistake memory & self-healing knowledge
  | 'agi';                     // goal planner / execution graph

export interface DiagnosticCheckResult {
  checkId: string;
  name: string;
  category: DiagnosticCategory;
  severity: DiagnosticSeverity;
  status: 'passed' | 'warning' | 'failed';
  message: string;
  details?: Record<string, unknown>;
  repairStatus: RepairStatus;
  autoFixAvailable: boolean;
  fixDescription?: string;
  userActionGuide?: string;
  timestamp: number;
}

export interface DiagnosticReport {
  timestamp: number;
  overallStatus: 'healthy' | 'degraded' | 'critical';
  summary: {
    totalChecks: number;
    passed: number;
    warnings: number;
    criticals: number;
    autoFixable: number;
  };
  checks: DiagnosticCheckResult[];
}

export interface RepairResult {
  checkId: string;
  success: boolean;
  message: string;
  actionsTaken: string[];
  backupPath?: string;
  error?: string;
  timestamp: number;
}

export interface HealthSummary {
  // 'unknown' is reported before the first passive sweep has completed
  // (or if monitoring was never started). Previously this slot was
  // implicitly 'healthy' via a `|| 'healthy'` fallback in getHealthSummary,
  // which masked every real failure during the boot window — exactly
  // the "system shows healthy but everything is broken" complaint.
  status: 'unknown' | 'healthy' | 'degraded' | 'critical';
  lastScanTimestamp: number;
  activeIssuesCount: number;
  passiveMonitoringActive: boolean;
  recentRepairs: RepairResult[];
  latestChecks: DiagnosticCheckResult[];
}

export interface ScanContext {
  /** True only for user-initiated deep scans (clipboard probe may write). */
  deep: boolean;
}

export interface IDiagnosticCheckRunner {
  id: string;
  name: string;
  category: DiagnosticCategory;
  run(context?: ScanContext): Promise<DiagnosticCheckResult>;
  repair?(): Promise<RepairResult>;
}
