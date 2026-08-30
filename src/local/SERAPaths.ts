import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seraHomeDir, ensureSeraHome } from './EngineHome';

/**
 * SERAPaths — the ONE resolver for every directory SERA reads or writes
 * (v1.9.0, PHASE 2 of the production plan — fixes BUG L5).
 *
 * ── The problem ─────────────────────────────────────────────────────
 * 35 code sites wrote relative to `process.cwd()`. From a repo checkout
 * that works; from an INSTALLED location (C:\Program Files\SERA on
 * Windows, /Applications on macOS) the app directory is READ-ONLY and
 * every write — vault, memories, mistake store, orchestrator state,
 * tmp/backups, OCR data — failed silently or crashed the feature that
 * needed it.
 *
 * ── The contract ────────────────────────────────────────────────────
 *  RESOURCES (read-only, shipped with the app)
 *    packaged:  process.resourcesPath      (extraResources root)
 *    dev:       the repository root
 *    override:  SERA_RESOURCES_PATH
 *  USER DATA (survives updates, per-user)  → %APPDATA%\SERA
 *    vault, memories, mistake store, orchestrator state, sera.port marker
 *  LOCAL DATA (rebuildable, per-machine)   → %LOCALAPPDATA%\SERA
 *    logs, cache, OCR data, downloads, tmp, backups
 *  ENGINES (big binaries, per-user)        → %USERPROFILE%\.sera  (unchanged)
 *
 * NOTHING user-written ever lands under resources/ again, so updates
 * (NSIS overwrite, portable zip) can never destroy user data.
 *
 * ── Migration ───────────────────────────────────────────────────────
 * Existing users have data in the repo layout (.data/, vault files in the
 * project root). `migrateLegacyData()` COPIES (never deletes) each legacy
 * file into its new home exactly once, guarded by a marker file. If the
 * app dir is writable (dev checkout) both copies exist; the new location
 * is authoritative from v1.9.0 on.
 */

/** True when running inside the packaged Electron app. */
export function isPackaged(): boolean {
  if (process.env.SERA_PACKAGED === '1') return true;
  if (process.env.SERA_PACKAGED === '0') return false;
  // Heuristic fallback for servers spawned outside the Electron parent
  // (Start SERA.bat): a bundled server.cjs inside an app.asar spells package.
  try {
    return typeof __filename === 'string' && __filename.includes('app.asar');
  } catch {
    return false;
  }
}

/** Repo root in dev (the directory holding package.json). */
function findRepoRoot(): string {
  // esbuild bundles server.ts → dist/server.cjs, so __dirname at runtime is
  // <repo>/dist (bundle) or <repo> (tsx dev). tsx also runs src files with
  // __dirname = <repo>/src or <repo>/src/server. Walk up until package.json.
  let dir = typeof __dirname === 'string' ? __dirname : process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** Read-only resources root (app shell, frontend dist, backend bundle). */
export function resourcesRoot(): string {
  const override = process.env.SERA_RESOURCES_PATH;
  if (override && override.trim()) return path.resolve(override.trim());
  if (isPackaged() && process.resourcesPath) return process.resourcesPath;
  return findRepoRoot();
}

/** Per-user persistent config/data root (vault, memories, state). */
export function userDataDir(): string {
  const override = process.env.SERA_USER_DATA;
  if (override && override.trim()) return path.resolve(override.trim());
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'SERA');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'SERA');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'SERA');
}

/** Per-machine rebuildable data root (logs, caches, OCR, downloads). */
export function localDataDir(): string {
  const override = process.env.SERA_LOCAL_DATA;
  if (override && override.trim()) return path.resolve(override.trim());
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SERA');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'SERA');
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'SERA');
}

/* ── Concrete sub-directories ─────────────────────────────────────── */

export const logsDir = (): string => path.join(localDataDir(), 'logs');
export const cacheDir = (): string => path.join(localDataDir(), 'cache');
export const ocrDataDir = (): string => path.join(localDataDir(), 'ocr');
export const downloadsDir = (): string => path.join(localDataDir(), 'downloads');
export const tmpWorkDir = (): string => path.join(localDataDir(), 'tmp');
export const backupsDir = (): string => path.join(localDataDir(), 'backups');
export const stateDir = (): string => path.join(userDataDir(), 'state');

