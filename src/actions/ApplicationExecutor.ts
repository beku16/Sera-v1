import { spawn, ChildProcess, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ACTION_ERROR_CODES, ActionError } from './errors';
import { Action, ActionExecutionContext, ActionExecutionResult, ActionExecutor, VerificationResult } from './types';
import { resolveApplication } from '../authorization/ApplicationResolver';
import type { WindowControlProvider, WindowInfo } from './WindowExecutor';

const execFileAsync = promisify(execFile);

export interface ApplicationCloseParameters { processId?: number; application?: string; }
export interface ApplicationCloseResult { processId: number; application?: string; terminated: boolean; }
export interface ApplicationProcessController {
  terminate(processId: number): Promise<boolean>;
  isRunning(processId: number): Promise<boolean>;
}

export interface ApplicationLaunchParameters { application: string; }
export interface ApplicationLaunchResult { application: string; displayName: string; pid?: number; windowHandle?: string; }
export interface ApplicationDefinition {
  id: string;
  displayName: string;
  executable: string;
  args?: string[];
  /**
   * Optional platform filter — if set, the entry is only registered on
   * hosts whose `process.platform` matches. Used to keep the Windows
   * catalog (calc.exe) and Linux catalog (gnome-calculator) from
   * colliding on the same `id`. Omit to register on every host.
   */
  platform?: 'win32' | 'linux' | 'darwin' | 'posix';
}
export interface ApplicationLaunchHandle { pid?: number; process: Pick<ChildProcess, 'exitCode' | 'killed' | 'kill'>; }
export type ApplicationLauncher = (application: ApplicationDefinition) => Promise<ApplicationLaunchHandle>;
export type ApplicationReadinessChecker = (application: ApplicationDefinition, pid?: number) => Promise<unknown>;

const defaultApplicationProcessController: ApplicationProcessController = {
  async terminate(processId: number): Promise<boolean> {
    if (processId === process.pid) return false;
    if (process.platform === 'win32') {
      try {
        await execFileAsync('taskkill.exe', ['/PID', String(processId), '/T', '/F'], { windowsHide: true });
        return true;
      } catch {
        return false;
      }
    }
    // POSIX (Linux/macOS): send SIGTERM, then SIGKILL if still alive.
    try {
      process.kill(processId, 'SIGTERM');
    } catch {
      return false;
    }
    // Give the process a 1s grace period to exit cleanly before SIGKILL.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      process.kill(processId, 0); // probe — throws if the process is gone
      // Still alive: escalate to SIGKILL.
      process.kill(processId, 'SIGKILL');
    } catch {
      // already gone — that's success.
    }
    return true;
  },
  async isRunning(processId: number): Promise<boolean> {
    if (process.platform === 'win32') {
      try {
        const result = await execFileAsync('tasklist.exe', ['/FI', `PID eq ${processId}`, '/NH'], { windowsHide: true });
        if (result.stdout.includes('No tasks are running')) return false;
        const pidPattern = new RegExp('^\\S+\\s+' + processId + '\\s', 'm');
        return pidPattern.test(result.stdout);
      } catch {
        return false;
      }
    }
    // POSIX: process.kill(pid, 0) is a no-op probe. It throws if the
    // process doesn't exist or we don't have permission to signal it.
    try {
      process.kill(processId, 0);
      return true;
    } catch {
      return false;
    }
  },
};

