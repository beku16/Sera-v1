import { ACTION_ERROR_CODES, ActionError } from './errors';
import { Action, ActionExecutionContext, ActionExecutionResult, ActionExecutor, VerificationResult } from './types';
import { getDisplayBounds } from './WindowsProviders';
import { esmRequire, esmImport } from '../diagnostics/esmShim';

const require = esmRequire;

const IS_WINDOWS = process.platform === 'win32';
type NativeWindow = {
  platform: string;
  id: number;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  owner: { name: string; processId: number; path: string };
};
type ActiveWinApi = {
  sync(): NativeWindow | undefined;
  getOpenWindowsSync(): NativeWindow[];
};

type User32Api = {
  GetForegroundWindow(): number;
  SetForegroundWindow(handle: number): boolean;
  ShowWindow?(handle: number, command: number): boolean;
  BringWindowToTop?(handle: number): boolean;
  IsIconic?(handle: number): boolean;
  IsZoomed?(handle: number): boolean;
  PostMessage?(handle: number, message: number, wParam: number, lParam: number): boolean;
};

type ThreadFocusApi = {
  getCurrentThreadId(): number;
  getWindowThreadProcessId(handle: number, processId: Buffer): number;
  attachThreadInput(sourceThreadId: number, targetThreadId: number, attach: boolean): boolean;
  setForegroundWindow(handle: number): boolean;
};

export interface WindowInfo {
  handle: string;
  application: string;
  title: string;
  processId: number;
  processPath: string;
  bounds: { x: number; y: number; width: number; height: number };
  visible: boolean;
  minimized?: boolean;
  maximized?: boolean;
}

export interface WindowControlProvider {
  getActive(): Promise<WindowInfo | undefined>;
  list(): Promise<WindowInfo[]>;
  focus(windowInfo: WindowInfo): Promise<boolean>;
  getForegroundHandle(): Promise<string>;
  setState?(windowInfo: WindowInfo, state: 'minimized' | 'maximized' | 'restored'): Promise<boolean>;
  getState?(windowInfo: WindowInfo): Promise<'minimized' | 'maximized' | 'normal'>;
  close?(windowInfo: WindowInfo): Promise<boolean>;
}

function toWindowInfo(windowInfo: NativeWindow): WindowInfo {
  return {
    handle: String(windowInfo.id),
    application: windowInfo.owner.name,
    title: windowInfo.title,
    processId: windowInfo.owner.processId,
    processPath: windowInfo.owner.path,
    bounds: windowInfo.bounds,
    visible: true,
  };
}

export class WindowsWindowProvider implements WindowControlProvider {
  private readonly user32: User32Api;
  private readonly threadFocus: ThreadFocusApi;
  private readonly platformSupported: boolean;

  constructor(
    user32?: User32Api,
    threadFocus?: ThreadFocusApi
  ) {
    this.user32 = user32 ?? WindowsWindowProvider.loadUser32();
    this.threadFocus = threadFocus ?? WindowsWindowProvider.loadThreadFocus();
    // If the native modules failed to load (e.g. running on Linux for dev /
    // tests), the provider is constructed in an unsupported state. Method
    // calls will surface clear ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED
    // errors instead of crashing the import graph.
    this.platformSupported = IS_WINDOWS && !!user32 && !!threadFocus
      ? true
      : (user32 !== undefined && threadFocus !== undefined);
  }

  private static loadUser32(): User32Api {
    if (!IS_WINDOWS) return WindowsWindowProvider.unsupportedUser32();
    try {
      // Lazily loaded so non-Windows hosts can import the file without
      // crashing the module graph.
      const win32Api = require('win32-api');
      return win32Api.User32.load(['GetForegroundWindow', 'SetForegroundWindow', 'ShowWindow', 'BringWindowToTop', 'IsIconic', 'IsZoomed', 'PostMessage']);
    } catch (err) {
      return WindowsWindowProvider.unsupportedUser32(err);
    }
  }

