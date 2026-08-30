import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpWorkDir, isPackaged, resourcesRoot, userDataDir } from './SERAPaths';
import { APP_VERSION } from '../generated/appVersion';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'update-available'
  | 'downloading'
  | 'verifying'
  | 'ready-to-install'
  | 'installing'
  | 'restarting'
  | 'error';

export interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string | null;
  releaseName: string | null;
  releaseNotes: string | null;
  releaseDate: string | null;
  downloadUrl: string | null;
  assetName: string | null;
  assetSize: number | null;
  sha512?: string | null;
  lastChecked: number | null;
}

export interface DownloadProgress {
  bytesDownloaded: number;
  totalBytes: number;
  percent: number;
  speedBytesPerSec: number;
  etaSeconds: number | null;
}

export interface UpdateState {
  status: UpdateStatus;
  info: UpdateInfo;
  progress: DownloadProgress;
  downloadedFilePath: string | null;
  errorMessage: string | null;
  safeToRestart: boolean;
}

export function compareSemver(current: string, latest: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/i, '')
      .split('.')
      .map((p) => {
        const n = parseInt(p, 10);
        return isNaN(n) ? 0 : n;
      });

  const cParts = parse(current);
  const lParts = parse(latest);

  const len = Math.max(cParts.length, lParts.length);
  for (let i = 0; i < len; i++) {
    const c = cParts[i] || 0;
    const l = lParts[i] || 0;
    if (l > c) return 1; // latest is newer
    if (l < c) return -1; // current is newer
  }
  return 0; // equal
}

export class UpdateService {
  private readonly repoOwner = 'beku16';
  private readonly repoName = 'Sera-v1';

  private status: UpdateStatus = 'idle';
  private info: UpdateInfo = {
    hasUpdate: false,
    currentVersion: APP_VERSION,
    latestVersion: null,
    releaseName: null,
    releaseNotes: null,
    releaseDate: null,
    downloadUrl: null,
    assetName: null,
    assetSize: null,
    lastChecked: null,
  };

  private progress: DownloadProgress = {
    bytesDownloaded: 0,
    totalBytes: 0,
    percent: 0,
    speedBytesPerSec: 0,
    etaSeconds: null,
  };

  private downloadedFilePath: string | null = null;
  private errorMessage: string | null = null;
  private activeDownloadReq: http.ClientRequest | null = null;
  private downloadAbortController: AbortController | null = null;

  public getStatus(): UpdateState {
    return {
      status: this.status,
      info: { ...this.info, currentVersion: APP_VERSION },
      progress: { ...this.progress },
      downloadedFilePath: this.downloadedFilePath,
      errorMessage: this.errorMessage,
      safeToRestart: true,
    };
  }

  /**
   * Queries GitHub Releases for the latest version and compares against current version.
   */
  public async checkForUpdates(force = false): Promise<UpdateInfo> {
    if (this.status === 'checking' || this.status === 'downloading' || this.status === 'installing') {
      return this.info;
    }

    this.status = 'checking';
    this.errorMessage = null;

    try {
      const release = await this.fetchLatestRelease();
      const tagName = String(release?.tag_name || '').trim();
      const rawVersion = tagName.replace(/^v/i, '');

      const hasNewer = rawVersion ? compareSemver(APP_VERSION, rawVersion) > 0 : false;

      // Find Windows installer asset (Sera Installer.exe or Sera.Installer.exe)
      let installerAsset = release?.assets?.find((a: any) =>
        /Sera.*Installer.*\.exe$/i.test(a.name) || /Sera.*Setup.*\.exe$/i.test(a.name)
      );

      // Fallback: any .exe asset in the release
      if (!installerAsset && release?.assets?.length) {
        installerAsset = release.assets.find((a: any) => /\.exe$/i.test(a.name));
      }

      this.info = {
        hasUpdate: hasNewer,
        currentVersion: APP_VERSION,
        latestVersion: rawVersion || null,
        releaseName: release?.name || tagName,
        releaseNotes: release?.body || 'Performance enhancements and stability updates.',
        releaseDate: release?.published_at || new Date().toISOString(),
        downloadUrl: installerAsset?.browser_download_url || null,
        assetName: installerAsset?.name || null,
        assetSize: installerAsset?.size || null,
        lastChecked: Date.now(),
      };

      if (hasNewer && this.info.downloadUrl) {
        this.status = 'update-available';
      } else {
        this.status = 'up-to-date';
      }

      return this.info;
    } catch (err: any) {
      console.warn('[UPDATE_CHECK_ERROR]', err.message);
      this.status = 'error';
      this.errorMessage = err.message || 'Failed to check for updates';
      return {
        ...this.info,
        hasUpdate: false,
        lastChecked: Date.now(),
      };
    }
  }