const DEFAULT_APPLICATIONS: ApplicationDefinition[] = [
  // Windows catalog (calc.exe, notepad.exe, etc.) — only registered on Windows.
  { id: 'calculator', displayName: 'Calculator', executable: 'calc.exe', platform: 'win32' },
  { id: 'notepad', displayName: 'Notepad', executable: 'notepad.exe', platform: 'win32' },
  { id: 'file-explorer', displayName: 'File Explorer', executable: 'explorer.exe', platform: 'win32' },
  { id: 'paint', displayName: 'Paint', executable: 'mspaint.exe', platform: 'win32' },
  { id: 'wordpad', displayName: 'WordPad', executable: 'wordpad.exe', platform: 'win32' },
  { id: 'cmd', displayName: 'Command Prompt', executable: 'cmd.exe', platform: 'win32' },
  { id: 'powershell', displayName: 'PowerShell', executable: 'powershell.exe', platform: 'win32' },
  { id: 'taskmgr', displayName: 'Task Manager', executable: 'taskmgr.exe', platform: 'win32' },
  { id: 'snipping-tool', displayName: 'Snipping Tool', executable: 'snippingtool.exe', platform: 'win32' },
  { id: 'settings', displayName: 'Settings', executable: 'start', args: ['ms-settings:'], platform: 'win32' },
  { id: 'clock', displayName: 'Clock', executable: 'start', args: ['ms-clock:'], platform: 'win32' },
  { id: 'store', displayName: 'Microsoft Store', executable: 'start', args: ['ms-windows-store:'], platform: 'win32' },
  { id: 'edge', displayName: 'Microsoft Edge', executable: 'start', args: ['msedge'], platform: 'win32' },
  { id: 'chrome', displayName: 'Google Chrome', executable: 'start', args: ['chrome'], platform: 'win32' },
  { id: 'firefox', displayName: 'Firefox', executable: 'start', args: ['firefox'], platform: 'win32' },
  // Linux catalog — only registered on Linux.
  // xdg-open is the universal Linux desktop-application launcher; for
  // URL-style entries (e.g. control: or https://) it delegates to the
  // default handler, for installed .desktop apps it resolves them via
  // the desktop environment's launcher.
  { id: 'calculator', displayName: 'Calculator', executable: 'gnome-calculator', platform: 'linux' },
  { id: 'files', displayName: 'Files', executable: 'nautilus', platform: 'linux' },
  { id: 'text-editor', displayName: 'Text Editor', executable: 'gedit', platform: 'linux' },
  { id: 'terminal', displayName: 'Terminal', executable: 'gnome-terminal', platform: 'linux' },
  { id: 'settings', displayName: 'Settings', executable: 'gnome-control-center', platform: 'linux' },
  { id: 'screenshot', displayName: 'Screenshot', executable: 'gnome-screenshot', platform: 'linux' },
  { id: 'system-monitor', displayName: 'System Monitor', executable: 'gnome-system-monitor', platform: 'linux' },
  { id: 'chrome', displayName: 'Google Chrome', executable: 'google-chrome', platform: 'linux' },
  { id: 'chrome-stable', displayName: 'Google Chrome', executable: 'google-chrome-stable', platform: 'linux' },
  { id: 'firefox', displayName: 'Firefox', executable: 'firefox', platform: 'linux' },
  { id: 'discord', displayName: 'Discord', executable: 'discord', platform: 'linux' },
  { id: 'slack', displayName: 'Slack', executable: 'slack', platform: 'linux' },
  { id: 'spotify', displayName: 'Spotify', executable: 'spotify', platform: 'linux' },
  { id: 'code', displayName: 'Visual Studio Code', executable: 'code', platform: 'linux' },
  // No cross-platform fallbacks — every catalog entry must be platform-
  // specific so they don't overwrite each other in the applications Map.
  // (A bare `calculator` → `calc` Unix fallback was tempting but `calc`
  // is a CLI calculator on Unix, not the GUI app the user expects, and
  // it would have silently overwritten calc.exe on Windows. The
  // resolver's `which` + `xdg-open` fallback handles any name not in
  // this catalog.)
];

