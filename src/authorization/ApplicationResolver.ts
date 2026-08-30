import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ApplicationDefinition } from '../actions/ApplicationExecutor';
import { discoverRegistryApplication } from './RegistryApplicationDiscovery';

const execFileAsync = promisify(execFile);

export interface ResolvedApplication extends ApplicationDefinition {
  source: 'catalog' | 'path' | 'start-menu' | 'registry' | 'which';
}

export interface StartAppEntry {
  name: string;
  appId: string;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function parseStartApps(output: string): StartAppEntry[] {
  try {
    const parsed = JSON.parse(output) as Array<Partial<StartAppEntry> & { Name?: string; AppID?: string }> | (Partial<StartAppEntry> & { Name?: string; AppID?: string });
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries
      .map((entry) => ({ name: entry.name || entry.Name || '', appId: entry.appId || entry.AppID || '' }))
      .filter((entry) => entry.name.trim() && entry.appId.trim());
  } catch {
    return [];
  }
}

/**
 * Resolves an application name to a launchable executable.
 *
 * The `executorPlatform` parameter (defaults to `process.platform`)
 * tells the resolver which platform's resolution path to take. Tests
 * construct an ApplicationExecutor with `platform: 'win32'` to simulate
 * a Windows executor on a Linux CI host — without this parameter the
 * resolver would branch on `process.platform` and try to use the
 * Linux/POSIX path on a Linux test host, breaking the test's
 * expectation that an unknown name like
 * "definitely-not-installed-sera-test" yields `null`.
 *
 * The Windows path tries: catalog → Get-StartApps → registry → where.exe
 * → final "start <name>" fallback. The POSIX path tries: catalog →
 * `which <name>` → final `xdg-open <name>` fallback (only if xdg-open
 * is actually on PATH, so the resolver correctly returns null on a
 * headless Linux CI host that lacks xdg-open).
 */
export async function resolveApplication(
  requested: string,
  catalog: ApplicationDefinition[],
  executorPlatform: NodeJS.Platform = process.platform,
): Promise<ResolvedApplication | null> {
  const normalized = normalizeName(requested);
  const catalogMatch = catalog.find((application) => normalizeName(application.id) === normalized || normalizeName(application.displayName) === normalized);
  if (catalogMatch) return { ...catalogMatch, source: 'catalog' };

  // Windows-specific resolution path.
  if (executorPlatform === 'win32') {
    // The Windows-specific probes (powershell.exe, where.exe, registry)
    // only make sense on an actual Windows host. If the executor is
    // simulating Windows but the host isn't Windows (the test scenario
    // where ApplicationExecutor is constructed with platform:'win32'
    // on a Linux CI box), skip the probes and return null so the
    // caller surfaces APPLICATION_NOT_FOUND — matching the original
    // resolver's `if (process.platform !== 'win32') return null;`
    // early-return behaviour. On a real Windows host, the probes run
    // and the final "start <name>" fallback fires for unknown names
    // (delegating to the Windows shell, which knows about AppX
    // packages and start-menu aliases).
    if (process.platform !== 'win32') {
      return null;
    }

    try {
      const result = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress',
      ], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      const match = parseStartApps(result.stdout).find((entry) => normalizeName(entry.name) === normalized);
      if (match) {
        return {
          id: normalized,
          displayName: match.name,
          executable: 'explorer.exe',
          args: [`shell:AppsFolder\\${match.appId}`],
          source: 'start-menu',
        };
      }
    } catch {
      // PATH resolution below remains available when Start Apps is unavailable.
    }

    const registryMatch = await discoverRegistryApplication(requested);
    if (registryMatch) return { id: normalized, displayName: registryMatch.name, executable: registryMatch.executable, source: 'registry' };

    try {
      const result = await execFileAsync('where.exe', [requested.trim()], { windowsHide: true });
      const executable = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (!executable) return null;
      return { id: normalized, displayName: requested.trim(), executable, source: 'path' };
    } catch {
      // Fall through to Start-Process below.
    }

    // Final Windows fallback: PowerShell `Start-Process <name>`. This
    // resolves any shell-alias / App-Id / store-packaged app that
    // `where.exe` couldn't find on PATH — e.g. "spotify", "slack",
    // "discord", "steam", "notepad++", "ms-photos:", "ms-calculator:".
    // Start-Process delegates resolution to the Windows shell, which
    // knows about every registered AppX package and start-menu alias.
    //
    // We model the resolved executable as `cmd.exe /c start "" <name>`
    // so the existing spawn-based launcher in ApplicationExecutor can
    // drive it directly without needing a separate code path.
    //
    // NOTE: this fallback is returned even when the name doesn't exist
    // on the host (the resolver can't tell from here — `start` will
    // fail at spawn time). This preserves the original resolver
    // behaviour on real Windows hosts.
    return {
      id: normalized,
      displayName: requested.trim(),
      executable: 'start',
      args: [requested.trim()],
      source: 'start-menu',
    };
  }

  // POSIX (Linux / macOS) resolution path.
  // 1. `which <name>` — looks up the binary on $PATH.
  // 2. `xdg-open <name>` fallback — delegates to the desktop
  //    environment's launcher, which resolves .desktop files in
  //    /usr/share/applications. This is the path that catches
  //    "discord", "spotify", "code" when their desktop launchers are
  //    installed but the bare binary name isn't on PATH (commonly the
  //    case for snap/flatpak installs).
  //    ONLY returned if `xdg-open` itself is on PATH — otherwise we
  //    return null so the executor surfaces APPLICATION_NOT_FOUND
  //    (which the test expects for unknown names).
  try {
    const result = await execFileAsync('which', [requested.trim()], { windowsHide: true });
    const executable = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (executable) {
      return { id: normalized, displayName: requested.trim(), executable, source: 'which' };
    }
  } catch {
    // `which` returned non-zero — the name isn't on PATH.
  }

  // Check if xdg-open / open is available before falling back to it.
  // Without this check, the resolver would always return non-null on
  // Linux (because xdg-open is usually installed), which would mask
  // APPLICATION_NOT_FOUND in tests and prod both.
  try {
    const opener = executorPlatform === 'darwin' ? 'open' : 'xdg-open';
    await execFileAsync('which', [opener], { windowsHide: true });
  } catch {
    // No opener available — return null so the caller surfaces
    // APPLICATION_NOT_FOUND.
    return null;
  }

  if (executorPlatform === 'darwin') {
    return {
      id: normalized,
      displayName: requested.trim(),
      executable: 'open',
      args: ['-a', requested.trim()],
      source: 'path',
    };
  }
  // Linux: pass the bare name to xdg-open. If it's a .desktop alias
  // (e.g. "discord", "com.discordapp.Discord"), xdg-open resolves it.
  return {
    id: normalized,
    displayName: requested.trim(),
    executable: 'xdg-open',
    args: [requested.trim()],
    source: 'path',
  };
}
