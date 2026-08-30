import { isStableAuthorizationId, KeyValueStorage, loadAuthorizationState, persistAuthorizationState } from './AuthorizationIdentity';

export type AuthorizationMode = 'STANDARD' | 'TRUSTED' | 'FULL_CONTROL';

export type ComputerCapability =
  | 'COMPUTER_READ'
  | 'SCREEN_INSPECTION'
  | 'SCREEN_CAPTURE'
  | 'MOUSE_CONTROL'
  | 'KEYBOARD_CONTROL'
  | 'WINDOW_CONTROL'
  | 'APPLICATION_LAUNCH'
  | 'APPLICATION_CLOSE'
  | 'BROWSER_CONTROL'
  | 'CLIPBOARD_READ'
  | 'CLIPBOARD_WRITE'
  | 'AUDIO_CONTROL'
  | 'DISPLAY_CONTROL'
  | 'SYSTEM_SETTINGS';

export interface AuthorizationChangedEvent {
  sessionId: string;
  state: AuthorizationState;
}

export interface AuthorizationState {
  mode: AuthorizationMode;
  capabilities: ComputerCapability[];
  updatedAt: string;
}

const TRUSTED_CAPABILITIES: ComputerCapability[] = [
  'COMPUTER_READ', 'SCREEN_INSPECTION', 'SCREEN_CAPTURE', 'MOUSE_CONTROL',
  'KEYBOARD_CONTROL', 'WINDOW_CONTROL', 'APPLICATION_LAUNCH', 'APPLICATION_CLOSE',
  'BROWSER_CONTROL', 'CLIPBOARD_READ', 'CLIPBOARD_WRITE', 'AUDIO_CONTROL', 'DISPLAY_CONTROL',
];
const FULL_CONTROL_CAPABILITIES: ComputerCapability[] = [...TRUSTED_CAPABILITIES, 'SYSTEM_SETTINGS'];

// Auto-trust flag: when SERA runs as a desktop app (Electron) on the user's
// own machine, the user has already opted in to giving the assistant
// computer-control capabilities by installing and launching it. Treating
// every fresh session as STANDARD (which blocks every capability-gated
// tool with "Capability X requires authorization") made the entire
// openApplication / controlComputerInput / controlScreen / captureScreenshot
// toolchain silently fail out of the box — the user had to call
// setComputerControlAuthorization before *anything* worked, which the
// system prompt never tells them to do.
//
// SERA_DESKTOP_MODE=true (set by electron/main.cjs for the spawned server)
// OR SERA_AUTO_TRUST=true (manual override) causes every fresh session to
// default to TRUSTED mode with all safe capabilities granted up-front.
// FULL_CONTROL and SYSTEM_SETTINGS are still gated behind an explicit
// authorization call.
const AUTO_TRUST = process.env.SERA_DESKTOP_MODE === 'true' || process.env.SERA_AUTO_TRUST === 'true';

export class ComputerAuthorizationManager {
  private readonly sessions = new Map<string, AuthorizationState>();
  private readonly listeners = new Set<(event: AuthorizationChangedEvent) => void>();
  /**
   * v1.6.11: every Gemini/local session passes its own authorizationId and
   * a state was cached per id forever — an unbounded map over the process
   * lifetime (each auto-trusted grant materialized a full state object).
   * Capped with oldest-first eviction; entries are re-created on demand.
   */
  private readonly maxTrackedSessions = 512;

  constructor(private readonly storage: KeyValueStorage | null = typeof window !== 'undefined' ? window.localStorage : null) {}

  /** v1.6.11: bounded insertion — evicts the oldest entry beyond the cap. */
  private rememberSession(sessionId: string, state: AuthorizationState): void {
    this.sessions.set(sessionId, state);
    while (this.sessions.size > this.maxTrackedSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }

  public getAuthorizationState(sessionId = 'default'): AuthorizationState {
    const state = this.sessions.get(sessionId);
    if (state) return { ...state, capabilities: [...state.capabilities] };

    const restored = this.restoreFromStorage(sessionId);
    if (restored) return { ...restored, capabilities: [...restored.capabilities] };

    // Auto-trust only kicks in for explicit, stable authorization IDs that
    // came from the Electron bridge (auth-...) OR the literal 'default'
    // session used by programmatic tests / direct tool dispatch. Anonymous
    // browser sessions (which use an ephemeral session-... ID) stay STANDARD
    // so a random person hitting the web UI doesn't get capabilities.
    if (AUTO_TRUST && (sessionId === 'default' || isStableAuthorizationId(sessionId))) {
      const trusted: AuthorizationState = {
        mode: 'TRUSTED',
        capabilities: [...TRUSTED_CAPABILITIES],
        updatedAt: new Date(0).toISOString(),
      };
      this.rememberSession(sessionId, trusted);
      return { ...trusted, capabilities: [...trusted.capabilities] };
    }
    return { mode: 'STANDARD', capabilities: [], updatedAt: new Date(0).toISOString() };
  }

  public setAuthorizationMode(mode: AuthorizationMode, sessionId = 'default'): AuthorizationState {
    const capabilities = mode === 'STANDARD' ? [] : mode === 'FULL_CONTROL' ? [...FULL_CONTROL_CAPABILITIES] : [...TRUSTED_CAPABILITIES];
    const state = { mode, capabilities, updatedAt: new Date().toISOString() };
    this.rememberSession(sessionId, state);
    persistAuthorizationState(this.storage, sessionId, state);
    this.notify(sessionId, state);
    return this.getAuthorizationState(sessionId);
  }

  public hasCapability(capability: ComputerCapability, sessionId = 'default'): boolean {
    return this.getAuthorizationState(sessionId).capabilities.includes(capability);
  }

  public grantCapability(capability: ComputerCapability, sessionId = 'default'): AuthorizationState {
    const current = this.getAuthorizationState(sessionId);
    const capabilities = current.capabilities.includes(capability) ? current.capabilities : [...current.capabilities, capability];
    const mode = current.mode === 'STANDARD' ? 'TRUSTED' : current.mode;
    const state = { mode, capabilities, updatedAt: new Date().toISOString() };
    this.rememberSession(sessionId, state);
    persistAuthorizationState(this.storage, sessionId, state);
    this.notify(sessionId, state);
    return this.getAuthorizationState(sessionId);
  }

  public revokeCapability(capability: ComputerCapability, sessionId = 'default'): AuthorizationState {
    const current = this.getAuthorizationState(sessionId);
    const state = { mode: current.mode === 'FULL_CONTROL' ? 'TRUSTED' : current.mode, capabilities: current.capabilities.filter((entry) => entry !== capability), updatedAt: new Date().toISOString() };
    this.rememberSession(sessionId, state);
    persistAuthorizationState(this.storage, sessionId, state);
    this.notify(sessionId, state);
    return this.getAuthorizationState(sessionId);
  }

  public subscribe(listener: (event: AuthorizationChangedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private restoreFromStorage(sessionId: string): AuthorizationState | null {
    if (!sessionId || sessionId === 'default' || !isStableAuthorizationId(sessionId)) return null;
    const persisted = loadAuthorizationState(this.storage, sessionId);
    if (!persisted) return null;
    this.sessions.set(sessionId, persisted);
    return persisted;
  }

  private notify(sessionId: string, state: AuthorizationState): void {
    const event = { sessionId, state: { ...state, capabilities: [...state.capabilities] } };
    for (const listener of this.listeners) listener(event);
  }
}

export const defaultComputerAuthorizationManager = new ComputerAuthorizationManager();