import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface ClipboardProvider {
  get(): Promise<string | null>;
  set(content: string): Promise<boolean>;
}

async function getClipboardWindows(): Promise<string | null> {
  try {
    // Get-Clipboard -Raw returns the clipboard as a single string. We
    // base64-encode INSIDE PowerShell so the result is always ASCII-safe
    // and the UTF-8 content round-trips cleanly through Node's child_process
    // stdout (which would otherwise mangle non-ASCII chars via Windows
    // console codepage translation).
    const result = await execAsync('powershell.exe -NoProfile -NonInteractive -Command "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Clipboard -Raw)))"', {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    const encoded = result.stdout.trim();
    return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : null;
  } catch {
    return null;
  }
}

async function setClipboardWindows(content: string): Promise<boolean> {
  // PREVIOUS BUG: The old implementation spawned
  //   powershell.exe -NoProfile -NonInteractive -Command "Set-Clipboard"
  // and wrote `content` to the child's stdin. This NEVER worked, because
  // PowerShell in `-Command` mode does not pipe stdin into the named cmdlet.
  // The `Set-Clipboard` cmdlet does accept pipeline input via its -Value
  // parameter, but PowerShell only constructs that pipeline from stdin
  // when invoked with `-Command -` (i.e. dash for stdin-as-script) or when
  // explicitly written as `$input | Set-Clipboard`. The bare `-Command
  // Set-Clipboard` form runs the cmdlet with no -Value argument, writes
  // nothing to the clipboard, and exits 0 — so callers always got
  // `true` back, but ClipboardExecutor's verify() then read the OLD
  // clipboard contents back via Get-Clipboard and found a mismatch,
  // surfacing as "CLIPBOARD_VERIFICATION: Clipboard content does not
  // match expected value." This was the root cause of the user-reported
  // "clipboard writing was failing verification" bug.
  //
  // FIX: Write `content` to a temp file as UTF-8, then run a PowerShell
  // script that reads the file back as UTF-8 and pipes it to Set-Clipboard.
  // We pass the script via `-EncodedCommand` (UTF-16LE base64) to avoid
  // any quoting/escaping pitfalls with content that contains quotes,
  // backticks, dollar signs, or PowerShell metacharacters.
  let tempFile: string | null = null;
  try {
    tempFile = path.join(os.tmpdir(), `sera-clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    fs.writeFileSync(tempFile, content, 'utf8');
    // In PowerShell single-quoted strings, a literal single quote is
    // escaped by doubling it. Temp file paths on Windows never contain
    // single quotes in practice, but we escape anyway to be safe.
    const escapedPath = tempFile.replace(/'/g, "''");
    const psScript = `$c = [System.IO.File]::ReadAllText('${escapedPath}', [System.Text.Encoding]::UTF8); Set-Clipboard -Value $c`;
    // -EncodedCommand expects UTF-16LE base64. This sidesteps all command
    // line length limits (~32KB for the cmd line itself) since the base64
    // payload is passed as a single argv token and PowerShell decodes it
    // internally; the script body itself is small.
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    await execAsync(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  } finally {
    if (tempFile) {
      try { fs.unlinkSync(tempFile); } catch { /* best-effort cleanup */ }
    }
  }
}

/**
 * Probes for a Linux clipboard backend on PATH. Tries in order:
 *   1. wl-copy / wl-paste (Wayland native — most reliable on Wayland sessions)
 *   2. xclip (X11 — most common)
 *   3. xsel (X11 — fallback when xclip isn't installed)
 *
 * Returns the binary name to use, or null if none is available. The
 * result is cached for the process lifetime so we don't spawn `which`
 * on every clipboard call.
 */
let linuxBackendCache: 'wl-copy' | 'xclip' | 'xsel' | null | undefined = undefined;
async function resolveLinuxBackend(): Promise<'wl-copy' | 'xclip' | 'xsel' | null> {
  if (linuxBackendCache !== undefined) return linuxBackendCache;
  for (const cmd of ['wl-copy', 'xclip', 'xsel'] as const) {
    try {
      await execFileAsync('which', [cmd], { windowsHide: true });
      linuxBackendCache = cmd;
      return cmd;
    } catch { /* try next */ }
  }
  linuxBackendCache = null;
  return null;
}

async function getClipboardLinux(): Promise<string | null> {
  const backend = await resolveLinuxBackend();
  if (!backend) return null;
  try {
    if (backend === 'wl-copy') {
      // wl-paste reads the clipboard. No transform needed — wl-paste
      // outputs the raw bytes.
      const result = await execFileAsync('wl-paste', ['--no-newline'], { maxBuffer: 10 * 1024 * 1024, env: { ...process.env, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || 'wayland-0' } });
      return result.stdout ?? '';
    }
    if (backend === 'xclip') {
      // -selection clipboard reads the system clipboard (not primary).
      // -o prints to stdout.
      const result = await execFileAsync('xclip', ['-selection', 'clipboard', '-o'], { maxBuffer: 10 * 1024 * 1024, env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } });
      return result.stdout ?? '';
    }
    // xsel: --clipboard --output
    const result = await execFileAsync('xsel', ['--clipboard', '--output'], { maxBuffer: 10 * 1024 * 1024, env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } });
    return result.stdout ?? '';
  } catch {
    return null;
  }
}

async function setClipboardLinux(content: string): Promise<boolean> {
  const backend = await resolveLinuxBackend();
  if (!backend) return false;
  try {
    if (backend === 'wl-copy') {
      // wl-copy reads the new clipboard contents from stdin.
      const child = execFile('wl-copy', [], { windowsHide: true, env: { ...process.env, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || 'wayland-0' } });
      return new Promise<boolean>((resolve) => {
        child.on('error', () => resolve(false));
        child.on('exit', (code) => resolve(code === 0));
        // Pipe content to stdin and signal EOF. We write the string as
        // UTF-8 so non-ASCII characters survive.
        if (child.stdin) {
          child.stdin.end(Buffer.from(content, 'utf8'));
        } else {
          resolve(false);
        }
      });
    }
    if (backend === 'xclip') {
      const child = execFile('xclip', ['-selection', 'clipboard'], { windowsHide: true, env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } });
      return new Promise<boolean>((resolve) => {
        child.on('error', () => resolve(false));
        child.on('exit', (code) => resolve(code === 0));
        if (child.stdin) child.stdin.end(Buffer.from(content, 'utf8'));
        else resolve(false);
      });
    }
    // xsel: --clipboard --input
    const child = execFile('xsel', ['--clipboard', '--input'], { windowsHide: true, env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } });
    return new Promise<boolean>((resolve) => {
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
      if (child.stdin) child.stdin.end(Buffer.from(content, 'utf8'));
      else resolve(false);
    });
  } catch {
    return false;
  }
}

export class DefaultClipboardProvider implements ClipboardProvider {
  public async get(): Promise<string | null> {
    if (process.platform === 'win32') return getClipboardWindows();
    if (process.platform === 'linux') return getClipboardLinux();
    return null;
  }

  public async set(content: string): Promise<boolean> {
    if (process.platform === 'win32') return setClipboardWindows(content);
    if (process.platform === 'linux') return setClipboardLinux(content);
    return false;
  }
}

export const defaultClipboardProvider = new DefaultClipboardProvider();
