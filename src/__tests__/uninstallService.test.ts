import { describe, it, expect, beforeEach } from 'vitest';
import { UninstallService } from '../local/UninstallService';
import { matchUninstallIntent, UNINSTALL_FAREWELL } from '../utils/sleepCommands';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('UninstallService & Intent Recognition', () => {
  let service: UninstallService;

  beforeEach(() => {
    service = new UninstallService();
  });

  it('generates a random, easily pronounceable 4-token challenge', () => {
    const challenge = service.generateChallenge();
    expect(challenge.challengeId).toMatch(/^uninst_\d+_[a-z0-9]+$/);
    expect(challenge.tokens).toHaveLength(4);
    expect(challenge.phrase).toBe(challenge.tokens.join(' '));
    expect(challenge.expiresAt).toBeGreaterThan(Date.now());
  });

  it('correctly verifies exact challenge phrase (case-insensitive)', () => {
    const challenge = service.generateChallenge();
    const result = service.verifyChallenge(challenge.challengeId, challenge.phrase.toUpperCase());
    expect(result.valid).toBe(true);
  });

  it('correctly verifies challenge words spoken with minor punctuation or spacing differences', () => {
    const challenge = service.generateChallenge();
    const result = service.verifyChallenge(challenge.challengeId, `  ${challenge.phrase}, ! `);
    expect(result.valid).toBe(true);
  });

  it('rejects incorrect challenge input', () => {
    const challenge = service.generateChallenge();
    const result = service.verifyChallenge(challenge.challengeId, 'wrong random sentence 99');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Verification mismatch');
  });

  it('rejects expired or nonexistent challenge IDs', () => {
    const result = service.verifyChallenge('invalid_id_999', 'any phrase');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Challenge expired or invalid');
  });

  it('exports memory backup into custom directory with README.txt', () => {
    const tmpDir = path.join(os.tmpdir(), `test_uninstall_backup_${Date.now()}`);
    const res = service.exportMemoryBackup(tmpDir);
    expect(res.success).toBe(true);
    expect(fs.existsSync(res.backupDir)).toBe(true);
    expect(fs.existsSync(path.join(res.backupDir, 'README.txt'))).toBe(true);

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('recognizes voice and text uninstallation intents', () => {
    expect(matchUninstallIntent('Sera, uninstall yourself')).toBe(true);
    expect(matchUninstallIntent('uninstall sera')).toBe(true);
    expect(matchUninstallIntent('uninstall yourself')).toBe(true);
    expect(matchUninstallIntent('remove sera')).toBe(true);
    expect(matchUninstallIntent('i want to uninstall sera')).toBe(true);
    expect(matchUninstallIntent('remove sera from my computer')).toBe(true);
    expect(matchUninstallIntent('delete sera from my computer')).toBe(true);
    expect(matchUninstallIntent('delete sera')).toBe(true);
    expect(matchUninstallIntent('remove yourself')).toBe(true);
    expect(matchUninstallIntent('erase sera')).toBe(true);
    expect(matchUninstallIntent('wipe sera')).toBe(true);
    expect(matchUninstallIntent('uninstall')).toBe(true);

    // Negative cases (general conversational speech)
    expect(matchUninstallIntent('tell me a story')).toBe(false);
    expect(matchUninstallIntent('how to uninstall an application in Windows')).toBe(false);
    expect(matchUninstallIntent('hello sera')).toBe(false);
  });

  it('provides a reassuring safety confirmation farewell string', () => {
    expect(UNINSTALL_FAREWELL).toContain('uninstallation security gate');
  });

  it('correctly distinguishes full wipe vs preserve memory modes', async () => {
    // Test that executeUninstall runs without error in both modes
    const preserveRes = await service.executeUninstall({ preserveMemory: true });
    expect(preserveRes.success).toBe(true);
    expect(preserveRes.backupDir).toBeDefined();

    const fullWipeRes = await service.executeUninstall({ preserveMemory: false });
    expect(fullWipeRes.success).toBe(true);
  });
});
