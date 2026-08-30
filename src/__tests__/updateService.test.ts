import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { compareSemver, UpdateService } from '../local/UpdateService';

describe('UpdateService - Semver & State Machine', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-update-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('correctly compares semantic versions', () => {
    expect(compareSemver('1.9.0', '1.10.0')).toBe(1); // latest (1.10.0) is newer than current (1.9.0)
    expect(compareSemver('1.10.0', '1.9.0')).toBe(-1); // current is newer
    expect(compareSemver('1.9.0', '1.9.0')).toBe(0); // equal
    expect(compareSemver('v1.9.0', 'v1.10.0')).toBe(1);
    expect(compareSemver('1.9.0', '2.0.0')).toBe(1);
    expect(compareSemver('1.9.0', '1.9.1')).toBe(1);
    expect(compareSemver('1.9.1', '1.9.0')).toBe(-1);
    expect(compareSemver('1.9.0', '1.9.0.1')).toBe(1);
  });

  it('initializes with default idle state', () => {
    const service = new UpdateService();
    const status = service.getStatus();
    expect(status.status).toBe('idle');
    expect(status.info.currentVersion).toBeDefined();
    expect(status.info.hasUpdate).toBe(false);
    expect(status.progress.percent).toBe(0);
    expect(status.downloadedFilePath).toBeNull();
  });

  it('rejects verification for non-existent files', async () => {
    const service = new UpdateService();
    const result = await service.verifyPackage(path.join(tempDir, 'nonexistent.exe'));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('rejects verification for truncated or undersized files (< 1MB)', async () => {
    const service = new UpdateService();
    const dummyPath = path.join(tempDir, 'small.exe');
    fs.writeFileSync(dummyPath, Buffer.from('MZ_too_small'));

    const result = await service.verifyPackage(dummyPath);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('too small');
  });

  it('rejects verification for files without valid Windows PE MZ header', async () => {
    const service = new UpdateService();
    const dummyPath = path.join(tempDir, 'fake.exe');
    // Allocate 1.5MB of zeroes (no MZ header)
    const largeBuffer = Buffer.alloc(1.5 * 1024 * 1024);
    fs.writeFileSync(dummyPath, largeBuffer);

    const result = await service.verifyPackage(dummyPath);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not a Windows PE executable');
  });

  it('successfully verifies a valid PE binary header and size', async () => {
    const service = new UpdateService();
    const dummyPath = path.join(tempDir, 'valid.exe');
    // Allocate 2MB with MZ magic header (0x4D, 0x5A)
    const largeBuffer = Buffer.alloc(2 * 1024 * 1024);
    largeBuffer[0] = 0x4d; // 'M'
    largeBuffer[1] = 0x5a; // 'Z'
    fs.writeFileSync(dummyPath, largeBuffer);

    const result = await service.verifyPackage(dummyPath);
    expect(result.valid).toBe(true);
  });

  it('cancels active download gracefully without crashing', () => {
    const service = new UpdateService();
    service.cancelDownload();
    const status = service.getStatus();
    expect(status.status).toBe('idle');
    expect(status.errorMessage).toContain('cancelled');
  });
});
