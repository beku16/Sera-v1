import os from 'node:os';
import { execFile } from 'node:child_process';

/**
 * Hardware audit result produced at startup (Local Mode wizard).
 *
 * The inspector is intentionally defensive: every probe is optional and
 * gracefully degrades, because the wizard must render even on machines
 * without nvidia-smi, with missing WMI, or under restricted shells.
 */
export interface GpuInfo {
  name: string;
  /** Dedicated VRAM in megabytes (0 when unknown). */
  vramTotalMB: number;
  /** Free VRAM in megabytes (0 when unknown). */
  vramFreeMB: number;
  driverVersion: string;
  /** CUDA compute capability like "8.9" (null when not detected). */
  cudaComputeCapability: string | null;
  cudaSupported: boolean;
}

export interface HardwareReport {
  platform: string;
  osRelease: string;
  arch: string;
  hostname: string;
  cpu: {
    model: string;
    logicalCores: number;
    physicalCores: number | null;
    speedGHz: number | null;
  };
  ram: {
    totalMB: number;
    freeMB: number;
  };
  gpu: GpuInfo | null;
  /** Overall tier used by the model recommender. */
  tier: 'cuda-high' | 'cuda-mid' | 'cuda-low' | 'cpu-only';
  auditedAt: number;
  /** Non-fatal notes about what could not be probed. */
  probeNotes: string[];
}

export type ExecRunner = (
  file: string,
  args: string[],
  timeoutMs?: number,
) => Promise<{ stdout: string; stderr: string }>;

/** Default runner: spawn a short-lived child process. */
const defaultExecRunner: ExecRunner = (file, args, timeoutMs = 6000) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      // Missing binary / non-zero exit are NOT thrown — callers probe gracefully.
      resolve({ stdout: err && !stdout ? String((err as NodeJS.ErrnoException & { stdout?: string }).stdout ?? '') : String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });

/**
 * Parses `nvidia-smi --query-gpu=...` CSV output.
 * Expected fields (in order): name, memory.total [MB], memory.free [MB], driver_version.
 * Handles both header and noheader formats, including single-row outputs.
 */
export function parseNvidiaSmiCsv(output: string): GpuInfo | null {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  // Skip the header row printed by --format=csv (without noheader): its
  // first field is literally "name".
  const isHeaderLine = (line: string): boolean => {
    const firstField = line.split(',')[0]?.trim().toLowerCase();
    return firstField === 'name' || firstField === '';
  };
  const dataLine = lines.find((line) => !isHeaderLine(line));
  if (!dataLine) return null;

  const [name, totalRaw, freeRaw, driverRaw] = dataLine.split(',').map((p) => p.trim());
  // A real CSV row always has multiple fields; error strings like
  // "nvidia-smi: command failed" arrive as a single comma-less line.
  if (dataLine.split(',').length < 2) return null;

  const toInt = (raw: string | undefined): number => {
    if (!raw) return 0;
    const match = raw.match(/(\d+(?:\.\d+)?)/);
    return match ? Math.round(parseFloat(match[1])) : 0;
  };

  if (!name) return null;
  return {
    name,
    vramTotalMB: toInt(totalRaw),
    vramFreeMB: toInt(freeRaw),
    driverVersion: driverRaw || 'unknown',
    cudaComputeCapability: null,
    cudaSupported: /nvidia|geforce|rtx|gtx|quadro/i.test(name),
  };
}

/**
 * Parses `nvidia-smi -q` output for the CUDA compute capability.
 */
export function parseCudaCapability(queryOutput: string): string | null {
  const match = queryOutput.match(/CUDA Version\s*:\s*([\d.]+)/i);
  return match ? match[1] : null;
}

/** Windows-aware physical core estimate (falls back to logical count). */
function estimatePhysicalCores(logical: number, platform: string): number | null {
  if (platform === 'win32') {
    // Most modern consumer CPUs are hyperthreaded (2 threads/core).
    return logical % 2 === 0 ? logical / 2 : null;
  }
  return null;
}

/** Cache: re-probing nvidia-smi twice per /api/local/status call was
 * spawning two child processes on EVERY wizard render (BUG L4). The report
 * is now cached for the TTL below; `audit({ fresh: true })` forces a
 * re-scan (the RE-SCAN HARDWARE button passes ?rescan=1). */
export interface AuditOptions {
  /** Skip the cache and re-probe the hardware right now. */
  fresh?: boolean;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

export class HardwareInspector {
  private readonly execRunner: ExecRunner;
  private cache: { report: HardwareReport; at: number } | null = null;

  constructor(execRunner: ExecRunner = defaultExecRunner) {
    this.execRunner = execRunner;
  }

  /** Drops the cached report (next audit re-probes). */
  public invalidateCache(): void {
    this.cache = null;
  }

  /** True when a non-expired cached report exists. */
  public hasFreshCache(now: number = Date.now()): boolean {
    return this.cache !== null && now - this.cache.at < CACHE_TTL_MS;
  }

  /**
   * Runs the full audit. Never throws — probe failures degrade the report
   * and are surfaced via `probeNotes` so the startup wizard can explain
   * exactly what could not be inspected and why.
   *
   * v1.9.0: results are cached for CACHE_TTL_MS unless `fresh: true` is
   * passed, so opening settings no longer spawns nvidia-smi on every call.
   */
  public async audit(options: AuditOptions = {}): Promise<HardwareReport> {
    if (!options.fresh && this.hasFreshCache()) {
      return this.cache!.report;
    }
    const report = await this.probeHardware();
    this.cache = { report, at: Date.now() };
    return report;
  }

  private async probeHardware(): Promise<HardwareReport> {
    const probeNotes: string[] = [];
    const cpus = os.cpus();
    const totalMemMB = Math.round(os.totalmem() / (1024 * 1024));
    const freeMemMB = Math.round(os.freemem() / (1024 * 1024));

    let gpu: GpuInfo | null = null;
    try {
      const { stdout } = await this.execRunner(
        'nvidia-smi',
        ['--query-gpu=name,memory.total,memory.free,driver_version', '--format=csv,noheader'],
        6000,
      );
      gpu = parseNvidiaSmiCsv(stdout);
      if (!gpu) {
        probeNotes.push('nvidia-smi present but returned no parsable GPU row — CUDA acceleration disabled.');
      }
    } catch {
      probeNotes.push('nvidia-smi unavailable — no NVIDIA GPU or driver not installed.');
    }

    if (gpu) {
      try {
        const { stdout } = await this.execRunner('nvidia-smi', ['-q'], 6000);
        gpu.cudaComputeCapability = parseCudaCapability(stdout);
      } catch {
        probeNotes.push('Could not read CUDA capability from nvidia-smi -q.');
      }
    }

    const vramMB = gpu?.vramTotalMB ?? 0;
    let tier: HardwareReport['tier'] = 'cpu-only';
    if (vramMB >= 5800) tier = 'cuda-high';
    else if (vramMB >= 3800) tier = 'cuda-mid';
    else if (vramMB > 0) tier = 'cuda-low';

    return {
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      hostname: os.hostname(),
      cpu: {
        model: cpus[0]?.model?.trim() || 'Unknown CPU',
        logicalCores: cpus.length,
        physicalCores: estimatePhysicalCores(cpus.length, process.platform),
        speedGHz: cpus[0]?.speed ? Math.round(cpus[0].speed) / 1000 : null,
      },
      ram: { totalMB: totalMemMB, freeMB: freeMemMB },
      gpu,
      tier,
      auditedAt: Date.now(),
      probeNotes,
    };
  }
}

export const defaultHardwareInspector = new HardwareInspector();
