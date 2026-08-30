import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { OllamaClient } from './OllamaClient';

/** Minimal child shape the manager relies on (test-injectable). */
export interface ManagedChild {
  pid?: number;
  exitCode: number | null;
  killed: boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  kill(): boolean;
}
export type SpawnFn = (command: string, args: string[]) => ManagedChild;

/**
 * ollamaManager.ts — SERA-side lifecycle management for the Ollama daemon
 * (v1.9.0, spec §11/§12 — PHASE 3).
 *
 * Three honest states, exactly as the wizard renders them:
 *   A  READY            daemon answers /api/version → nothing to do.
 *   B  INSTALLED-       CLI found, daemon down → SERA spawns `ollama serve`
 *      STARTING         as a CHILD IT OWNS, health-polls it (≤30s), and
 *                      kills it again on shutdown. Never touches a daemon
 *                      it did not start.
 *   C  NOT INSTALLED   neither CLI nor daemon → the UI's install card with
 *                      the official download link; Online Mode needs none.
 *
 * Conflict policy (tray-app safety): SERA only spawns when the daemon is
 * down AND the CLI was found. The official Windows app keeping ollama in
 * the tray is state A — SERA never doublespawned, never killed it.
 */

export type OllamaManagerState = 'ready' | 'starting' | 'not-installed' | 'start-failed';

export interface OllamaManagerReport {
  state: OllamaManagerState;
  /** True when the daemon answering right now was spawned by this process. */
  ownedBySera: boolean;
  /** Resolved CLI path when found (also used for spawning). */
  cliPath: string | null;
  message: string;
}

export class OllamaManager {
  private child: ManagedChild | null = null;
  private starting: Promise<OllamaManagerReport> | null = null;

  constructor(
    private readonly client: OllamaClient,
    private readonly logger: { info: (m: string, e?: Record<string, unknown>) => void; warn: (m: string, e?: Record<string, unknown>) => void } = { info: () => undefined, warn: () => undefined },
    private readonly spawnFn: SpawnFn = (cmd, args) =>
      spawn(cmd, args, { windowsHide: true, stdio: 'ignore', detached: false }) as unknown as ManagedChild,
  ) {}

  /** Current snapshot without side effects. */
  public async report(): Promise<OllamaManagerReport> {
    const running = await this.client.isRunning();
    if (running) {
      return {
        state: 'ready',
        ownedBySera: this.owned(),
        cliPath: null,
        message: this.owned()
          ? 'Ollama is running (started by SERA — it will be closed when SERA quits).'
          : 'Ollama is running.',
      };
    }
    const install = await this.resolveCli();
    if (!install) {
      return {
        state: 'not-installed',
        ownedBySera: false,
        cliPath: null,
        message: 'Ollama is not installed. Install it from https://ollama.com/download (2 minutes), or use Online Mode — it needs no local setup.',
      };
    }
    return {
      state: 'start-failed',
      ownedBySera: false,
      cliPath: install,
      message: 'Ollama is installed but its background service is not running. Use START OLLAMA below, open it from the Start Menu, or run "ollama serve" in a terminal.',
    };
  }

  private owned(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  /** Locates the ollama CLI (PATH + the Windows default install paths). */
  private async resolveCli(): Promise<string | null> {
    const install = await this.client.isInstalled();
    if (install.installed && install.resolvedPath) return install.resolvedPath;
    if (install.installed) return 'ollama';
    // Windows default install locations (OllamaSetup.exe) — even off-PATH.
    if (process.platform === 'win32') {
      const candidates = [
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe') : null,
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Ollama', 'ollama.exe') : null,
      ].filter(Boolean) as string[];
      for (const candidate of candidates) {
        try {
          if (fs.existsSync(candidate)) return candidate;
        } catch { /* probe next */ }
      }
    }
    return null;
  }

  /**
   * State B transition: spawn `ollama serve`, poll /api/version until it
   * answers (≤30 s), resolve with the honest report. Concurrent callers
   * share one attempt. Never resolves by throwing.
   */
  public async ensureRunning(): Promise<OllamaManagerReport> {
    if (await this.client.isRunning()) return this.report();

    if (this.starting) return this.starting;
    this.starting = (async (): Promise<OllamaManagerReport> => {
      const cliPath = await this.resolveCli();
      if (!cliPath) {
        return {
          state: 'not-installed',
          ownedBySera: false,
          cliPath: null,
          message: 'Cannot start Ollama because it is not installed. Get it from https://ollama.com/download, then come back — or use Online Mode.',
        };
      }
      try {
        this.logger.info('spawning ollama serve', { cliPath });
        this.child = this.spawnFn(cliPath, ['serve']);
        this.child.on('error', (err: Error) => this.logger.warn('ollama serve spawn error', { error: err.message }));
        this.child.on('exit', (code: number | null) => this.logger.info('ollama serve exited', { code }));

        // Health poll: every 750 ms, ≤30 s (40 attempts) — spec §12.
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 750));
          if (await this.client.isRunning()) {
            this.logger.info('ollama daemon ready (SERA-owned)');
            return {
              state: 'ready',
              ownedBySera: this.owned(),
              cliPath,
              message: 'Ollama started by SERA and is ready. It will close automatically when SERA quits.',
            };
          }
          if (!this.owned()) break; // child died — stop waiting
        }
        return {
          state: 'start-failed',
          ownedBySera: false,
          cliPath,
          message: 'Ollama was started but did not become ready within 30 seconds. Open it from the Start Menu (or run "ollama serve" in a terminal) and check https://ollama.com for updates.',
        };
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  /** Kills ONLY a daemon this manager spawned. Registered at shutdown. */
  public stopOwned(): void {
    if (this.owned() && this.child?.pid) {
      try {
        this.logger.info('stopping SERA-owned ollama daemon', { pid: this.child.pid });
        this.child.kill();
      } catch {
        /* already gone */
      }
    }
    this.child = null;
  }
}

import { defaultOllamaClient } from './OllamaClient';
import { createLogger } from '../server/logging';

const managerLogger = createLogger('ollama-manager');
export const defaultOllamaManager = new OllamaManager(defaultOllamaClient, managerLogger);