/** The memory store file (authoritative home: user data). */
export const memoryFilePath = (): string => process.env.SERA_MEMORY_FILE || path.join(userDataDir(), 'sera_memories.json');
/** The mistake-memory file. */
export const mistakeMemoryFilePath = (): string => path.join(userDataDir(), 'sera_mistake_memory.json');
/** Encrypted API-key vault + its key file. */
export const vaultDir = (): string => path.join(userDataDir(), 'vault');

/** Built frontend (vite output) served in production. */
export const frontendDistDir = (): string => path.join(resourcesRoot(), 'dist');
/** The bundled backend (dist/server.cjs). */
export const backendBundlePath = (): string => path.join(resourcesRoot(), 'dist', 'server.cjs');
/** Electron speech worker (shipped under resources/electron). */
export const speechHostPath = (): string => path.join(resourcesRoot(), 'electron', 'speech-host.cjs');

/** Creates every writable directory. Best-effort, never throws. */
export function ensureSeraDirs(): {
  userData: string;
  localData: string;
  logs: string;
  cache: string;
  ocr: string;
  downloads: string;
  tmp: string;
  backups: string;
  state: string;
  enginesHome: string | null;
} {
  const dirs = {
    userData: userDataDir(),
    localData: localDataDir(),
    logs: logsDir(),
    cache: cacheDir(),
    ocr: ocrDataDir(),
    downloads: downloadsDir(),
    tmp: tmpWorkDir(),
    backups: backupsDir(),
    state: stateDir(),
  };
  for (const dir of Object.values(dirs)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // Best-effort: the caller's write will surface the real error.
    }
  }
  return { ...dirs, enginesHome: ensureSeraHome()?.home ?? null };
}

const MIGRATION_MARKER = 'migrated-from-repo-v1.9.0';

/**
 * One-time legacy migration: copies (NEVER deletes) repo-relative user
 * data into its SERAPaths home. Runs only when a writable legacy copy
 * exists AND the marker is absent. Vault + memory + mistakes move to
 * userData; nothing else does.
 */
export function migrateLegacyData(logger: Pick<Console, 'log' | 'warn'> = console): {
  migrated: string[];
  skipped: boolean;
} {
  const marker = path.join(userDataDir(), `.${MIGRATION_MARKER}`);
  try {
    if (fs.existsSync(marker)) return { migrated: [], skipped: true };
  } catch {
    return { migrated: [], skipped: true };
  }

  const repo = findRepoRoot();
  const moves: Array<{ from: string; to: string; label: string }> = [
    { from: path.join(repo, '.data', 'sera_memories.json'), to: memoryFilePath(), label: 'memories' },
    { from: path.join(repo, 'sera_api_vault.enc'), to: path.join(vaultDir(), 'sera_api_vault.enc'), label: 'vault' },
    { from: path.join(repo, 'sera_api_vault.key'), to: path.join(vaultDir(), 'sera_api_vault.key'), label: 'vault-key' },
    { from: path.join(repo, 'sera_mistake_memory.json'), to: mistakeMemoryFilePath(), label: 'mistakes' },
  ];

  const migrated: string[] = [];
  for (const move of moves) {
    try {
      if (!fs.existsSync(move.from)) continue;
      if (fs.existsSync(move.to)) continue; // never overwrite newer data
      fs.mkdirSync(path.dirname(move.to), { recursive: true });
      fs.copyFileSync(move.from, move.to);
      migrated.push(move.label);
    } catch (err) {
      logger.warn(`[SERAPaths] migration skipped for ${move.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
  } catch {
    /* marker is best-effort */
  }
  if (migrated.length) {
    logger.log(`[SERAPaths] migrated legacy data to ${userDataDir()}: ${migrated.join(', ')} (originals left in place)`);
  }
  return { migrated, skipped: false };
}