  private static unsupportedUser32(err?: unknown): User32Api {
    const message = `Win32 user32 API is unavailable on this platform${err ? `: ${err instanceof Error ? err.message : String(err)}` : ''}`;
    const unsupported = () => { throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, message); };
    return {
      GetForegroundWindow: unsupported,
      SetForegroundWindow: unsupported,
      ShowWindow: unsupported,
      BringWindowToTop: unsupported,
      IsIconic: unsupported,
      IsZoomed: unsupported,
      PostMessage: unsupported,
    } as User32Api;
  }

  private static loadThreadFocus(): ThreadFocusApi {
    if (!IS_WINDOWS) return WindowsWindowProvider.unsupportedThreadFocus();
    try {
      const koffi = require('koffi');
      const user32Native = koffi.load('user32.dll');
      const kernel32Native = koffi.load('kernel32.dll');
      return {
        getCurrentThreadId: kernel32Native.func('uint32 GetCurrentThreadId()'),
        getWindowThreadProcessId: (handle: number, _processId: Buffer) => {
          const processId = Buffer.alloc(4);
          return user32Native.func('uint32 GetWindowThreadProcessId(void *hWnd, uint32 *lpdwProcessId)')(handle, processId);
        },
        attachThreadInput: user32Native.func('bool AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)'),
        setForegroundWindow: user32Native.func('bool SetForegroundWindow(void *hWnd)'),
      };
    } catch (err) {
      return WindowsWindowProvider.unsupportedThreadFocus(err);
    }
  }

  private static unsupportedThreadFocus(err?: unknown): ThreadFocusApi {
    const message = `Win32 thread-focus API is unavailable on this platform${err ? `: ${err instanceof Error ? err.message : String(err)}` : ''}`;
    const unsupported = () => { throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, message); };
    return {
      getCurrentThreadId: unsupported,
      getWindowThreadProcessId: unsupported,
      attachThreadInput: unsupported,
      setForegroundWindow: unsupported,
    } as ThreadFocusApi;
  }

  public async getActive(): Promise<WindowInfo | undefined> {
    const mod = (await esmImport('active-win')) as { default?: ActiveWinApi } & ActiveWinApi;
    const activeWin = mod?.default ?? mod;
    const active = typeof activeWin?.sync === 'function' ? activeWin.sync() : undefined;
    return active ? toWindowInfo(active) : undefined;
  }

  public async list(): Promise<WindowInfo[]> {
    const mod = (await esmImport('active-win')) as { default?: { getOpenWindowsSync?: () => NativeWindow[] }; getOpenWindowsSync?: () => NativeWindow[] };
    const activeWin = mod?.default ?? mod;
    const windows = typeof activeWin?.getOpenWindowsSync === 'function' ? activeWin.getOpenWindowsSync() : undefined;
    if (!Array.isArray(windows)) return [];
    return windows.map(toWindowInfo).filter((windowInfo) => windowInfo.title.trim().length > 0);
  }

  public async focus(windowInfo: WindowInfo): Promise<boolean> {
    const handle = Number(windowInfo.handle);
    this.user32.ShowWindow?.(handle, 9);
    this.user32.BringWindowToTop?.(handle);
    for (let attempt = 0; attempt < 3; attempt++) {
      this.user32.SetForegroundWindow(handle);
      if (await this.getForegroundHandle() === windowInfo.handle) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const foregroundHandle = Number(await this.getForegroundHandle());
    const foregroundThread = this.threadFocus.getWindowThreadProcessId(foregroundHandle, Buffer.alloc(4));
    const currentThread = this.threadFocus.getCurrentThreadId();
    if (foregroundThread && currentThread && this.threadFocus.attachThreadInput(currentThread, foregroundThread, true)) {
      try {
        this.threadFocus.setForegroundWindow(handle);
        this.user32.BringWindowToTop?.(handle);
        if (await this.getForegroundHandle() === windowInfo.handle) return true;
      } finally {
        this.threadFocus.attachThreadInput(currentThread, foregroundThread, false);
      }
    }
    return false;
  }

  public async getForegroundHandle(): Promise<string> {
    return String(this.user32.GetForegroundWindow());
  }

  public async setState(windowInfo: WindowInfo, state: 'minimized' | 'maximized' | 'restored'): Promise<boolean> {
    const command = state === 'minimized' ? 6 : state === 'maximized' ? 3 : 9;
    return this.user32.ShowWindow?.(Number(windowInfo.handle), command) !== false;
  }

  public async getState(windowInfo: WindowInfo): Promise<'minimized' | 'maximized' | 'normal'> {
    const handle = Number(windowInfo.handle);
    if (this.user32.IsIconic?.(handle)) return 'minimized';
    if (this.user32.IsZoomed?.(handle)) return 'maximized';
    const current = (await this.list()).find((entry) => entry.handle === windowInfo.handle);
    const displays = getDisplayBounds();
    if (current && displays.some((display) =>
      current.bounds.x <= display.x + 5 &&
      current.bounds.y <= display.y + 5 &&
      current.bounds.width >= display.width - 20 &&
      current.bounds.height >= display.height - 20
    )) return 'maximized';
    return 'normal';
  }

  public async close(windowInfo: WindowInfo): Promise<boolean> {
    return this.user32.PostMessage?.(Number(windowInfo.handle), 0x0010, 0, 0) === true;
  }
}

export class WindowExecutor implements ActionExecutor {
  public readonly name = 'WindowExecutor';

  constructor(private readonly provider: WindowControlProvider) {}

  public canHandle(action: Action): boolean {
    return action.type === 'window.getActive' || action.type === 'window.list' || action.type === 'window.focus' ||
      action.type === 'window.minimize' || action.type === 'window.maximize' || action.type === 'window.restore' || action.type === 'window.close';
  }

