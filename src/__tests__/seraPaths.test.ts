import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * SERAPaths + logging test suite (PHASE 2).
 *
 * BUG L5 regression: NOTHING user-written may resolve under the install
 * dir once packaged; legacy repo data must be COPIED (never moved/deleted)
 * into the per-user home exactly once.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-paths-test-'));

function freshEnv() {
  const userData = path.join(tmpRoot, 'user-data', String(Math.random()).slice(2, 8));
  const localData = path.join(tmpRoot, 'local-data', String(Math.random()).slice(2, 8));
  process.env.SERA_USER_DATA = userData;
  process.env.SERA_LOCAL_DATA = localData;
  return { userData, localData };
}

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ['SERA_USER_DATA', 'SERA_LOCAL_DATA', 'SERA_RESOURCES_PATH', 'SERA_PACKAGED']) {
    savedEnv[key] = process.env[key];
  }
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('SERAPaths directory contract', () => {
  it('separates user data from local data, both outside the resources root', async () => {
    const { userData, localData } = freshEnv();
    process.env.SERA_RESOURCES_PATH = path.join(tmpRoot, 'resources');
    process.env.SERA_PACKAGED = '1';
    const paths = await import('../local/SERAPaths');
    expect(paths.userDataDir()).toBe(userData);
    expect(paths.localDataDir()).toBe(localData);
    expect(paths.logsDir().startsWith(localData)).toBe(true);
    expect(paths.ocrDataDir().startsWith(localData)).toBe(true);
    expect(paths.memoryFilePath().startsWith(userData)).toBe(true);
    expect(paths.vaultDir().startsWith(userData)).toBe(true);
    // Resources (read-only app files) NEVER contain user data paths.
    expect(paths.memoryFilePath().startsWith(paths.resourcesRoot())).toBe(false);
    expect(paths.logsDir().startsWith(paths.resourcesRoot())).toBe(false);
  });

  it('isPackaged honors the explicit SERA_PACKAGED flag over heuristics', async () => {
    freshEnv();
    process.env.SERA_PACKAGED = '1';
    const paths = await import('../local/SERAPaths');
    expect(paths.isPackaged()).toBe(true);
    process.env.SERA_PACKAGED = '0';
    expect(paths.isPackaged()).toBe(false);
  });

  it('ensureSeraDirs creates every writable directory', async () => {
    const { userData, localData } = freshEnv();
    const paths = await import('../local/SERAPaths');
    const dirs = paths.ensureSeraDirs();
    expect(fs.existsSync(dirs.userData)).toBe(true);
    expect(fs.existsSync(dirs.logs)).toBe(true);
    expect(fs.existsSync(dirs.ocr)).toBe(true);
    expect(dirs.userData.startsWith(userData)).toBe(true);
    expect(dirs.logs.startsWith(localData)).toBe(true);
  });

  it('migrateLegacyData COPIES legacy repo files once and never deletes them', async () => {
    freshEnv();
    process.env.SERA_PACKAGED = '0';
    delete process.env.SERA_RESOURCES_PATH;
    const paths = await import('../local/SERAPaths');
    // Fabricate a legacy repo layout around the CURRENT repo root.
    const repo = process.cwd();
    const legacyMem = path.join(repo, '.data', 'sera_memories.json');
    const legacyVault = path.join(repo, 'sera_api_vault.enc');
    const hadMem = fs.existsSync(legacyMem);
    const hadVault = fs.existsSync(legacyVault);
    if (!hadMem) fs.mkdirSync(path.join(repo, '.data'), { recursive: true }), fs.writeFileSync(legacyMem, '[]');
    if (!hadVault) fs.writeFileSync(legacyVault, 'legacy-vault-bytes');

    try {
      // Remove any marker from previous runs so this migration executes.
      try { fs.rmSync(path.join(paths.userDataDir(), '.migrated-from-repo-v1.9.0'), { force: true }); } catch { /* ok */ }
      const result = paths.migrateLegacyData();
      expect(result.skipped).toBe(false);
      expect(fs.existsSync(paths.memoryFilePath())).toBe(true);
      expect(fs.existsSync(path.join(paths.vaultDir(), 'sera_api_vault.enc'))).toBe(true);
      // NEVER deleted from the legacy location.
      expect(fs.existsSync(legacyMem)).toBe(true);
      expect(fs.existsSync(legacyVault)).toBe(true);
      // Second run is a marked no-op.
      const again = paths.migrateLegacyData();
      expect(again.skipped).toBe(true);
      expect(again.migrated).toEqual([]);
    } finally {
      if (!hadMem) { try { fs.rmSync(legacyMem, { force: true }); } catch { /* ok */ } }
      if (!hadVault) { try { fs.rmSync(legacyVault, { force: true }); } catch { /* ok */ } }
    }
  });
});

describe('structured logging', () => {
  it('redacts API keys, tokens and passwords from every line', async () => {
    freshEnv();
    const { redactLine } = await import('../server/logging');
    expect(redactLine('Authorization: Bearer AIzaSyD-SECRET-VALUE')).not.toContain('SECRET-VALUE');
    expect(redactLine('api_key="sk-1234567890abcdef"')).not.toContain('1234567890');
    expect(redactLine('user password=hunter2 logged in')).not.toContain('hunter2');
    expect(redactLine('token: ghp_abc123xyz')).not.toContain('ghp_abc123xyz');
    // Non-secret content survives.
    expect(redactLine('server listening on 43110')).toContain('43110');
  });

  it('writes JSON lines into the log dir and never throws', async () => {
    const { localData } = freshEnv();
    const { createLogger, rotateLogs } = await import('../server/logging');
    rotateLogs();
    const log = createLogger('test');
    log.info('hello log', { model: 'qwen3:4b' });
    log.error('boom', { err: 'x' });
    const files = fs.readdirSync(path.join(localData, 'logs'));
    expect(files.some((f) => /^sera-\d{4}-\d{2}-\d{2}\.log$/.test(f))).toBe(true);
    const content = fs.readFileSync(path.join(localData, 'logs', files[0]), 'utf8');
    const parsed = content.trim().split('\n').map((l) => JSON.parse(l));
    expect(parsed.some((l) => l.msg === 'hello log' && l.extra.model === 'qwen3:4b')).toBe(true);
    expect(parsed.every((l) => typeof l.t === 'string' && typeof l.level === 'string')).toBe(true);
  });
});