  /**
   * Streams the installer download directly to disk with real-time byte progress.
   */
  public async startDownload(): Promise<{ success: boolean; filePath?: string; error?: string }> {
    if (!this.info.downloadUrl) {
      const checkResult = await this.checkForUpdates();
      if (!checkResult.downloadUrl) {
        this.status = 'error';
        this.errorMessage = 'No downloadable update package found.';
        return { success: false, error: this.errorMessage };
      }
    }

    if (this.status === 'downloading') {
      return { success: true, filePath: this.downloadedFilePath || undefined };
    }

    this.status = 'downloading';
    this.errorMessage = null;
    this.progress = {
      bytesDownloaded: 0,
      totalBytes: this.info.assetSize || 0,
      percent: 0,
      speedBytesPerSec: 0,
      etaSeconds: null,
    };

    const targetDir = tmpWorkDir();
    fs.mkdirSync(targetDir, { recursive: true });
    const fileName = this.info.assetName || `Sera-Update-${this.info.latestVersion || Date.now()}.exe`;
    const targetPath = path.join(targetDir, fileName);
    const tempDownloadPath = `${targetPath}.downloading`;

    try {
      if (fs.existsSync(tempDownloadPath)) {
        fs.unlinkSync(tempDownloadPath);
      }

      await this.downloadWithProgress(this.info.downloadUrl!, tempDownloadPath);

      // Verify the downloaded binary before renaming to targetPath
      const verifyResult = await this.verifyPackage(tempDownloadPath, this.info.assetSize || undefined);
      if (!verifyResult.valid) {
        throw new Error(verifyResult.reason || 'Downloaded package failed integrity verification.');
      }

      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
      fs.renameSync(tempDownloadPath, targetPath);

      this.downloadedFilePath = targetPath;
      this.status = 'ready-to-install';
      return { success: true, filePath: targetPath };
    } catch (err: any) {
      console.error('[UPDATE_DOWNLOAD_FAILED]', err);
      try {
        if (fs.existsSync(tempDownloadPath)) fs.unlinkSync(tempDownloadPath);
      } catch {}
      this.status = 'error';
      this.errorMessage = err.message || 'Download interrupted';
      return { success: false, error: this.errorMessage };
    }
  }

  public cancelDownload(): void {
    if (this.activeDownloadReq) {
      try {
        this.activeDownloadReq.destroy();
      } catch {}
      this.activeDownloadReq = null;
    }
    this.status = this.info.hasUpdate ? 'update-available' : 'idle';
    this.errorMessage = 'Download cancelled by user.';
  }

  /**
   * Verifies the downloaded binary format (PE header) and size integrity.
   */
  public async verifyPackage(filePath: string, expectedSize?: number): Promise<{ valid: boolean; reason?: string }> {
    this.status = 'verifying';
    try {
      if (!fs.existsSync(filePath)) {
        return { valid: false, reason: 'Downloaded file not found on disk.' };
      }

      const stat = fs.statSync(filePath);
      if (stat.size < 1000000) { // Should be > 1 MB
        return { valid: false, reason: `File is too small (${stat.size} bytes), possibly truncated or invalid response.` };
      }

      if (expectedSize && Math.abs(stat.size - expectedSize) > 4096) {
        return { valid: false, reason: `File size mismatch (expected ${expectedSize}, got ${stat.size}).` };
      }

      // Check Windows PE header (MZ magic bytes: 0x4D, 0x5A)
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(2);
      fs.readSync(fd, buffer, 0, 2, 0);
      fs.closeSync(fd);

      if (buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
        return { valid: false, reason: 'Invalid executable binary header (not a Windows PE executable).' };
      }

      return { valid: true };
    } catch (err: any) {
      return { valid: false, reason: `Verification error: ${err.message}` };
    }
  }

  /**
   * Coordinates safe process teardown, runs the installer silently (/S), and relaunches SERA.
   */
  public async applyUpdateAndRestart(): Promise<{ success: boolean; message: string }> {
    if (!this.downloadedFilePath || !fs.existsSync(this.downloadedFilePath)) {
      this.status = 'error';
      this.errorMessage = 'No verified update package ready for installation.';
      return { success: false, message: this.errorMessage };
    }

    this.status = 'installing';

    const installerPath = this.downloadedFilePath;
    const targetInstallExe = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'Programs',
      'sera',
      'Sera.exe'
    );

    const scriptPath = path.join(os.tmpdir(), `sera_update_bootstrap_${Date.now()}.bat`);

    const scriptContent = [
      '@echo off',
      'echo =======================================',
      'echo   SERA AI Assistant — Self-Updater',
      'echo =======================================',
      'echo Waiting for running SERA processes to close...',
      'timeout /t 2 /nobreak >nul',
      'taskkill /F /IM Sera.exe >nul 2>&1',
      'timeout /t 1 /nobreak >nul',
      'echo Installing updated version...',
      `start /wait "" "${installerPath}" /S`,
      'timeout /t 1 /nobreak >nul',
      'echo Relaunching SERA...',
      `if exist "${targetInstallExe}" (`,
      `  start "" "${targetInstallExe}"`,
      `) else (`,
      `  if exist "${installerPath}" start "" "${installerPath}"`,
      `)`,
      'del /f /q "%~f0" >nul 2>&1',
    ].join('\r\n');

