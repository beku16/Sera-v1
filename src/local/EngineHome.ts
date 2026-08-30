import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * EngineHome — SERA's persistent per-user storage for optional offline
 * engines (v1.6.9).
 *
 * FIELD PAIN THIS SOLVES: after every SERA update the user had to re-run
 * `npm run setup:ocr` and `pip install piper-tts`, because optional
 * engines lived inside the app folder (or on PATH in ways an update
 * could disturb). Engines stored in the SERA home directory survive
 * every update, clone, and `npm run build`:
 *
 *   Windows:  %USERPROFILE%\.sera\{engines,models,voices}
 *   Linux/Mac: ~/.sera/{engines,models,voices}
 *
 * Override with the SERA_HOME environment variable.
 */

export function seraHomeDir(): string {
  const override = process.env.SERA_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.sera');
}

export function seraEnginesDir(): string {
  return path.join(seraHomeDir(), 'engines');
}

export function seraModelsDir(): string {
  return path.join(seraHomeDir(), 'models');
}

export function seraVoicesDir(): string {
  return path.join(seraHomeDir(), 'voices');
}

/** Creates the SERA home tree. Best-effort — never throws. */
export function ensureSeraHome(): { home: string; engines: string; models: string; voices: string } | null {
  try {
    const home = seraHomeDir();
    const engines = seraEnginesDir();
    const models = seraModelsDir();
    const voices = seraVoicesDir();
    for (const dir of [home, engines, models, voices]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return { home, engines, models, voices };
  } catch {
    return null;
  }
}

/**
 * Returns the first candidate that exists (and passes `check` when
 * given). Returns null when none match. Used to layer SERA_HOME paths
 * in front of the legacy repo-relative candidates.
 */
export function firstExisting(
  candidates: string[],
  check?: (p: string) => boolean,
): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (check ? check(candidate) : fs.existsSync(candidate)) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function isFileReadable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isFileExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
