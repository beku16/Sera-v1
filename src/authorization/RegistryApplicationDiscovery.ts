import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RegistryApplication {
  name: string;
  executable: string;
}

export function parseRegistryApplications(output: string): RegistryApplication[] {
  try {
    const parsed = JSON.parse(output) as Array<{ DisplayName?: string; DisplayIcon?: string; InstallLocation?: string }> | { DisplayName?: string; DisplayIcon?: string; InstallLocation?: string };
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries
      .map((entry) => ({
        name: entry.DisplayName?.trim() || '',
        executable: (entry.DisplayIcon || entry.InstallLocation || '').replace(/,\d+$/, '').trim().replace(/^"|"$/g, ''),
      }))
      .filter((entry) => entry.name.length > 0 && /\.exe$/i.test(entry.executable));
  } catch {
    return [];
  }
}

export async function discoverRegistryApplication(name: string): Promise<RegistryApplication | null> {
  if (process.platform !== 'win32') return null;
  const command = 'Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* | Where-Object { $_.DisplayName -and ($_.DisplayIcon -or $_.InstallLocation) } | Select-Object DisplayName, DisplayIcon, InstallLocation | ConvertTo-Json -Compress';
  try {
    const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const normalized = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return parseRegistryApplications(result.stdout).find((entry) => entry.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') === normalized) || null;
  } catch {
    return null;
  }
}
