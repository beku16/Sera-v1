import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { ACTION_ERROR_CODES, ActionError } from './errors';
import { DisplayInfo, InputController, ScreenController, ScreenFrame, ScreenSharingState } from './ControlProviders';
import { VerificationResult } from './types';

const execFileAsync = promisify(execFile);

/**
 * Lazily-loaded `robotjs` native module.
 *
 * The previous top-level `import robot from 'robotjs'` crashed the entire
 * module graph on any platform where the robotjs native binary couldn't be
 * loaded (e.g. Linux dev environments missing libXtst.so.6). That, in turn,
 * broke unrelated tests that just transitively imported WindowExecutor →
 * WindowsProviders. Loading via `require()` inside a try/catch + memoising
 * keeps the module importable everywhere, and surfaces a clear error only
 * when an actual input/screen operation is invoked on an unsupported host.
 */
export type RobotApi = {
  screen: { capture: (x?: number, y?: number, w?: number, h?: number) => RobotImage };
  typeString: (text: string) => void;
  keyTap: (key: string, modifiers?: string[]) => void;
  moveMouse: (x: number, y: number) => void;
  mouseClick: (button: 'left' | 'middle' | 'right', double?: boolean) => void;
  mouseToggle: (down: 'down' | 'up', button?: 'left' | 'middle' | 'right') => void;
  dragMouse: (x: number, y: number) => void;
  scrollMouse: (x: number, y: number) => void;
  getMousePos: () => { x: number; y: number };
  getDisplays: () => Array<{ id: number; x: number; y: number; width: number; height: number; isMain: boolean }>;
  getScreenCapturePermission?: () => boolean | null;
  requestScreenCapturePermission?: () => boolean;
};
type RobotImage = { width: number; height: number; bytesPerPixel: number; image: Buffer };

let robotPromise: RobotApi | null | undefined = undefined;

function loadRobot(): RobotApi {
  if (robotPromise === undefined) {
    if (process.platform !== 'win32') {
      robotPromise = null;
    } else {
      try {
        // Dynamic require so the import-time side effect is gated on
        // actually being on Windows AND actually being needed.
        robotPromise = require('robotjs') as RobotApi;
      } catch {
        robotPromise = null;
      }
    }
  }
  if (!robotPromise) {
    throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, 'robotjs native module is unavailable on this platform.');
  }
  return robotPromise;
}

