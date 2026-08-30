import { ToolDefinition, ToolPermissionLevel, ToolExecutionResult } from '../types';
import { defaultSystemDiagnosticService } from '../../diagnostics/SystemDiagnosticService';
import { defaultAutoRepairEngine } from '../../diagnostics/AutoRepairEngine';

interface RunDiagnosticsArgs {
  autoRepair?: boolean;
}

interface RepairIssueArgs {
  checkId: string;
}

/**
 * Tool: run_system_diagnostics
 * Enables Sera to run an on-demand full system scan and report/fix issues.
 */
export const runSystemDiagnosticsTool: ToolDefinition<RunDiagnosticsArgs> = {
  name: 'run_system_diagnostics',
  description:
    'Performs a comprehensive diagnostic scan across all Sera subsystems (Gemini API, Memory Store, Audio/DSP, Browser Automation, System Resources, Environment). Categorizes all issues and optionally executes safe auto-repairs.',
  permissionLevel: ToolPermissionLevel.READ_ONLY,
  parameters: {
    type: 'OBJECT',
    properties: {
      autoRepair: {
        type: 'BOOLEAN',
        description: 'If true, automatically repairs any safe, low-risk issues detected during the scan.',
      },
    },
  },
  validateArgs(args: unknown) {
    const value = (args && typeof args === 'object') ? args as any : {};
    return {
      valid: true,
      parsedArgs: {
        autoRepair: Boolean(value.autoRepair),
      },
    };
  },
  async execute(args): Promise<ToolExecutionResult> {
    try {
      const report = await defaultSystemDiagnosticService.runFullScan();
      let repairResults: any[] = [];

      if (args?.autoRepair) {
        repairResults = await defaultSystemDiagnosticService.autoRepairReport(report);
      }

      const issues = report.checks.filter((c) => c.status !== 'passed');
      const passedCount = report.checks.filter((c) => c.status === 'passed').length;

      let summaryText = `System scan complete. Overall status: ${report.overallStatus.toUpperCase()}. (${passedCount}/${report.checks.length} checks passed)`;

      if (issues.length === 0) {
        summaryText += ' All core subsystems are operating nominally with zero errors.';
      } else {
        summaryText += ` Detected ${issues.length} item(s) requiring attention:`;
      }

      return {
        success: true,
        userMessage: summaryText,
        data: {
          overallStatus: report.overallStatus,
          summary: summaryText,
          totalChecks: report.checks.length,
          passedChecks: passedCount,
          issues: issues.map((issue) => ({
            name: issue.name,
            category: issue.category,
            severity: issue.severity,
            status: issue.status,
            message: issue.message,
            autoFixAvailable: issue.autoFixAvailable,
            userActionGuide: issue.userActionGuide || null,
          })),
          autoRepairsExecuted: repairResults,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: `Diagnostic scan failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

/**
 * Tool: repair_system_issue
 * Enables Sera to trigger a targeted auto-fix for a specific component.
 */
export const repairSystemIssueTool: ToolDefinition<RepairIssueArgs> = {
  name: 'repair_system_issue',
  description:
    'Triggers a safe, targeted auto-repair for a specific system component or check ID (e.g. memory_store_integrity, disk_space_headroom, browser_process_zombies, audio_pipeline_state).',
  permissionLevel: ToolPermissionLevel.LOW_RISK_ACTION,
  parameters: {
    type: 'OBJECT',
    properties: {
      checkId: {
        type: 'STRING',
        description: 'The specific check ID to repair (e.g., memory_store_integrity, disk_space_headroom).',
      },
    },
    required: ['checkId'],
  },
  validateArgs(args: unknown) {
    if (!args || typeof args !== 'object' || typeof (args as any).checkId !== 'string' || !(args as any).checkId.trim()) {
      return { valid: false, error: 'A valid checkId string is required.' };
    }
    return {
      valid: true,
      parsedArgs: {
        checkId: (args as any).checkId.trim(),
      },
    };
  },
  async execute(args): Promise<ToolExecutionResult> {
    try {
      if (!args?.checkId) {
        return {
          success: false,
          error: 'A checkId is required for targeted repair.',
        };
      }

      const repair = await defaultAutoRepairEngine.executeRepair(args.checkId);
      return {
        success: repair.success,
        userMessage: repair.message,
        data: {
          checkId: repair.checkId,
          message: repair.message,
          actionsTaken: repair.actionsTaken,
          backupPath: repair.backupPath || null,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: `Auto-repair failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
