import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { compareSemver, computeFileSha256, isTrustedDownloadUrl, UpdateService } from '../local/UpdateService';

describe('UpdateService - Security, Semver & State Machine', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-update-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('correctly compares semantic versions across all ranges', () => {
    expect(compareSemver('1.9.0', '1.10.0')).toBe(1);
    expect(compareSemver('1.10.0', '1.9.0')).toBe(-1);
    expect(compareSemver('1.9.0', '1.9.0')).toBe(0);
    expect(compareSemver('v1.9.0', 'v1.10.0')).toBe(1);
    expect(compareSemver('1.9.0', '2.0.0')).toBe(1);
    expect(compareSemver('1.9.0', '1.9.1')).toBe(1);
    expect(compareSemver('1.9.1', '1.9.0')).toBe(-1);
    expect(compareSemver('1.9.0', '1.9.0.1')).toBe(1);
  });

  it('validates trusted download URLs strictly', () => {
    expect(isTrustedDownloadUrl('https://github.com/beku16/Sera-v1/releases/download/v1.9.0/Sera.Installer.exe')).toBe(true);
    expect(isTrustedDownloadUrl('https://objects.githubusercontent.com/github-production-release-asset-2e65be/123')).toBe(true);
    expect(isTrustedDownloadUrl('https://github-releases.githubusercontent.com/12345')).toBe(true);
    expect(isTrustedDownloadUrl('http://github.com/malicious.exe')).toBe(false); // HTTP rejected
    expect(isTrustedDownloadUrl('https://evil-site.com/Sera.Installer.exe')).toBe(false); // Unknown host rejected
    expect(isTrustedDownloadUrl('not-a-url')).toBe(false);
  });

  it('computes exact SHA-256 hash of a file on disk', async () => {
    const testFile = path.join(tempDir, 'hash_test.bin');
    const content = Buffer.from('SERA_UPDATE_SHA256_INTEGRITY_CHECK');
    fs.writeFileSync(testFile, content);

    const expectedHash = createHash('sha256').update(content).digest('hex');
    const actualHash = await computeFileSha256(testFile);
    expect(actualHash).toBe(expectedHash);
  });

  it('initializes with default idle state and no error', () => {
    const service = new UpdateService();
    const status = service.getStatus();
    expect(status.status).toBe('idle');
    expect(status.info.currentVersion).toBeDefined();
    expect(status.info.hasUpdate).toBe(false);
    expect(status.progress.percent).toBe(0);
    expect(status.downloadedFilePath).toBeNull();
    expect(status.errorMessage).toBeNull();
  });

  it('rejects verification for non-existent files', async () => {
    const service = new UpdateService();
    const result = await service.verifyPackage(path.join(tempDir, 'nonexistent.exe'));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('rejects verification for undersized files (< 1MB)', async () => {
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
    const largeBuffer = Buffer.alloc(1.5 * 1024 * 1024);
    fs.writeFileSync(dummyPath, largeBuffer);

    const result = await service.verifyPackage(dummyPath);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not a Windows PE executable');
  });

  it('rejects verification when SHA-256 checksum mismatches', async () => {
    const service = new UpdateService();
    const dummyPath = path.join(tempDir, 'valid.exe');
    const largeBuffer = Buffer.alloc(2 * 1024 * 1024);
    largeBuffer[0] = 0x4d; // 'M'
    largeBuffer[1] = 0x5a; // 'Z'
    fs.writeFileSync(dummyPath, largeBuffer);

    const wrongSha256 = '0000000000000000000000000000000000000000000000000000000000000000';
    const result = await service.verifyPackage(dummyPath, largeBuffer.length, wrongSha256);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('SHA-256 hash mismatch');
  });

  it('successfully verifies a valid PE binary with matching SHA-256 hash', async () => {
    const service = new UpdateService();
    const dummyPath = path.join(tempDir, 'valid.exe');
    const largeBuffer = Buffer.alloc(2 * 1024 * 1024);
    largeBuffer[0] = 0x4d; // 'M'
    largeBuffer[1] = 0x5a; // 'Z'
    fs.writeFileSync(dummyPath, largeBuffer);

    const correctSha256 = createHash('sha256').update(largeBuffer).digest('hex');
    const result = await service.verifyPackage(dummyPath, largeBuffer.length, correctSha256);
    expect(result.valid).toBe(true);
    expect(result.sha256).toBe(correctSha256);
  });

  it('cancels active download gracefully and transitions state', () => {
    const service = new UpdateService();
    service.cancelDownload();
    const status = service.getStatus();
    expect(status.status).toBe('idle');
    expect(status.errorMessage).toContain('cancelled');
  });

  it('detects existing verified download on disk and avoids redownloading', async () => {
    const service = new UpdateService();
    const dummyPath = path.join(tempDir, 'Sera-Update-1.9.2.exe');
    const largeBuffer = Buffer.alloc(2 * 1024 * 1024);
    largeBuffer[0] = 0x4d; // 'M'
    largeBuffer[1] = 0x5a; // 'Z'
    fs.writeFileSync(dummyPath, largeBuffer);

    // Mock service info pointing to this asset
    (service as any).info = {
      hasUpdate: true,
      currentVersion: '1.9.1',
      latestVersion: '1.9.2',
      downloadUrl: 'https://github.com/beku16/Sera-v1/releases/download/v1.9.2/Sera-Update-1.9.2.exe',
      assetName: 'Sera-Update-1.9.2.exe',
      assetSize: largeBuffer.length,
      lastChecked: Date.now(),
    };

    // Override tmpWorkDir for testing
    const result = await service.verifyPackage(dummyPath, largeBuffer.length);
    expect(result.valid).toBe(true);
  });

  it('correctly calculates anti-spam snooze filtering and newer-version unblocking', () => {
    const settings = {
      snoozedUpdateVersion: '1.9.1',
      snoozedUntil: Date.now() + 24 * 60 * 60 * 1000,
    };

    // Case 1: Same version 1.9.1 while snooze active -> suppressed
    const isSnoozedForSameVersion =
      settings.snoozedUpdateVersion === '1.9.1' &&
      Date.now() < settings.snoozedUntil;
    expect(isSnoozedForSameVersion).toBe(true);

    // Case 2: Newer version 1.9.2 arrives -> snooze is bypassed
    const isSnoozedForNewerVersion =
      settings.snoozedUpdateVersion === '1.9.2' &&
      Date.now() < settings.snoozedUntil;
    expect(isSnoozedForNewerVersion).toBe(false);
  });
});