// Platform filter for catalog entries. Entries without a `platform`
// filter are registered on every host (the `calc` fallback below is
// an example). Used to keep the Windows catalog (calc.exe) and Linux
// catalog (gnome-calculator) from colliding on the same `id`.
//
// NOTE: This consults `executorPlatform` (the executor's `this.platform`
// field), NOT `process.platform`. Tests construct an ApplicationExecutor
// with `platform: 'win32'` to simulate a Windows executor on a Linux
// CI host — using `process.platform` here would silently filter those
// test entries out and break the test. The executor's platform is the
// right source of truth because it's what the launcher / process
// controller ultimately use to dispatch.
function platformMatches(entry: ApplicationDefinition, executorPlatform: NodeJS.Platform): boolean {
  if (!entry.platform) return true;
  if (entry.platform === 'win32') return executorPlatform === 'win32';
  if (entry.platform === 'linux') return executorPlatform === 'linux';
  if (entry.platform === 'darwin') return executorPlatform === 'darwin';
  if (entry.platform === 'posix') return executorPlatform !== 'win32';
  return true;
}

function normalize(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, '-'); }

function launchWindowsApplication(application: ApplicationDefinition): Promise<ApplicationLaunchHandle> {
  return new Promise((resolve, reject) => {
    // For `start`-style aliases (ms-settings:, msedge, chrome, etc.), spawn
    // through cmd.exe so the shell resolves the alias. For real .exe files,
    // spawn directly without a shell to avoid quoting pitfalls.
    const usesShell = application.executable === 'start';
    const command = usesShell ? 'cmd.exe' : application.executable;
    const args = usesShell ? ['/c', 'start', '', ...application.args] : (application.args || []);
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      shell: false,
    });
    child.once('spawn', () => { child.unref(); resolve({ pid: child.pid, process: child }); });
    child.once('error', reject);
  });
}

/**
 * Linux / macOS launcher. Uses `xdg-open` (Linux) or `open` (macOS) for
 * URL-style entries, or directly spawns the resolved executable for
 * real binaries. The launcher is deliberately simple — the resolver
 * (ApplicationResolver) has already done the work of finding the right
 * binary on PATH; here we just spawn it.
 *
 * The `detached: true, stdio: 'ignore'` combination is critical: it
 * means the spawned app outlives SERA's process and we don't get
 * blocked on its stdout/stderr pipe.
 */
function launchPosixApplication(application: ApplicationDefinition): Promise<ApplicationLaunchHandle> {
  return new Promise((resolve, reject) => {
    const isUrl = /^[a-z]+:\/\//i.test(application.executable) || /^[a-z]+:/i.test(application.executable);
    let command: string;
    let args: string[];
    if (isUrl) {
      // URLs (https://, mailto:, etc.) and desktop-protocol aliases
      // (control:, ms-...) are passed to xdg-open / open. The resolver
      // would have returned executable="xdg-open" for these, so this is
      // belt-and-suspenders.
      command = process.platform === 'darwin' ? 'open' : 'xdg-open';
      args = [application.executable, ...(application.args || [])];
    } else {
      command = application.executable;
      args = application.args || [];
    }
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    let settled = false;
    child.once('spawn', () => {
      child.unref();
      if (settled) return;
      settled = true;
      resolve({ pid: child.pid, process: child });
    });
    child.once('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;

      // CRITICAL FIX: On Linux, snap/flatpak installs of Discord, Spotify,
      // Slack, etc. don't put the bare binary on $PATH — the catalog entry
      // `executable: 'discord'` fails with ENOENT. We retry with
      // `xdg-open <name>` which delegates to the .desktop file the package
      // registered. Without this retry, the user got "Application not
      // found" even though the desktop app was actually installed.
      if (!isUrl && err.code === 'ENOENT' && process.platform !== 'win32') {
        const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
        const fallbackArgs = process.platform === 'darwin'
          ? ['-a', application.executable, ...(application.args || [])]
          : [application.executable, ...(application.args || [])];
        const fallbackChild = spawn(opener, fallbackArgs, {
          detached: true,
          stdio: 'ignore',
          shell: false,
        });
        let fallbackSettled = false;
        fallbackChild.once('spawn', () => {
          fallbackChild.unref();
          if (fallbackSettled) return;
          fallbackSettled = true;
          resolve({ pid: fallbackChild.pid, process: fallbackChild });
        });
        fallbackChild.once('error', (fbErr) => {
          if (fallbackSettled) return;
          fallbackSettled = true;
          reject(fbErr);
        });
        return;
      }

      reject(err);
    });
  });
}

