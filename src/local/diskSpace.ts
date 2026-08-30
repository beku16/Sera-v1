import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * diskSpace.ts — pre-pull disk-space check (spec §19, v1.9.0).
 *
 * FIELD PAIN: a multi-GB model pull that dies at 97% because the disk
 * filled up wastes an hour and leaves a broken blob behind. Ollama's own
 * "no space left on device" only surfaces deep into the download. SERA now
 * checks free space on the directory Ollama actually unpacks models into
 * BEFORE starting the pull, and fails fast with an honest, fixable error.
 */

export interface DiskSpaceReport {
  /** Directory the free-space number was measured on. */
  dir: string;
  /** Free space in MB (null when it could not be determined). */
  freeMB: number | null;
  /** True when the check could not run (missing dir, statfs unavailable). */
  unknown: boolean;
}

/**
 * Where Ollama stores models, in probe order:
 *  1. OLLAMA_MODELS env (explicit user override — always wins)
 *  2. Windows: %LOCALAPPDATA%\ollama\models and %USERPROFILE%\.ollama\models
 *  3. Linux/macOS: ~/.ollama/models (service installs often use
 *     /usr/share/ollama/.ollama/models, which root owns — probed last).
 */
export function ollamaModelsDirCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.OLLAMA_MODELS) candidates.push(process.env.OLLAMA_MODELS);
  const home = process.env.USERPROFILE || os.homedir();
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'ollama', 'models'));
  }
  candidates.push(path.join(home, '.ollama', 'models'));
  if (process.platform === 'linux') {
    candidates.push('/usr/share/ollama/.ollama/models');
  }
  return candidates;
}

/**
 * Measures free disk space (MB) on the Ollama models directory using
 * fs.statfsSync when available. Returns { unknown: true } instead of
 * throwing when nothing can be measured — the pull proceeds and Ollama's
 * own error handling takes over (pre-existing behavior).
 */
export function checkDiskSpace(): DiskSpaceReport {
  // Node >= 18.15 exposes statfsSync; use it when present.
  const fsAny = fs as unknown as {
    statfsSync?: (p: string) => { bsize: number; bavail: number };
  };
  if (typeof fsAny.statfsSync !== 'function') {
    return { dir: ollamaModelsDirCandidates()[0] ?? '.', freeMB: null, unknown: true };
  }
  for (const dir of ollamaModelsDirCandidates()) {
    try {
      const stats = fsAny.statfsSync!(dir);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      if (Number.isFinite(freeBytes) && freeBytes >= 0) {
        return { dir, freeMB: Math.round(freeBytes / (1024 * 1024)), unknown: false };
      }
    } catch {
      // Candidate doesn't exist / not readable — try the next one.
    }
  }
  return { dir: ollamaModelsDirCandidates()[0] ?? '.', freeMB: null, unknown: true };
}

export interface DiskSpaceVerdict {
  ok: boolean;
  /** Human-readable failure reason (empty when ok). */
  reason?: string;
  report: DiskSpaceReport;
}

/**
 * Verdict for "can we safely pull a model of downloadMB?".
 *
 * The unpacked blob is roughly the download size (layers are downloaded
 * already-quantized), plus manifests plus working headroom — a 10% buffer
 * covers all of it. When free space cannot be measured the verdict is
 * permissive (unknown = don't block the pull).
 */
export function verdictForPull(downloadMB: number): DiskSpaceVerdict {
  const report = checkDiskSpace();
  if (report.unknown || report.freeMB === null) {
    return { ok: true, report };
  }
  const requiredMB = Math.ceil(downloadMB * 1.1);
  if (report.freeMB < requiredMB) {
    return {
      ok: false,
      report,
      reason:
        `Not enough disk space: the model needs about ${requiredMB} MB (download + unpacking) but the ` +
        `drive holding Ollama models (${report.dir}) has only ${report.freeMB} MB free. ` +
        `Free up space, delete unused models with "ollama rm <model>", or pick a smaller model — then retry.`,
    };
  }
  return { ok: true, report };
}