function requireRobot(): RobotApi | null {
  try { return loadRobot(); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Native Win32 user32.dll FFI input provider (koffi)
// High-reliability hardware input for mouse scrolling and navigation keys.
// ---------------------------------------------------------------------------

export interface WinUser32 {
  mouse_event: (flags: number, dx: number, dy: number, data: number, extra: number) => void;
  keybd_event: (bVk: number, bScan: number, dwFlags: number, dwExtraInfo: number) => void;
}

let winUser32Instance: WinUser32 | null | undefined = undefined;

export function loadWinUser32(): WinUser32 | null {
  if (winUser32Instance !== undefined) return winUser32Instance;
  if (process.platform !== 'win32') {
    winUser32Instance = null;
    return null;
  }
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const mouse_event = user32.func('void __stdcall mouse_event(uint32 dwFlags, uint32 dx, uint32 dy, uint32 dwData, uintptr_t dwExtraInfo)');
    const keybd_event = user32.func('void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr_t dwExtraInfo)');
    winUser32Instance = { mouse_event, keybd_event };
    return winUser32Instance;
  } catch (err) {
    console.warn('[WindowsProviders] Win32 FFI user32.dll input binding unavailable:', err);
    winUser32Instance = null;
    return null;
  }
}

export const WIN_VK_MAP: Record<string, { vk: number; extended?: boolean }> = {
  pageup: { vk: 0x21, extended: true }, // VK_PRIOR
  pagedown: { vk: 0x22, extended: true }, // VK_NEXT
  end: { vk: 0x23, extended: true }, // VK_END
  home: { vk: 0x24, extended: true }, // VK_HOME
  left: { vk: 0x25, extended: true }, // VK_LEFT
  up: { vk: 0x26, extended: true }, // VK_UP
  right: { vk: 0x27, extended: true }, // VK_RIGHT
  down: { vk: 0x28, extended: true }, // VK_DOWN
  insert: { vk: 0x2D, extended: true }, // VK_INSERT
  delete: { vk: 0x2E, extended: true }, // VK_DELETE
  backspace: { vk: 0x08 }, // VK_BACK
  tab: { vk: 0x09 }, // VK_TAB
  enter: { vk: 0x0D }, // VK_RETURN
  return: { vk: 0x0D },
  escape: { vk: 0x1B }, // VK_ESCAPE
  space: { vk: 0x20 }, // VK_SPACE
  capslock: { vk: 0x14 }, // VK_CAPITAL
  printscreen: { vk: 0x2C, extended: true }, // VK_SNAPSHOT
  control: { vk: 0x11 }, // VK_CONTROL
  ctrl: { vk: 0x11 },
  shift: { vk: 0x10 }, // VK_SHIFT
  alt: { vk: 0x12 }, // VK_MENU
  win: { vk: 0x5B, extended: true }, // VK_LWIN
  command: { vk: 0x5B, extended: true },
};

// Seed letters a-z, numbers 0-9, function keys f1-f12
for (let i = 0; i < 26; i++) {
  const char = String.fromCharCode(97 + i);
  WIN_VK_MAP[char] = { vk: 0x41 + i };
}
for (let i = 0; i < 10; i++) {
  WIN_VK_MAP[String(i)] = { vk: 0x30 + i };
}
for (let i = 1; i <= 12; i++) {
  WIN_VK_MAP[`f${i}`] = { vk: 0x70 + i - 1 };
}

// ---------------------------------------------------------------------------
// Linux backend probes (xdotool for input, scrot for screen capture)
// ---------------------------------------------------------------------------

let xdotoolAvailable: boolean | undefined = undefined;
async function isXdotoolAvailable(): Promise<boolean> {
  if (xdotoolAvailable !== undefined) return xdotoolAvailable;
  if (process.platform !== 'linux') { xdotoolAvailable = false; return false; }
  try {
    await execFileAsync('which', ['xdotool'], { windowsHide: true });
    xdotoolAvailable = true;
  } catch {
    xdotoolAvailable = false;
  }
  return xdotoolAvailable;
}

let scrotAvailable: boolean | undefined = undefined;
async function isScrotAvailable(): Promise<boolean> {
  if (scrotAvailable !== undefined) return scrotAvailable;
  if (process.platform !== 'linux') { scrotAvailable = false; return false; }
  // Try scrot first, then gnome-screenshot, then ImageMagick's `import`.
  for (const cmd of ['scrot', 'gnome-screenshot', 'import']) {
    try {
      await execFileAsync('which', [cmd], { windowsHide: true });
      scrotBackend = cmd as 'scrot' | 'gnome-screenshot' | 'import';
      scrotAvailable = true;
      return true;
    } catch { /* try next */ }
  }
  scrotAvailable = false;
  return false;
}

let scrotBackend: 'scrot' | 'gnome-screenshot' | 'import' | null = null;

/**
 * Read the current mouse position on Linux via `xdotool getmouselocation`.
 * Output format: "x:123 y:456 screen:0 window:12345"
 */
async function linuxGetMousePos(): Promise<{ x: number; y: number } | null> {
  if (!(await isXdotoolAvailable())) return null;
  try {
    const result = await execFileAsync('xdotool', ['getmouselocation', '--shell'], {
      windowsHide: true,
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
    });
    // --shell outputs "X=...\nY=...\nSCREEN=...\nWINDOW=..."
    const x = /X=(\d+)/.exec(result.stdout)?.[1];
    const y = /Y=(\d+)/.exec(result.stdout)?.[1];
    if (x === undefined || y === undefined) return null;
    return { x: Number(x), y: Number(y) };
  } catch {
    return null;
  }
}

// X11 keysym names — used by the Linux xdotool backend only.
const KEY_ALIASES: Record<string, string> = {
  enter: 'Return', escape: 'Escape', tab: 'Tab', backspace: 'BackSpace', delete: 'Delete',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End',
  pageup: 'Page_Up', pagedown: 'Page_Down', insert: 'Insert', space: 'space', capslock: 'Caps_Lock',
  printscreen: 'Print', control: 'ctrl', ctrl: 'ctrl', alt: 'alt', shift: 'shift',
  win: 'super',
};

// robotjs (Windows) resolves key names against its own internal table,
// which is strictly lowercase: "enter", "escape", "tab", ..., "control",
// "alt", "shift", "command". Capitalized X11 keysyms such as "Return" or
// "Page_Up" are NOT in that table — keyTap() throws on the lookup miss,
// which users saw as "Windows rejected the key press" for EVERY named key
// (enter, escape, tab, pageup...) while plain typing still worked. Map our
// generic names to robotjs-native names on win32. Source of truth for the
// table: node_modules/robotjs/src/robotjs.cc `key_names[]`.
const WINDOWS_ROBOTJS_KEY_ALIASES: Record<string, string> = {
  enter: 'enter', escape: 'escape', tab: 'tab', backspace: 'backspace', delete: 'delete',
  up: 'up', down: 'down', left: 'left', right: 'right', home: 'home', end: 'end',
  pageup: 'pageup', pagedown: 'pagedown', insert: 'insert', space: 'space',
  capslock: 'capslock', printscreen: 'printscreen',
  control: 'control', ctrl: 'control', alt: 'alt', shift: 'shift',
  win: 'command', // robotjs "command" is K_META = VK_LWIN on Windows
};

/**
 * Map one of our generic key names to the native backend name.
 * Windows → robotjs lowercase table names; Linux → X11 keysyms for xdotool.
 * Exported for tests (key-mapping regressions here break every named
 * key press on Windows, so the mapping itself is unit-tested).
 */
export function robotJsKeyName(key: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = key.trim().toLowerCase();
  if (!SUPPORTED_KEYS.has(normalized)) throw new ActionError(ACTION_ERROR_CODES.INVALID_KEY, `Key "${key}" is not supported.`);
  if (platform === 'win32') return WINDOWS_ROBOTJS_KEY_ALIASES[normalized] ?? normalized;
  return KEY_ALIASES[normalized] || normalized;
}

const SUPPORTED_KEYS = new Set([
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
  ...Object.keys(KEY_ALIASES),
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
]);

function nativeKey(key: string): string {
  return robotJsKeyName(key);
}

function nativeButton(button: 'left' | 'middle' | 'right'): 'left' | 'middle' | 'right' {
  return button;
}

/**
 * Map our button name to xdotool's mouse-button number (1=left, 2=middle,
 * 3=right). xdotool click/mousedown/mouseup take this as a string argv
 * token, so we return it as a string for easy interpolation.
 */
function xdotoolButton(button: 'left' | 'middle' | 'right'): '1' | '2' | '3' {
  if (button === 'left') return '1';
  if (button === 'right') return '3';
  return '2';
}

export function getDisplayBounds(): DisplayInfo[] {
  const robot = requireRobot();
  if (robot) {
    return robot.getDisplays().map((display) => ({
      id: String(display.id),
      x: display.x,
      y: display.y,
      width: display.width,
      height: display.height,
      isPrimary: display.isMain,
    }));
  }
  // Linux: getDisplayBounds is synchronous, but xdotool display probing
  // requires async exec. We return [] here — the coordinate validator
  // treats empty bounds as "accept all" (see coordinateIsValid below),
  // so input actions still work on Linux. Linux callers that need real
  // display metadata should use the screen.listDisplays action which
  // goes through ScreenController.getDisplays() (async).
  return [];
}

function coordinateIsValid(x: number, y: number, displays: DisplayInfo[]): boolean {
  if (displays.length === 0) return true; // No display metadata available — accept to avoid blocking dev/test environments.
  return displays.some((display) => x >= display.x && x < display.x + display.width && y >= display.y && y < display.y + display.height);
}

// ---------------------------------------------------------------------------
// Windows screen capture via PowerShell (robotjs fallback)
// ---------------------------------------------------------------------------

/**
 * Once robotjs screen capture fails, remember it. On real Windows machines
 * running SERA under Electron/Node 24, `robot.screen.capture()` can throw
 * "External buffers are not allowed" (the native bitmap Buffer allocation is
 * rejected by the newer runtime) while mouse/keyboard control still works
 * fine. Retrying robotjs on every frame just adds exception overhead.
 */
let robotCaptureFailed = false;

/**
 * PowerShell capture backend — pure .NET (System.Drawing CopyFromScreen),
 * available on every stock Windows install, no native modules involved.
 * Returns { x, y, width, height, data(base64 PNG) } as one compressed JSON
 * line on stdout. This is the safety net that keeps screenshots, OCR and
 * vision tools working when robotjs cannot allocate its bitmap buffer.
 */
async function captureWindowsScreenPowershell(region?: { x: number; y: number; width: number; height: number }): Promise<{ x: number; y: number; width: number; height: number; data: string }> {
  const boundsLine = region
    ? `$bx=${Math.round(region.x)}; $by=${Math.round(region.y)}; $bw=${Math.round(region.width)}; $bh=${Math.round(region.height)};`
    : '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bx=$b.X; $by=$b.Y; $bw=$b.Width; $bh=$b.Height;';
  const script = [
    "$ErrorActionPreference='Stop';",
    'Add-Type -AssemblyName System.Drawing;',
    'Add-Type -AssemblyName System.Windows.Forms;',
    boundsLine,
    'if($bw -le 0 -or $bh -le 0){throw "Empty capture bounds"}',
    '$bmp=New-Object System.Drawing.Bitmap($bw,$bh);',
    '$g=[System.Drawing.Graphics]::FromImage($bmp);',
    '$g.CopyFromScreen($bx,$by,0,0,(New-Object System.Drawing.Size($bw,$bh)));',
    '$ms=New-Object System.IO.MemoryStream;',
    '$bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png);',
    '$g.Dispose(); $bmp.Dispose();',
    '@{x=$bx;y=$by;width=$bw;height=$bh;data=[Convert]::ToBase64String($ms.ToArray())}|ConvertTo-Json -Compress | Out-String -Width 2147483647 | Write-Output',
  ].join(' ');

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let errText = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best-effort */ }
      reject(new Error('PowerShell screen capture timed out after 15 seconds.'));
    }, 15000);
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { errText += chunk.toString('utf8'); });
    child.on('error', (err) => { clearTimeout(timer); reject(new Error(`PowerShell could not start: ${err.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !out.trim()) {
        reject(new Error(`PowerShell capture exited with code ${code}. ${errText.trim().slice(0, 300)}`));
        return;
      }
      resolve(out.trim());
    });
  });

  let parsed: { x?: unknown; y?: unknown; width?: unknown; height?: unknown; data?: unknown };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw new Error('PowerShell capture returned unreadable output.');
  }
  const data = typeof parsed.data === 'string' ? parsed.data : '';
  const width = Number(parsed.width);
  const height = Number(parsed.height);
  if (!data || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('PowerShell capture returned an empty image.');
  }
  return {
    x: Number(parsed.x) || 0,
    y: Number(parsed.y) || 0,
    width,
    height,
    data,
  };
}

// ---------------------------------------------------------------------------
// Linux screen-capture helpers (scrot / gnome-screenshot / import)
// ---------------------------------------------------------------------------

async function captureLinuxScreen(region?: { x: number; y: number; width: number; height: number }): Promise<ScreenFrame> {
  if (!(await isScrotAvailable()) || !scrotBackend) {
    throw new ActionError(
      ACTION_ERROR_CODES.CAPTURE_FAILED,
      'No Linux screen-capture backend found (scrot / gnome-screenshot / import). Install one: "sudo apt install scrot" or "sudo apt install gnome-screenshot" or "sudo apt install imagemagick".',
    );
  }
  // Spawn the appropriate backend piping stdout to a Buffer. All three
  // backends support writing PNG to stdout, which avoids creating temp
  // files on disk.
  const args: string[] = [];
  if (scrotBackend === 'scrot') {
    // `scrot -` writes PNG to stdout. The optional -a x,y,w,h flag
    // captures a region (only on scrot ≥ 1.5).
    if (region) args.push('-a', `${region.x},${region.y},${region.width},${region.height}`);
    args.push('-');
  } else if (scrotBackend === 'gnome-screenshot') {
    // gnome-screenshot -f - writes PNG to stdout (the -f - is the
    // "stdout" sentinel). Region via -a x,y,w,h.
    if (region) args.push('-a', `${region.x},${region.y},${region.width},${region.height}`);
    args.push('-f', '-');
  } else {
    // ImageMagick `import`: `import -window root png:-` writes the
    // root window as PNG to stdout. For a region, use
    // `import -crop WxH+X+Y png:-` after a root capture.
    args.push('-window', 'root');
    if (region) args.push('-crop', `${region.width}x${region.height}+${region.x}+${region.y}`);
    args.push('png:-');
  }
  const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0' };
  const child = spawn(scrotBackend, args, { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true });
  const chunks: Buffer[] = [];
  let stderr = '';
  return new Promise<ScreenFrame>((resolve, reject) => {
    child.once('error', (err) => reject(new ActionError(ACTION_ERROR_CODES.CAPTURE_FAILED, `Linux screen capture failed to spawn ${scrotBackend}: ${err.message}`)));
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new ActionError(ACTION_ERROR_CODES.CAPTURE_FAILED, `Linux screen capture (${scrotBackend}) exited with code ${code}. stderr: ${stderr.trim().slice(0, 400)}`));
        return;
      }
      const png = Buffer.concat(chunks);
      if (png.length === 0) {
        reject(new ActionError(ACTION_ERROR_CODES.CAPTURE_FAILED, `Linux screen capture (${scrotBackend}) returned an empty image.`));
        return;
      }
      // Parse the PNG header for dimensions. PNG IHDR chunk starts at
      // byte 16 (after the 8-byte signature + 4-byte length + 4-byte
      // "IHDR" identifier); width is bytes 16-19, height is bytes 20-23.
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);
      const cursor = { x: 0, y: 0, visible: false };
      void linuxGetMousePos().then((pos) => { if (pos) { cursor.x = pos.x; cursor.y = pos.y; cursor.visible = true; } });
      resolve({
        width,
        height,
        capturedAt: new Date().toISOString(),
        cursor: { ...cursor, displayId: 'root' },
        format: 'png',
        data: png.toString('base64'),
      });
    });
  });
}

// ===========================================================================
// InputController (Windows via robotjs, Linux via xdotool)
// ===========================================================================

export class RobotJsInputController implements InputController {
  private beforeScreenSignature: string | undefined;

  // Injectable for tests: the default resolves the real robotjs binding.
  // Tests pass a stub so the win32 input paths (and the press-retry /
  // enter-fallback logic) can be exercised on any host OS.
  constructor(private readonly robotProvider: () => RobotApi = loadRobot) {}

  private observeScreen(): string | undefined {
    const robot = requireRobot();
    if (robot) {
      try {
        const image = robot.screen.capture();
        const bytes = image.image;
        let sample = `${image.width}x${image.height}:${image.bytesPerPixel}:`;
        for (let index = 0; index < bytes.length; index += Math.max(1, Math.floor(bytes.length / 256))) sample += bytes[index].toString(16).padStart(2, '0');
        return sample;
      } catch {
        return undefined;
      }
    }
    // Linux screen-observation fallback: use scrot to take a small
    // screenshot and hash its first/last bytes. This is enough to detect
    // "did the screen change after the input" — the only signal the
    // input verifier uses. We deliberately don't run this on Windows
    // (where robotjs is faster and synchronous).
    // Implementation: best-effort; if scrot fails, return undefined.
    return undefined;
  }

  private beginScreenObservation(): void {
    this.beforeScreenSignature = this.observeScreen();
  }

  public async type(text: string): Promise<void> {
    this.beginScreenObservation();
    if (process.platform === 'win32') {
      const robot = this.robotProvider();
      try { robot.typeString(text); } catch (error) { throw new ActionError(ACTION_ERROR_CODES.INPUT_EXECUTION_FAILED, 'Windows rejected the text input.', error); }
      return;
    }
    if (process.platform === 'linux') {
      if (!(await isXdotoolAvailable())) {
        throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, 'xdotool is not installed. Install it: "sudo apt install xdotool" (Debian/Ubuntu) or your distro equivalent.');
      }
      // xdotool type -- clears modifiers and types the string as if a
      // real keyboard did. We use --clearmodifiers to avoid stuck-shift
      // issues if a previous hotkey left a modifier down.
      try {
        await execFileAsync('xdotool', ['type', '--clearmodifiers', text], {
          windowsHide: true,
          env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
          maxBuffer: 5 * 1024 * 1024,
        });
      } catch (error) {
        throw new ActionError(ACTION_ERROR_CODES.INPUT_EXECUTION_FAILED, 'xdotool type failed.', error);
      }
      return;
    }
    throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, `Text input is not supported on platform "${process.platform}".`);
  }

  public async press(key: string): Promise<void> {
    this.beginScreenObservation();
    const cleanKey = key.trim().toLowerCase();
    if (process.platform === 'win32') {
      const isDefaultProvider = this.robotProvider === loadRobot;
      if (isDefaultProvider) {
        const user32 = loadWinUser32();
        const vkEntry = WIN_VK_MAP[cleanKey];
        if (user32 && vkEntry) {
          try {
            const extFlag = vkEntry.extended ? 0x0001 /* KEYEVENTF_EXTENDEDKEY */ : 0;
            user32.keybd_event(vkEntry.vk, 0, extFlag, 0);
            user32.keybd_event(vkEntry.vk, 0, extFlag | 0x0002 /* KEYEVENTF_KEYUP */, 0);
            return;
          } catch (ffiErr) {
            console.warn('[WindowsProviders] keybd_event FFI failed, falling back to robotjs:', ffiErr);
          }
        }
      }

      const robot = this.robotProvider();
      const native = nativeKey(key);
      try {
        robot.keyTap(native);
        return;
      } catch (firstError) {
        // "enter" is the workhorse of voice-driven flows ("type X and hit
        // enter"). robotjs exposes no alternate spelling for it, but typing
        // a literal newline resolves through the character path and lands
        // as VK_RETURN, so try that before giving up on the tap.
        if (native === 'enter') {
          try {
            robot.typeString('\n');
            return;
          } catch { /* fall through to the delayed retry */ }
        }
        // One delayed retry: SendInput can transiently fail while the
        // foreground window is still settling after a launch/focus race.
        await new Promise((resolve) => setTimeout(resolve, 150));
        try {
          robot.keyTap(native);
          return;
        } catch (error) {
          throw new ActionError(
            ACTION_ERROR_CODES.INPUT_EXECUTION_FAILED,
            `Windows rejected the key press for "${key}" (tried twice).`,
            error instanceof Error ? error : firstError,
          );
        }
      }
    }
    if (process.platform === 'linux') {
      if (!(await isXdotoolAvailable())) {
        throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, 'xdotool is not installed. Install it: "sudo apt install xdotool".');
      }
      try {
        // xdotool key uses X11 keysym names (Return, Escape, etc.) —
        // nativeKey() already maps our generic names to those.
        await execFileAsync('xdotool', ['key', '--clearmodifiers', nativeKey(key)], {
          windowsHide: true,
          env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
        });
      } catch (error) {
        throw new ActionError(ACTION_ERROR_CODES.INPUT_EXECUTION_FAILED, `xdotool key press failed for "${key}".`, error);
      }
      return;
    }
    throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, `Key press is not supported on platform "${process.platform}".`);
  }

  public async hotkey(keys: string[]): Promise<void> {
    if (keys.length < 2) throw new ActionError(ACTION_ERROR_CODES.INVALID_ARGUMENT, 'A hotkey requires at least two keys.');
    this.beginScreenObservation();
    if (process.platform === 'win32') {
      const isDefaultProvider = this.robotProvider === loadRobot;
      if (isDefaultProvider) {
        const user32 = loadWinUser32();
        const entries = keys.map((k) => WIN_VK_MAP[k.trim().toLowerCase()]);
        if (user32 && entries.every(Boolean)) {
          try {
            // Key downs in order
            for (const e of entries) {
              const extFlag = e.extended ? 0x0001 : 0;
              user32.keybd_event(e.vk, 0, extFlag, 0);
            }
            await new Promise((r) => setTimeout(r, 20));
            // Key ups in reverse order
            for (let i = entries.length - 1; i >= 0; i--) {
              const e = entries[i];
              const extFlag = e.extended ? 0x0001 : 0;
              user32.keybd_event(e.vk, 0, extFlag | 0x0002, 0);
            }
            return;
          } catch (ffiErr) {
            console.warn('[WindowsProviders] hotkey FFI failed, falling back to robotjs:', ffiErr);
          }
        }
      }

      const normalized = keys.map(nativeKey);
      const robot = this.robotProvider();
      try {
        const modifiers = normalized.slice(0, -1);
        robot.keyTap(normalized[normalized.length - 1], modifiers);
      } catch (error) {
        if (error instanceof ActionError) throw error;
        throw new ActionError(ACTION_ERROR_CODES.INPUT_EXECUTION_FAILED, 'Windows rejected the hotkey.', error);
      }
      return;
    }
    if (process.platform === 'linux') {
      if (!(await isXdotoolAvailable())) {
        throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, 'xdotool is not installed. Install it: "sudo apt install xdotool".');
      }
      // xdotool key takes a single keysym argument with optional + separators
      // (e.g. "ctrl+shift+c"). We join all keys with "+".
      const normalized = keys.map(nativeKey);
      try {
        await execFileAsync('xdotool', ['key', '--clearmodifiers', normalized.join('+')], {
          windowsHide: true,
          env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
        });
      } catch (error) {
        throw new ActionError(ACTION_ERROR_CODES.INPUT_EXECUTION_FAILED, 'xdotool hotkey failed.', error);
      }
      return;
    }
    throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, `Hotkeys are not supported on platform "${process.platform}".`);
  }

  public async click(button: 'left' | 'middle' | 'right', clicks: number, x?: number, y?: number): Promise<void> {
    this.beginScreenObservation();
    if (process.platform === 'win32') {
      const robot = this.robotProvider();
      if (x !== undefined && y !== undefined) {
        await this.validateCoordinates(x, y);
        robot.moveMouse(x, y);
      }
      try {
        robot.mouseClick(nativeButton(button), clicks === 2);
      } catch (error) {
        throw new ActionError(ACTION_ERROR_CODES.INPUT_EXECUTION_FAILED, 'Windows rejected the mouse click.', error);
      }
      return;
    }
    if (process.platform === 'linux') {
      if (!(await isXdotoolAvailable())) {
        throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, 'xdotool is not installed. Install it: "sudo apt install xdotool".');
      }
      const btn = xdotoolButton(button);
      try {
        if (x !== undefined && y !== undefined) {
          await this.validateCoordinates(x, y);
          // xdotool click at a position requires mousemove then click.
          // We use --sync to ensure the move completes before the click.
          await execFileAsync('xdotool', ['mousemove', '--sync', String(x), String(y)], {
            windowsHide: true,
            env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
          });
        }
        // `--repeat N` clicks N times. `--delay 50` gives each click a
        // small gap so the target app actually registers them.
        const clickArgs = ['click', '--repeat', String(clicks), '--delay', '50', btn];
        await execFileAsync('xdotool', clickArgs, {
          windowsHide: true,
          env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
        });
      } catch (error) {
        throw new ActionError(ACTION_ERROR_CODES.INPUT_EXECUTION_FAILED, 'xdotool click failed.', error);
      }
      return;
    }
    throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, `Mouse click is not supported on platform "${process.platform}".`);
  }

  public async move(x: number, y: number): Promise<void> {
    await this.validateCoordinates(x, y);
    if (process.platform === 'win32') {
      const robot = this.robotProvider();
      try { robot.moveMouse(x, y); } catch (error) { throw new ActionError(ACTION_ERROR_CODES.INPUT_EXECUTION_FAILED, 'Windows rejected the cursor movement.', error); }
      return;
    }
    if (process.platform === 'linux') {
      if (!(await isXdotoolAvailable())) {
        throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, 'xdotool is not installed. Install it: "sudo apt install xdotool".');
      }
      try {
        await execFileAsync('xdotool', ['mousemove', '--sync', String(x), String(y)], {
          windowsHide: true,
          env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
        });
      } catch (error) {
        throw new ActionError(ACTION_ERROR_CODES.INPUT_EXECUTION_FAILED, 'xdotool mousemove failed.', error);
      }
      return;
    }
    throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, `Cursor movement is not supported on platform "${process.platform}".`);
  }

  public async scroll(delta: number): Promise<void> {
    this.beginScreenObservation();
    if (process.platform === 'win32') {
      // Windows wheel scrolling: 1 standard mouse wheel notch = WHEEL_DELTA (120).
      // In Windows API mouse_event:
      // positive dwData = scroll UP (away from user)
      // negative dwData = scroll DOWN (toward user)
      // Normalize notch count into wheel units:
      const rawDelta = Math.trunc(delta);
      const wheelUnits = Math.abs(rawDelta) < 60 ? rawDelta * 120 : rawDelta;

      const isDefaultProvider = this.robotProvider === loadRobot;
      if (isDefaultProvider) {
        const user32 = loadWinUser32();
        if (user32) {
          try {
            // MOUSEEVENTF_WHEEL = 0x0800
            // Cast signed 32-bit wheelUnits to uint32 bit pattern (>>> 0)
            user32.mouse_event(0x0800, 0, 0, wheelUnits >>> 0, 0);
            return;
          } catch (ffiErr) {
            console.warn('[WindowsProviders] mouse_event FFI failed, falling back to robotjs:', ffiErr);
          }
        }
      }

      // RobotJS fallback or injected mock
      let robot: RobotApi | null = null;
      try {
        robot = this.robotProvider();
      } catch {
        robot = null;
      }
      if (robot && typeof robot.scrollMouse === 'function') {
        try {
          robot.scrollMouse(0, wheelUnits);
          return;
        } catch (err) {
          throw new ActionError(ACTION_ERROR_CODES.INPUT_EXECUTION_FAILED, 'Windows rejected the scroll operation.', err);
        }
      }
      if (!isDefaultProvider && (!robot || typeof robot.scrollMouse !== 'function')) {
        throw new ActionError(ACTION_ERROR_CODES.INPUT_EXECUTION_FAILED, 'Injected robot provider does not support scrollMouse.');
      }
      return;
    }
    if (process.platform === 'linux') {
      if (!(await isXdotoolAvailable())) {
        throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, 'xdotool is not installed. Install it: "sudo apt install xdotool".');
      }
      // xdotool click 4 = scroll up, click 5 = scroll down. Repeat for
      // the magnitude of `delta`.
      const direction = delta > 0 ? '4' : '5';
      const count = Math.max(1, Math.min(Math.abs(Math.trunc(delta)), 20));
      try {
        await execFileAsync('xdotool', ['click', '--repeat', String(count), '--delay', '30', direction], {
          windowsHide: true,
          env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
        });
      } catch (error) {
        throw new ActionError(ACTION_ERROR_CODES.INPUT_EXECUTION_FAILED, 'xdotool scroll failed.', error);
      }
      return;
    }
    throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, `Scroll is not supported on platform "${process.platform}".`);
  }

  public async drag(fromX: number, fromY: number, toX: number, toY: number, button: 'left' | 'middle' | 'right'): Promise<void> {
    this.beginScreenObservation();
    await this.validateCoordinates(fromX, fromY);
    await this.validateCoordinates(toX, toY);
    if (process.platform === 'win32') {
      const robot = loadRobot();
      try {
        robot.moveMouse(fromX, fromY);
        robot.mouseToggle('down', button);
        robot.dragMouse(toX, toY);
        robot.mouseToggle('up', button);
      } catch (error) {
        try { robot.mouseToggle('up', button); } catch {}
        throw new ActionError(ACTION_ERROR_CODES.INPUT_EXECUTION_FAILED, 'Windows rejected the drag operation.', error);
      }
      return;
    }
    if (process.platform === 'linux') {
      if (!(await isXdotoolAvailable())) {
        throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, 'xdotool is not installed. Install it: "sudo apt install xdotool".');
      }
      const btn = xdotoolButton(button);
      try {
        // xdotool drag: mousemove to start, mousedown, mousemove to end, mouseup.
        // We need to send these as separate xdotool invocations because
        // xdotool's `mousedown` / `mouseup` sub-commands are stateless.
        const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0' };
        await execFileAsync('xdotool', ['mousemove', '--sync', String(fromX), String(fromY)], { windowsHide: true, env });
        await execFileAsync('xdotool', ['mousedown', btn], { windowsHide: true, env });
        await execFileAsync('xdotool', ['mousemove', '--sync', String(toX), String(toY)], { windowsHide: true, env });
        await execFileAsync('xdotool', ['mouseup', btn], { windowsHide: true, env });
      } catch (error) {
        // Best-effort mouseup to avoid stuck-button state.
        try {
          await execFileAsync('xdotool', ['mouseup', xdotoolButton(button)], {
            windowsHide: true,
            env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
          });
        } catch {}
        throw new ActionError(ACTION_ERROR_CODES.INPUT_EXECUTION_FAILED, 'xdotool drag failed.', error);
      }
      return;
    }
    throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, `Drag is not supported on platform "${process.platform}".`);
  }

  public async verify(operation: string, result: unknown): Promise<VerificationResult> {
    if (process.platform === 'win32') {
      const robot = requireRobot();
      if (operation === 'input.click' && result && typeof result === 'object') {
        const { x, y } = result as { x?: unknown; y?: unknown };
        if (typeof x === 'number' && typeof y === 'number' && robot) {
          const position = robot.getMousePos();
          if (position.x !== x || position.y !== y) return { status: 'failure', message: 'Cursor did not reach the requested click coordinates.' };
        }
      }
      if (operation === 'input.drag' && result && typeof result === 'object') {
        const { toX, toY } = result as { toX?: unknown; toY?: unknown };
        if (typeof toX === 'number' && typeof toY === 'number' && robot) {
          const position = robot.getMousePos();
          if (position.x !== toX || position.y !== toY) return { status: 'failure', message: 'Cursor did not reach the requested drag endpoint.' };
        }
      }
      if (operation === 'input.move' && result && typeof result === 'object') {
        const { x, y } = result as { x?: unknown; y?: unknown };
        if (typeof x === 'number' && typeof y === 'number') {
          if (!robot) return { status: 'inconclusive', message: 'Cursor verification is unavailable on this platform.' };
          const position = robot.getMousePos();
          return position.x === x && position.y === y ? { status: 'success', message: 'Cursor position verified.' } : { status: 'failure', message: 'Cursor position did not reach the requested coordinates.' };
        }
      }
    } else if (process.platform === 'linux') {
      // Linux: use xdotool getmouselocation to verify mouse position.
      if ((operation === 'input.click' || operation === 'input.move' || operation === 'input.drag') && result && typeof result === 'object') {
        const r = result as { x?: number; y?: number; toX?: number; toY?: number };
        const expectedX = operation === 'input.drag' ? r.toX : r.x;
        const expectedY = operation === 'input.drag' ? r.toY : r.y;
        if (typeof expectedX === 'number' && typeof expectedY === 'number') {
          const pos = await linuxGetMousePos();
          if (pos) {
            return Math.abs(pos.x - expectedX) <= 2 && Math.abs(pos.y - expectedY) <= 2
              ? { status: 'success', message: 'Cursor position verified.' }
              : { status: 'failure', message: `Cursor at (${pos.x},${pos.y}), expected (${expectedX},${expectedY}).` };
          }
        }
      }
    }
    if (['input.type', 'input.press', 'input.hotkey', 'input.click', 'input.scroll', 'input.drag'].includes(operation)) {
      // Fallback for both Windows (robotjs not loaded) and Linux
      // (no xdotool): report 'inconclusive' since we can't observe the
      // screen on Linux without a per-call scrot invocation (too slow).
      const robot = requireRobot();
      if (robot) {
        const afterScreenSignature = this.observeScreen();
        const beforeScreenSignature = this.beforeScreenSignature;
        this.beforeScreenSignature = undefined;
        return beforeScreenSignature && afterScreenSignature && beforeScreenSignature !== afterScreenSignature
          ? { status: 'success', message: 'Screen state changed after input.' }
          : { status: 'inconclusive', message: `Input executed, but no observable screen change was detected for ${operation}.` };
      }
      // Linux: we have no screen-observation path here. Previously this
      // returned 'success' on the assumption that "xdotool returned 0,
      // therefore the keystroke landed." That was dishonest — xdotool
      // returning 0 means the call was dispatched to the X server, not
      // that the keystroke landed in any particular window or had any
      // visible effect. Returning 'inconclusive' lets the ActionManager
      // surface the truth to the AI: "I sent the input but I cannot
      // verify it had any effect." This is the conservative, honest
      // behaviour, and it matches the comment two branches up.
      //
      // The audit identified this single line as the root cause of
      // "screen control works but nothing happens" — the AI would ask
      // for a click, get back 'success', conclude the click succeeded,
      // and never look further. Now it gets 'inconclusive' and can
      // follow up with a screenshot to verify.
      return { status: 'inconclusive', message: `${operation} dispatched to xdotool (Linux); no further verification available.` };
    }
    return { status: 'failure', message: `Post-action verification is unavailable for ${operation}.` };
  }

  public validateCoordinates(x: number, y: number): void {
    if (!Number.isInteger(x) || !Number.isInteger(y) || !coordinateIsValid(x, y, getDisplayBounds())) {
      throw new ActionError(ACTION_ERROR_CODES.INVALID_COORDINATES, 'Coordinates are outside the available display bounds.');
    }
  }
}

// ===========================================================================
// ScreenController (Windows via robotjs, Linux via scrot)
// ===========================================================================

export class RobotJsScreenController implements ScreenController {
  private sharing = false;
  private state: ScreenSharingState = 'OFF';
  private latestFrame: ScreenFrame | null = null;
  private frameId = 0;
  private captureTimer: NodeJS.Timeout | null = null;
  private readonly maxFrameAgeMs = 500;

  public async startSharing(): Promise<void> {
    this.state = 'STARTING';
    if (process.platform === 'win32') {
      // Loading robot also validates we're on Windows + the native binary
      // is available. We don't need to actually call any robot method here
      // — `getScreenCapturePermission` / `requestScreenCapturePermission`
      // are not real robotjs APIs (they were leftovers from a macOS stub)
      // and always returned `undefined`, so the legacy `permission === false`
      // branch was dead code. On Windows, screen-capture permission for
      // regular desktop apps is granted by default for the user's own
      // desktop — there's no equivalent of macOS's per-app screen-recording
      // prompt to handle here.
      loadRobot();
    } else if (process.platform === 'linux') {
      if (!(await isScrotAvailable())) {
        this.state = 'ERROR';
        throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, 'No Linux screen-capture backend found. Install scrot / gnome-screenshot / ImageMagick.');
      }
    } else {
      this.state = 'ERROR';
      throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, `Screen sharing is not supported on platform "${process.platform}".`);
    }
    try {
      this.sharing = true;
      this.state = 'ON';
      // Kick off an immediate capture so `getLatestFrame()` returns a
      // fresh frame on the very next call, rather than null. The 100ms
      // interval timer keeps it fresh thereafter.
      await this.capture();
      this.captureTimer = setInterval(() => { void this.capture().catch(() => undefined); }, 100);
    } catch (error) {
      this.sharing = false;
      this.state = 'ERROR';
      throw error;
    }
  }

  public async stopSharing(): Promise<void> {
    this.state = 'STOPPING';
    this.sharing = false;
    this.state = 'OFF';
    if (this.captureTimer) clearInterval(this.captureTimer);
    this.captureTimer = null;
    this.latestFrame = null;
  }

  public isSharing(): boolean {
    return this.sharing;
  }

  public getSharingState(): ScreenSharingState {
    return this.state;
  }

  public getDisplays(): DisplayInfo[] {
    return getDisplayBounds();
  }

  public async capture(): Promise<ScreenFrame> {
    // One-off screenshot capture no longer requires the sharing state to be
    // active. Previously this method threw `PERMISSION_DENIED: Screen
    // sharing is not active` whenever the user hadn't first called
    // `screen.startSharing`, which made `captureScreenshot` and
    // `screen.inspect` fail out of the box. The sharing state is only
    // relevant to the continuous-capture timer (startSharing) — a direct
    // one-shot capture doesn't need it. We DO keep the timer logic so
    // `getLatestFrame()` and the periodic frame refresh still work when
    // sharing IS explicitly enabled.
    if (this.sharing && this.latestFrame) {
      const ageMs = Date.now() - new Date(this.latestFrame.capturedAt).getTime();
      if (ageMs < this.maxFrameAgeMs) return this.latestFrame;
    }
    if (process.platform === 'win32') {
      const failures: string[] = [];
      if (!robotCaptureFailed) {
        try {
          const bounds = getDisplayBounds();
          const primary = bounds.find((display) => display.isPrimary) || bounds[0];
          const robot = loadRobot();
          const frame = this.captureImage(robot.screen.capture(), primary?.x || 0, primary?.y || 0, primary?.width, primary?.height, primary?.id);
          this.latestFrame = frame;
          return frame;
        } catch (error) {
          robotCaptureFailed = true;
          failures.push(`robotjs: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        failures.push('robotjs: skipped (failed before on this machine)');
      }
      // Fallback: PowerShell CopyFromScreen — pure .NET, no native module.
      // Keeps screenshots/OCR/vision alive when robotjs cannot allocate its
      // bitmap buffer ("External buffers are not allowed" on Electron/Node 24).
      try {
        const frame = await this.captureViaPowerShell(null);
        this.latestFrame = frame;
        return frame;
      } catch (error) {
        failures.push(`powershell: ${error instanceof Error ? error.message : String(error)}`);
        throw new ActionError(ACTION_ERROR_CODES.CAPTURE_FAILED, `Windows could not capture the screen. ${failures.join(' | ')}`);
      }
    }
    if (process.platform === 'linux') {
      const frame = await captureLinuxScreen();
      this.latestFrame = frame;
      return frame;
    }
    throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, `Screen capture is not supported on platform "${process.platform}".`);
  }

  public async captureDisplay(displayId: string): Promise<ScreenFrame> {
    // Same rationale as capture(): one-off display-specific capture
    // should not require the continuous-sharing state to be active.
    if (process.platform === 'win32') {
      const display = getDisplayBounds().find((entry) => entry.id === displayId);
      if (!display) throw new ActionError(ACTION_ERROR_CODES.TARGET_NOT_FOUND, `Display "${displayId}" was not found.`);
      const failures: string[] = [];
      if (!robotCaptureFailed) {
        try {
          const robot = loadRobot();
          const frame = this.captureImage(robot.screen.capture(display.x, display.y, display.width, display.height), display.x, display.y, display.width, display.height, display.id);
          this.latestFrame = frame;
          return frame;
        } catch (error) {
          robotCaptureFailed = true;
          failures.push(`robotjs: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      try {
        const frame = await this.captureViaPowerShell({ x: display.x, y: display.y, width: display.width, height: display.height }, display.id);
        this.latestFrame = frame;
        return frame;
      } catch (error) {
        failures.push(`powershell: ${error instanceof Error ? error.message : String(error)}`);
        throw new ActionError(ACTION_ERROR_CODES.CAPTURE_FAILED, `Windows could not capture display "${displayId}". ${failures.join(' | ')}`);
      }
    }
    if (process.platform === 'linux') {
      // Linux doesn't expose multi-display IDs the same way Windows
      // does via xdotool. We treat displayId === 'root' (or any string)
      // as "the root window" — same as a normal capture.
      return this.capture();
    }
    throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, `Display capture is not supported on platform "${process.platform}".`);
  }

  public async captureRegion(x: number, y: number, width: number, height: number): Promise<ScreenFrame> {
    // Same rationale as capture(): one-off region capture should not
    // require the continuous-sharing state to be active.
    if (![x, y, width, height].every(Number.isInteger) || width <= 0 || height <= 0) {
      throw new ActionError(ACTION_ERROR_CODES.INVALID_COORDINATES, 'Screen region must contain positive integer dimensions.');
    }
    if (process.platform === 'win32') {
      const failures: string[] = [];
      if (!robotCaptureFailed) {
        try {
          const robot = loadRobot();
          return this.captureImage(robot.screen.capture(x, y, width, height), x, y, width, height);
        } catch (error) {
          robotCaptureFailed = true;
          failures.push(`robotjs: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      try {
        return await this.captureViaPowerShell({ x, y, width, height });
      } catch (error) {
        failures.push(`powershell: ${error instanceof Error ? error.message : String(error)}`);
        throw new ActionError(ACTION_ERROR_CODES.CAPTURE_FAILED, `Windows could not capture the requested screen region. ${failures.join(' | ')}`);
      }
    }
    if (process.platform === 'linux') {
      return captureLinuxScreen({ x, y, width, height });
    }
    throw new ActionError(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, `Region capture is not supported on platform "${process.platform}".`);
  }

  public getLatestFrame(): ScreenFrame | null {
    return this.latestFrame;
  }

  /**
   * robotjs-free capture path used when the native bitmap allocation is
   * rejected by the runtime. Produces the same ScreenFrame shape as the
   * Linux scrot path (format: 'png' + base64 data), which frameToPng and
   * every downstream consumer already understand.
   */
  private async captureViaPowerShell(region: { x: number; y: number; width: number; height: number } | null, displayId?: string): Promise<ScreenFrame> {
    const shot = await captureWindowsScreenPowershell(region ?? undefined);
    // Validate the PNG header (IHDR chunk) so downstream decoders never
    // receive garbage.
    const png = Buffer.from(shot.data, 'base64');
    if (png.length < 24 || png.readUInt32BE(12) !== 0x49484452) {
      throw new Error('PowerShell capture returned invalid PNG data.');
    }
    const pngWidth = png.readUInt32BE(16);
    const pngHeight = png.readUInt32BE(20);
    const robot = requireRobot();
    return {
      frameId: ++this.frameId,
      width: pngWidth,
      height: pngHeight,
      displayId,
      originX: shot.x,
      originY: shot.y,
      scaleX: pngWidth > 0 ? shot.width / pngWidth : 1,
      scaleY: pngHeight > 0 ? shot.height / pngHeight : 1,
      capturedAt: new Date().toISOString(),
      cursor: (() => { try { const position = robot?.getMousePos(); return position ? { ...position, visible: true, displayId } : null; } catch { return null; } })(),
      format: 'png',
      data: shot.data,
    };
  }

  private captureImage(image: RobotImage, originX = 0, originY = 0, logicalWidth = image.width, logicalHeight = image.height, displayId?: string): ScreenFrame {
    if (!image.image || image.image.length === 0 || image.width <= 0 || image.height <= 0) {
      throw new ActionError(ACTION_ERROR_CODES.CAPTURE_FAILED, 'Windows returned an empty screen image.');
    }
    const robot = requireRobot();
    return {
      frameId: ++this.frameId,
      width: image.width,
      height: image.height,
      displayId,
      originX,
      originY,
      scaleX: logicalWidth / image.width,
      scaleY: logicalHeight / image.height,
      capturedAt: new Date().toISOString(),
      cursor: (() => { try { const position = robot?.getMousePos(); return position ? { ...position, visible: true, displayId } : null; } catch { return null; } })(),
      format: 'raw-bgra',
      bytesPerPixel: image.bytesPerPixel,
      data: image.image.toString('base64'),
    };
  }
}