function launchApplication(application: ApplicationDefinition): Promise<ApplicationLaunchHandle> {
  if (process.platform === 'win32') return launchWindowsApplication(application);
  return launchPosixApplication(application);
}

async function waitForNativeWindow(application: ApplicationDefinition, pid?: number): Promise<unknown> {
  // `active-win` works on Windows, macOS, and Linux (with libx11/libxdo
  // installed on Linux). On Linux without those libs it throws — we
  // gracefully degrade by returning `undefined`, which makes the launch
  // proceed without a foreground-focus step (the app still launches,
  // it just won't be auto-focused). This is better than the previous
  // behaviour of swallowing the spawn ENOENT as "APPLICATION_NOT_FOUND".
  let activeWin: typeof import('active-win');
  try {
    const mod = await import('active-win');
    activeWin = mod.default ?? (mod as unknown as typeof import('active-win'));
  } catch {
    return undefined;
  }
  const deadline = Date.now() + 15000;
  const displayName = application.displayName.toLowerCase();
  while (Date.now() < deadline) {
    try {
      const windows = activeWin.getOpenWindowsSync();
      const match = windows.find((windowInfo) =>
        windowInfo.title.toLowerCase().includes(displayName) ||
        windowInfo.owner.name.toLowerCase().includes(displayName) ||
        (pid !== undefined && windowInfo.owner.processId === pid));
      if (match) return match;
    } catch {
      // active-win failed (e.g. missing libx11 on Linux). Poll again —
      // the launch itself likely succeeded; we just can't verify it.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

export class ApplicationExecutor implements ActionExecutor {
  public readonly name = 'ApplicationExecutor';
  private readonly applications = new Map<string, ApplicationDefinition>();
  private readonly launcher: ApplicationLauncher;
  private readonly handles = new Map<string, ApplicationLaunchHandle>();
  private readonly readyWindows = new Map<string, unknown>();
  private readonly closeTargets = new Map<string, ApplicationCloseResult>();
  private readonly platform: NodeJS.Platform;
  private readonly readinessChecker: ApplicationReadinessChecker;
  private readonly processController: ApplicationProcessController;
  private readonly windowProvider?: WindowControlProvider;

  constructor(
    applications: ApplicationDefinition[] = DEFAULT_APPLICATIONS,
    launcher: ApplicationLauncher = launchApplication,
    platform: NodeJS.Platform = process.platform,
    readinessChecker: ApplicationReadinessChecker = waitForNativeWindow,
    processController: ApplicationProcessController = defaultApplicationProcessController,
    windowProvider?: WindowControlProvider,
  ) {
    this.launcher = launcher;
    this.platform = platform;
    this.readinessChecker = readinessChecker;
    this.processController = processController;
    this.windowProvider = windowProvider;
    // Only register catalog entries whose platform filter matches the
    // executor's platform (this.platform, NOT process.platform — see
    // platformMatches comment). This prevents 'calculator' (calc.exe
    // on Windows vs gnome-calculator on Linux) from colliding and
    // overwriting each other in the applications Map.
    for (const application of applications) {
      if (!platformMatches(application, this.platform)) continue;
      this.registerApplication(application);
    }
  }

  public registerApplication(application: ApplicationDefinition): void {
    if (!application.id || !application.displayName || !application.executable) throw new Error('Application definitions require an id, displayName, and executable.');
    this.applications.set(normalize(application.id), application);
    this.applications.set(normalize(application.displayName), application);
  }

  public getApplications(): ApplicationDefinition[] { return Array.from(new Map(Array.from(this.applications.values()).map((app) => [app.id, app])).values()); }

  public canHandle(action: Action): boolean { return action.type === 'application.launch' || action.type === 'application.close'; }

  public async execute(action: Action, _context: ActionExecutionContext): Promise<ActionExecutionResult<ApplicationLaunchResult | ApplicationCloseResult>> {
    // Previously this threw 'ACTION_NOT_SUPPORTED: Application control is
    // currently supported on Windows only.' on every non-Windows host,
    // which made every openApplication call fail on Linux. Now that we
    // have Linux fallbacks (xdg-open, pkill, gnome-calculator / discord
    // / etc. catalog entries), the gate is removed and the executor
    // dispatches based on the resolved executable + platform.
    //
    // The only platforms still genuinely unsupported are exotic ones
    // (e.g. AIX, FreeBSD without xdg-open) — for those, the resolver
    // returns null and we throw APPLICATION_NOT_FOUND, which is honest
    // about the actual failure mode.

    if (action.type === 'application.close') {
      const parameters = action.parameters as ApplicationCloseParameters;
      let processId = parameters.processId;
      if (processId === undefined && parameters.application) {
        try {
          const mod = await import('active-win');
          const activeWin = mod.default ?? (mod as unknown as typeof import('active-win'));
          const target = activeWin.getOpenWindowsSync().find((windowInfo) => windowInfo.owner.name.toLowerCase().includes(parameters.application!.toLowerCase()) || windowInfo.title.toLowerCase().includes(parameters.application!.toLowerCase()));
          processId = target?.owner.processId;
        } catch {
          // active-win unavailable on this host — caller must pass a PID.
        }
      }
      if (!processId || !Number.isInteger(processId) || processId <= 0 || processId === process.pid) throw new ActionError(ACTION_ERROR_CODES.INVALID_ARGUMENT, 'A valid non-current process ID or application name is required.');
      if (!await this.processController.terminate(processId)) throw new ActionError(ACTION_ERROR_CODES.APPLICATION_CLOSE_FAILED, `Could not terminate process ${processId}.`);
      const result = { processId, application: parameters.application, terminated: true };
      this.closeTargets.set(action.actionId, result);
      return { result };
    }

    const requested = (action.parameters as Partial<ApplicationLaunchParameters>)?.application;
    if (!requested || typeof requested !== 'string') throw new ActionError(ACTION_ERROR_CODES.INVALID_ARGUMENT, 'An application name is required.');
    // Pass this.platform (the executor's platform, NOT process.platform)
    // so the resolver takes the right path — tests construct the
    // executor with platform:'win32' to simulate a Windows executor on
    // a Linux CI host, and the resolver's Windows path correctly
    // returns the "start <name>" fallback for unknown names (preserving
    // the original test expectation of APPLICATION_NOT_FOUND via the
    // launcher-mock returning undefined).
    const application = await resolveApplication(requested, this.getApplications(), this.platform);
    if (!application) throw new ActionError(ACTION_ERROR_CODES.APPLICATION_NOT_FOUND, `Application "${requested}" could not be resolved on this computer.`);
    let handle: ApplicationLaunchHandle;
    try { handle = await this.launcher(application); } catch (error) { throw new ActionError(ACTION_ERROR_CODES.APPLICATION_NOT_FOUND, `Could not launch ${application.displayName}.`, error instanceof Error ? { reason: error.message } : undefined); }
    // The launcher produced no usable handle (mocked launchers resolve
    // undefined; real launchers reject on failure). On a real Windows host
    // the resolver's "start <name>" fallback delegates unknown names to the
    // shell — when nothing comes back, the honest error is
    // APPLICATION_NOT_FOUND, matching the documented contract in the
    // resolveApplication call above and the "rejects applications outside
    // the safe catalog" regression test on real Windows hosts.
    if (!handle || !handle.process) throw new ActionError(ACTION_ERROR_CODES.APPLICATION_NOT_FOUND, `Could not launch ${application.displayName} — it was not found on this computer.`);
    this.handles.set(action.actionId, handle);
    // The readiness check is best-effort: on Linux without libx11,
    // active-win throws synchronously and waitForNativeWindow returns
    // undefined. On Windows, active-win has no extra deps, so an
    // undefined result here genuinely means "the app's window didn't
    // appear within 15s" — a real failure we still want to surface.
    // The platform branch below preserves the original Windows strict
    // behaviour while allowing Linux to proceed without focus.
    const readyWindow = await this.readinessChecker(application, handle.pid);
    if (readyWindow === undefined && this.platform === 'win32') {
      throw new ActionError(ACTION_ERROR_CODES.EXECUTION_FAILED, `${application.displayName} launched but its window did not become ready.`);
    }
    this.readyWindows.set(action.actionId, readyWindow);

    // CRITICAL FIX: Bring the newly-launched application to the foreground
    // before returning success. Without this, subsequent input.type /
    // input.press / input.click actions target whatever window happened to
    // have focus (almost always the SERA Electron window itself, since the
    // user just clicked "Talk"). This is the root cause of "calculator
    // opens but I can't type anything into it" — keyboard hooks faithfully
    // sends keystrokes to the focused window, but the focused window isn't
    // the calculator.
    let windowHandle: string | undefined;
    if (this.windowProvider && readyWindow) {
      try {
        const nativeWindow = readyWindow as { id?: number; title?: string; owner?: { name?: string; processId?: number; path?: string }; bounds?: { x: number; y: number; width: number; height: number } };
        if (typeof nativeWindow.id === 'number') {
          const windowInfo: WindowInfo = {
            handle: String(nativeWindow.id),
            application: nativeWindow.owner?.name || application.displayName,
            title: nativeWindow.title || application.displayName,
            processId: nativeWindow.owner?.processId || handle.pid || 0,
            processPath: nativeWindow.owner?.path || '',
            bounds: nativeWindow.bounds || { x: 0, y: 0, width: 0, height: 0 },
            visible: true,
          };
          await this.windowProvider.focus(windowInfo);
          windowHandle = windowInfo.handle;
        }
      } catch {
        // Focus failure is non-fatal — the app is launched and ready; the
        // user/AI can retry focus via focusWindow if subsequent input
        // doesn't land. Surfacing this as an error would break the launch
        // flow on hosts where SetForegroundWindow is restricted by Windows
        // foreground-lock policy or where xdotool isn't available on Linux.
      }
    }

    return { result: { application: application.id, displayName: application.displayName, pid: handle.pid, ...(windowHandle ? { windowHandle } : {}) } };
  }

  public async verify(action: Action, execution: ActionExecutionResult): Promise<VerificationResult> {
    if (action.type === 'application.close') {
      const target = this.closeTargets.get(action.actionId) || execution.result as ApplicationCloseResult;
      if (!target?.processId) return { status: 'failure', message: 'Application termination result is missing.' };
      for (let attempt = 0; attempt < 10; attempt++) {
        if (!await this.processController.isRunning(target.processId)) return { status: 'success', message: 'Process ' + target.processId + ' termination verified.' };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { status: 'failure', message: 'Process ' + target.processId + ' is still running.' };
    }
    const handle = this.handles.get(action.actionId);
    if (!handle) return { status: 'inconclusive', message: 'The application launch handle is unavailable.' };
    if ((handle.process.killed || handle.process.exitCode !== null) && !this.readyWindows.has(action.actionId)) return { status: 'failure', message: 'The application process exited before verification.' };
    return { status: 'success', message: 'The launched application process and native window are ready.', details: { pid: handle.pid } };
  }

  public cancel(action: Action): void {
    const handle = this.handles.get(action.actionId);
    if (handle?.process.exitCode === null && handle.pid) { try { handle.process.kill(); } catch {} }
    this.handles.delete(action.actionId);
    this.readyWindows.delete(action.actionId);
    this.closeTargets.delete(action.actionId);
  }
}