  public async execute(action: Action, _context: ActionExecutionContext): Promise<ActionExecutionResult> {
    try {
      if (action.type === 'window.getActive') return { result: await this.provider.getActive() || null };
      if (action.type === 'window.list') return { result: await this.provider.list() };

      const parameters = action.parameters as { handle?: string; processId?: number; title?: string; application?: string };
      const target = await this.findTarget(parameters);
      if (!target) throw new ActionError(ACTION_ERROR_CODES.TARGET_NOT_FOUND, 'The requested window was not found.');
      if (action.type === 'window.minimize' || action.type === 'window.maximize' || action.type === 'window.restore') {
        if (!this.provider.setState) throw new ActionError(ACTION_ERROR_CODES.ACTION_NOT_SUPPORTED, 'Window state control is not configured.');
        const state = action.type === 'window.minimize' ? 'minimized' : action.type === 'window.maximize' ? 'maximized' : 'restored';
        if (!await this.provider.setState(target, state)) throw new ActionError(ACTION_ERROR_CODES.EXECUTION_FAILED, `Windows rejected the ${state} request.`);
        return { result: { ...target, requestedState: state } };
      }
      if (action.type === 'window.close') {
        if (!this.provider.close) throw new ActionError(ACTION_ERROR_CODES.ACTION_NOT_SUPPORTED, 'Window close control is not configured.');
        if (!await this.provider.close(target)) throw new ActionError(ACTION_ERROR_CODES.EXECUTION_FAILED, 'Windows rejected the close request.');
        return { result: target };
      }
      if (!await this.provider.focus(target)) throw new ActionError(ACTION_ERROR_CODES.FOCUS_FAILED, 'Windows did not activate the requested window.');
      return { result: target };
    } catch (error) {
      if (error instanceof ActionError) throw error;
      throw new ActionError(ACTION_ERROR_CODES.EXECUTION_FAILED, 'Windows window operation failed.', error);
    }
  }

  public async verify(action: Action, execution: ActionExecutionResult): Promise<VerificationResult> {
    if (action.type === 'window.getActive') return execution.result ? { status: 'success', message: 'Active window metadata retrieved.' } : { status: 'inconclusive', message: 'No active window was reported.' };
    if (action.type === 'window.list') return Array.isArray(execution.result) ? { status: 'success', message: 'Visible windows enumerated.' } : { status: 'failure', message: 'Window enumeration returned an invalid result.' };

    if (action.type === 'window.minimize' || action.type === 'window.maximize' || action.type === 'window.restore') {
      if (!this.provider.getState) return { status: 'failure', message: 'Window state verification is not configured.' };
      const result = execution.result as WindowInfo & { requestedState?: string };
      const actual = await this.provider.getState(result);
      const expected = action.type === 'window.minimize' ? 'minimized' : action.type === 'window.maximize' ? 'maximized' : 'normal';
      return actual === expected
        ? { status: 'success', message: `Window ${expected} state verified.`, details: { handle: result.handle, state: actual } }
        : { status: 'failure', message: `Window state is ${actual}; expected ${expected}.`, details: { handle: result.handle, state: actual } };
    }

    if (action.type === 'window.close') {
      const result = execution.result as WindowInfo;
      const remaining = await this.provider.list();
      return remaining.some((windowInfo) => windowInfo.handle === result.handle)
        ? { status: 'failure', message: 'The requested window is still present.', details: { handle: result.handle } }
        : { status: 'success', message: 'Window closure verified.', details: { handle: result.handle, title: result.title } };
    }

    const target = execution.result as WindowInfo;
    return await this.provider.getForegroundHandle() === target.handle
      ? { status: 'success', message: 'Window focus verified.', details: { handle: target.handle, title: target.title } }
      : { status: 'failure', message: 'The requested window did not become active.' };
  }

  private async findTarget(parameters: { handle?: string; processId?: number; title?: string; application?: string }): Promise<WindowInfo | undefined> {
    const windows = await this.provider.list();
    const active = await this.provider.getActive();
    const candidates = active && !windows.some((windowInfo) => windowInfo.handle === active.handle) ? [...windows, active] : windows;
    if (parameters.handle) {
      if (active?.handle === parameters.handle) return active;
      return candidates.find((windowInfo) => windowInfo.handle === parameters.handle && windowInfo.visible);
    }
    if (parameters.processId !== undefined) return candidates.find((windowInfo) => windowInfo.processId === parameters.processId);
    const title = parameters.title?.trim().toLowerCase();
    const application = parameters.application?.trim().toLowerCase();
    const matching = candidates.filter((windowInfo) =>
      (!title || windowInfo.title.toLowerCase() === title) &&
      (!application || windowInfo.application.toLowerCase() === application || windowInfo.title.toLowerCase().includes(application))
    );
    return active && matching.some((windowInfo) => windowInfo.handle === active.handle) ? active : matching[0];
  }
}