    fs.writeFileSync(scriptPath, scriptContent, 'utf8');

    try {
      const child = spawn('cmd.exe', ['/c', scriptPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } catch (err: any) {
      console.error('[UPDATE_BOOTSTRAP_SPAWN_ERROR]', err);
      this.status = 'error';
      this.errorMessage = `Failed to spawn updater: ${err.message}`;
      return { success: false, message: this.errorMessage };
    }

    this.status = 'restarting';

    // Gracefully exit the current process after letting response reach the client
    setTimeout(() => {
      process.exit(0);
    }, 1000);

    return {
      success: true,
      message: 'SERA is restarting to apply the update. Your data and settings are preserved.',
    };
  }

  private downloadWithProgress(initialUrl: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let startTime = Date.now();
      let lastSampleTime = startTime;
      let lastSampleBytes = 0;
      let bytesDownloaded = 0;
      let totalBytes = this.info.assetSize || 0;

      const fileStream = fs.createWriteStream(destPath);

      const requestHandler = (currentUrl: string, redirectCount = 0) => {
        if (redirectCount > 10) {
          reject(new Error('Too many redirects attempting to download update'));
          return;
        }

        const urlObj = new URL(currentUrl);
        const protocol = urlObj.protocol === 'http:' ? http : https;

        const req = protocol.get(
          currentUrl,
          {
            headers: {
              'User-Agent': 'SERA-AutoUpdater/' + APP_VERSION,
              Accept: 'application/octet-stream, application/vnd.github+json, */*',
            },
          },
          (res) => {
            // Follow redirects (GitHub Releases redirect 302 -> AWS S3 assets)
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              requestHandler(res.headers.location, redirectCount + 1);
              return;
            }

            if (res.statusCode !== 200) {
              reject(new Error(`Server returned HTTP ${res.statusCode} while downloading update`));
              return;
            }

            const headerLength = parseInt(res.headers['content-length'] || '0', 10);
            if (headerLength > 0) {
              totalBytes = headerLength;
            }

            res.on('data', (chunk) => {
              bytesDownloaded += chunk.length;
              const now = Date.now();

              // Calculate speed and ETA every 250ms
              if (now - lastSampleTime >= 250) {
                const intervalSec = (now - lastSampleTime) / 1000;
                const intervalBytes = bytesDownloaded - lastSampleBytes;
                const speed = intervalBytes / intervalSec;

                let etaSeconds: number | null = null;
                if (speed > 0 && totalBytes > bytesDownloaded) {
                  etaSeconds = Math.max(1, Math.round((totalBytes - bytesDownloaded) / speed));
                }

                const percent = totalBytes > 0 ? Math.min(100, Math.round((bytesDownloaded / totalBytes) * 100)) : 0;

                this.progress = {
                  bytesDownloaded,
                  totalBytes,
                  percent,
                  speedBytesPerSec: Math.round(speed),
                  etaSeconds,
                };

                lastSampleTime = now;
                lastSampleBytes = bytesDownloaded;
              }
            });

            res.pipe(fileStream);

            fileStream.on('finish', () => {
              fileStream.close(() => {
                this.progress = {
                  bytesDownloaded,
                  totalBytes: Math.max(totalBytes, bytesDownloaded),
                  percent: 100,
                  speedBytesPerSec: 0,
                  etaSeconds: 0,
                };
                resolve();
              });
            });

            fileStream.on('error', (err) => {
              fs.unlink(destPath, () => {});
              reject(err);
            });
          }
        );

        req.on('error', (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });

        this.activeDownloadReq = req;
      };

      requestHandler(initialUrl);
    });
  }

  private fetchLatestRelease(): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/releases/latest`;
      const req = https.get(
        url,
        {
          headers: {
            'User-Agent': 'SERA-AutoUpdater/' + APP_VERSION,
            Accept: 'application/vnd.github+json',
          },
          timeout: 10000,
        },
        (res) => {
          let rawData = '';
          res.on('data', (chunk) => (rawData += chunk));
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const parsed = JSON.parse(rawData);
                resolve(parsed);
              } catch (e) {
                reject(new Error('Invalid JSON received from GitHub releases API'));
              }
            } else if (res.statusCode === 404) {
              resolve(null);
            } else {
              reject(new Error(`GitHub API returned HTTP ${res.statusCode}`));
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('GitHub API request timed out (offline or unreachable)'));
      });

      req.on('error', reject);
    });
  }
}

export const defaultUpdateService = new UpdateService();
