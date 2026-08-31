import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  userDataDir,
  localDataDir,
  memoryFilePath,
  mistakeMemoryFilePath,
  isPackaged,
  resourcesRoot,
} from './SERAPaths';
import { seraHomeDir } from './EngineHome';

const execAsync = promisify(exec);

export interface UninstallChallenge {
  challengeId: string;
  phrase: string;
  tokens: string[];
  expiresAt: number;
}

export interface MemorySummary {
  memoryCount: number;
  mistakeCount: number;
  hasVaultKeys: boolean;
  userDataPath: string;
  backupPathSuggestion: string;
}

export interface UninstallOptions {
  preserveMemory: boolean;
  preserveEngines?: boolean;
}

// Clean, easy-to-pronounce, positive English vocabulary for challenge phrases
const FRIENDLY_WORDS = [
  'amber', 'anchor', 'beacon', 'breeze', 'canyon', 'cedar', 'comet', 'coral',
  'crystal', 'delta', 'echo', 'ember', 'falcon', 'feather', 'forest', 'galaxy',
  'glacier', 'harbor', 'horizon', 'island', 'jupiter', 'lagoon', 'lotus', 'meadow',
  'nebula', 'oasis', 'ocean', 'orbit', 'pebble', 'planet', 'prism', 'quartz',
  'rainbow', 'river', 'ruby', 'safari', 'shadow', 'silver', 'solar', 'summit',
  'sunset', 'timber', 'valley', 'velvet', 'voyage', 'wave', 'willow', 'zenith'
];

export class UninstallService {
  private activeChallenges = new Map<string, UninstallChallenge>();

  /**
   * Generates a random, easily pronounceable challenge phrase (3 words + 1 two-digit number).
   * Example: "sunset river echo 49"
   */
  public generateChallenge(): UninstallChallenge {
    const word1 = FRIENDLY_WORDS[Math.floor(Math.random() * FRIENDLY_WORDS.length)];
    let word2 = FRIENDLY_WORDS[Math.floor(Math.random() * FRIENDLY_WORDS.length)];
    while (word2 === word1) {
      word2 = FRIENDLY_WORDS[Math.floor(Math.random() * FRIENDLY_WORDS.length)];
    }
    let word3 = FRIENDLY_WORDS[Math.floor(Math.random() * FRIENDLY_WORDS.length)];
    while (word3 === word1 || word3 === word2) {
      word3 = FRIENDLY_WORDS[Math.floor(Math.random() * FRIENDLY_WORDS.length)];
    }
    const number = Math.floor(10 + Math.random() * 89); // 2-digit number 10-99

    const tokens = [word1, word2, word3, String(number)];
    const phrase = tokens.join(' ');
    const challengeId = `uninst_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes validity

    const challenge: UninstallChallenge = {
      challengeId,
      phrase,
      tokens,
      expiresAt,
    };

    // Clean up expired challenges
    this.cleanExpired();
    this.activeChallenges.set(challengeId, challenge);

    return challenge;
  }

  /**
   * Validates user input (spoken or typed) against the active challenge phrase.
   */
  public verifyChallenge(challengeId: string, inputPhrase: string): { valid: boolean; reason?: string } {
    this.cleanExpired();
    const challenge = this.activeChallenges.get(challengeId);
    if (!challenge) {
      return { valid: false, reason: 'Challenge expired or invalid. Please generate a new confirmation code.' };
    }

    if (Date.now() > challenge.expiresAt) {
      this.activeChallenges.delete(challengeId);
      return { valid: false, reason: 'Challenge has expired. Please try again.' };
    }

    const normalize = (text: string) =>
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const normalizedInput = normalize(inputPhrase);
    const normalizedTarget = normalize(challenge.phrase);

    if (normalizedInput === normalizedTarget) {
      return { valid: true };
    }

    // Check individual token presence (for speech recognition partial ordering resilience)
    const inputWords = normalizedInput.split(' ');
    const allTokensPresent = challenge.tokens.every((t) => inputWords.includes(t.toLowerCase()));

    if (allTokensPresent) {
      return { valid: true };
    }

    return {
      valid: false,
      reason: `Verification mismatch. Expected "${challenge.phrase}"`,
    };
  }

  /**
   * Computes a summary of the user's stored memories, mistakes, and keys.
   */
  public getMemorySummary(): MemorySummary {
    let memoryCount = 0;
    let mistakeCount = 0;
    let hasVaultKeys = false;

    try {
      const memPath = memoryFilePath();
      if (fs.existsSync(memPath)) {
        const parsed = JSON.parse(fs.readFileSync(memPath, 'utf8'));
        if (Array.isArray(parsed)) memoryCount = parsed.length;
        else if (Array.isArray(parsed?.memories)) memoryCount = parsed.memories.length;
      }
    } catch {}

    try {
      const mistakePath = mistakeMemoryFilePath();
      if (fs.existsSync(mistakePath)) {
        const parsed = JSON.parse(fs.readFileSync(mistakePath, 'utf8'));
        if (Array.isArray(parsed)) mistakeCount = parsed.length;
      }
    } catch {}

    try {
      const vaultPath = path.join(userDataDir(), 'vault', 'api_keys.vault');
      if (fs.existsSync(vaultPath)) hasVaultKeys = true;
    } catch {}

    const backupPathSuggestion = path.join(os.homedir(), 'Sera_Memory_Backup');

    return {
      memoryCount,
      mistakeCount,
      hasVaultKeys,
      userDataPath: userDataDir(),
      backupPathSuggestion,
    };
  }

  /**
   * Exports all user memories, mistake history, and settings into a standalone, safe backup folder.
   */
  public exportMemoryBackup(customTargetDir?: string): { success: boolean; backupDir: string; exportedFiles: string[] } {
    const baseDir = customTargetDir || path.join(os.homedir(), 'Sera_Memory_Backup');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const targetDir = path.join(baseDir, `SERA_Backup_${timestamp}`);

    fs.mkdirSync(targetDir, { recursive: true });
    const exportedFiles: string[] = [];

    const copyIfExists = (src: string, destName: string) => {
      try {
        if (fs.existsSync(src)) {
          const dest = path.join(targetDir, destName);
          fs.copyFileSync(src, dest);
          exportedFiles.push(destName);
        }
      } catch (err) {
        console.warn(`[UNINSTALL_BACKUP] Failed to copy ${src}:`, err);
      }
    };

    copyIfExists(memoryFilePath(), 'sera_memories.json');
    copyIfExists(mistakeMemoryFilePath(), 'sera_mistakes.json');
    copyIfExists(path.join(userDataDir(), 'window-state.json'), 'window-state.json');
    copyIfExists(path.join(userDataDir(), 'orchestrator_state.json'), 'orchestrator_state.json');

    // Create a human-readable README in the backup folder
    const readmeContent = `# SERA Memory & Data Backup
Created on: ${new Date().toLocaleString()}

This folder contains your preserved memory and learning data from SERA:
- sera_memories.json: All learned long-term facts, conversations, and user preferences.
- sera_mistakes.json: Self-learning and mistake-correction history.
- window-state.json: Your window positioning and desktop preferences.

## How to restore when reinstalling SERA:
When you reinstall SERA in the future, you can copy these files back into:
%APPDATA%\\SERA\\ (${userDataDir()})
`;
    fs.writeFileSync(path.join(targetDir, 'README.txt'), readmeContent, 'utf8');
    exportedFiles.push('README.txt');

    return {
      success: true,
      backupDir: targetDir,
      exportedFiles,
    };
  }

  /**
   * Executes the full uninstallation process.
   */
  public async executeUninstall(options: UninstallOptions): Promise<{ success: boolean; message: string; backupDir?: string }> {
    let backupDir: string | undefined;
    const isFullWipe = !options.preserveMemory;
    const preserveEngines = !isFullWipe && options.preserveEngines === true;

    // 1. Export memory backup if requested
    if (options.preserveMemory) {
      const backupResult = this.exportMemoryBackup();
      backupDir = backupResult.backupDir;
      console.log(`[UNINSTALL] Memories preserved to: ${backupDir}`);
    }

    // 2. Remove Windows Autostart Registry entry if on Windows
    if (process.platform === 'win32') {
      try {
        await execAsync('reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "SERA" /f', { windowsHide: true });
        console.log('[UNINSTALL] Removed autostart registry entry.');
      } catch {
        // Entry might not exist, ignore
      }
    }

    // 3. Prepare standalone cleanup script (detaches and runs after SERA process exits)
    const cleanupScriptPath = path.join(os.tmpdir(), `sera_cleanup_${Date.now()}.bat`);
    const uData = userDataDir();
    const lData = localDataDir();
    const engineData = seraHomeDir();
    const updaterDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'sera-updater');
    const electronRoaming = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'sera-electron');
    const installDir = isPackaged()
      ? path.resolve(resourcesRoot(), '..')
      : '';

    const scriptLines: string[] = [
      '@echo off',
      'echo Waiting for SERA to terminate...',
      'timeout /t 2 /nobreak >nul',
      'taskkill /F /IM Sera.exe >nul 2>&1',
      'timeout /t 1 /nobreak >nul',
    ];

    // Remove desktop and start menu shortcuts
    const desktopShortcut = path.join(os.homedir(), 'Desktop', 'SERA.lnk');
    const startMenuShortcut = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'SERA.lnk');
    scriptLines.push(`if exist "${desktopShortcut}" del /f /q "${desktopShortcut}" >nul 2>&1`);
    scriptLines.push(`if exist "${startMenuShortcut}" del /f /q "${startMenuShortcut}" >nul 2>&1`);

    // Clean Local AppData (logs, cache, temp) with retries
    scriptLines.push(`for /l %%i in (1,1,5) do (`);
    scriptLines.push(`  if exist "${lData}" (`);
    scriptLines.push(`    rmdir /s /q "${lData}" >nul 2>&1`);
    scriptLines.push(`    timeout /t 1 /nobreak >nul`);
    scriptLines.push(`  )`);
    scriptLines.push(`)`);

    // Clean updater cache directory
    scriptLines.push(`if exist "${updaterDir}" rmdir /s /q "${updaterDir}" >nul 2>&1`);

    // In 100% Full Wipe mode: remove User AppData (%APPDATA%\SERA), .sera (%USERPROFILE%\.sera), and electron caches
    if (isFullWipe) {
      scriptLines.push(`for /l %%i in (1,1,5) do (`);
      scriptLines.push(`  if exist "${uData}" (`);
      scriptLines.push(`    rmdir /s /q "${uData}" >nul 2>&1`);
      scriptLines.push(`    timeout /t 1 /nobreak >nul`);
      scriptLines.push(`  )`);
      scriptLines.push(`)`);

      scriptLines.push(`for /l %%i in (1,1,5) do (`);
      scriptLines.push(`  if exist "${engineData}" (`);
      scriptLines.push(`    rmdir /s /q "${engineData}" >nul 2>&1`);
      scriptLines.push(`    timeout /t 1 /nobreak >nul`);
      scriptLines.push(`  )`);
      scriptLines.push(`)`);

      scriptLines.push(`if exist "${electronRoaming}" rmdir /s /q "${electronRoaming}" >nul 2>&1`);
    } else {
      // In Preserve Mode: clean port file and temp locks from .sera while keeping models/engines if requested
      const portFile = path.join(engineData, 'sera.port');
      scriptLines.push(`if exist "${portFile}" del /f /q "${portFile}" >nul 2>&1`);
      if (!preserveEngines) {
        scriptLines.push(`if exist "${engineData}" rmdir /s /q "${engineData}" >nul 2>&1`);
      }
    }

    // If installed via NSIS in Programs directory, trigger uninstaller or clean folder
    if (isPackaged() && installDir && installDir.includes('Programs')) {
      const nsisUninstaller = path.join(installDir, 'Uninstall Sera.exe');
      scriptLines.push(`if exist "${nsisUninstaller}" (`);
      scriptLines.push(`  start "" "${nsisUninstaller}" /S`);
      scriptLines.push(`) else (`);
      scriptLines.push(`  timeout /t 1 /nobreak >nul`);
      scriptLines.push(`  rmdir /s /q "${installDir}" >nul 2>&1`);
      scriptLines.push(`)`);
    }

    // Self-delete cleanup batch script
    scriptLines.push(`del /f /q "%~f0" >nul 2>&1`);

    fs.writeFileSync(cleanupScriptPath, scriptLines.join('\r\n'), 'utf8');

    // Spawn detached helper script
    try {
      const child = spawn('cmd.exe', ['/c', cleanupScriptPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } catch (err) {
      console.error('[UNINSTALL] Failed to spawn cleanup script:', err);
    }

    // Schedule exit
    setTimeout(() => {
      process.exit(0);
    }, 1200);

    return {
      success: true,
      message: options.preserveMemory
        ? `SERA uninstallation initiated. Your memories and settings have been safely preserved in ${backupDir}.`
        : 'SERA uninstallation initiated. All data, caches, and files are being completely removed.',
      backupDir,
    };
  }

  private cleanExpired(): void {
    const now = Date.now();
    for (const [id, ch] of this.activeChallenges.entries()) {
      if (now > ch.expiresAt) {
        this.activeChallenges.delete(id);
      }
    }
  }
}

export const defaultUninstallService = new UninstallService();
