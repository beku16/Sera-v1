import type { AuthorizationState } from './ComputerAuthorizationManager';

const AUTHORIZATION_ID_KEY = 'sera_authorization_id_v1';
const AUTHORIZATION_STATE_PREFIX = 'sera_authorization_state_v1:';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STANDARD_MODES = new Set(['STANDARD', 'TRUSTED', 'FULL_CONTROL']);
const VALID_CAPABILITIES = new Set([
  'COMPUTER_READ',
  'SCREEN_INSPECTION',
  'SCREEN_CAPTURE',
  'MOUSE_CONTROL',
  'KEYBOARD_CONTROL',
  'WINDOW_CONTROL',
  'APPLICATION_LAUNCH',
  'APPLICATION_CLOSE',
  'BROWSER_CONTROL',
  'CLIPBOARD_READ',
  'CLIPBOARD_WRITE',
  'AUDIO_CONTROL',
  'DISPLAY_CONTROL',
  'SYSTEM_SETTINGS',
]);

export function getStableAuthorizationId(
  storage: KeyValueStorage | null = typeof window !== 'undefined' ? window.localStorage : null,
  randomPart: () => string = () => Math.random().toString(36).slice(2, 10),
): string {
  const existing = storage?.getItem(AUTHORIZATION_ID_KEY);
  if (existing) return existing;
  const generated = `auth-${Date.now()}-${randomPart()}`;
  storage?.setItem(AUTHORIZATION_ID_KEY, generated);
  return generated;
}

export function isStableAuthorizationId(authorizationId: string | null | undefined): boolean {
  return typeof authorizationId === 'string' && authorizationId.startsWith('auth-');
}

export function getAuthorizationStateStorageKey(authorizationId: string): string {
  return `${AUTHORIZATION_STATE_PREFIX}${authorizationId}`;
}

export function persistAuthorizationState(
  storage: KeyValueStorage | null,
  authorizationId: string,
  state: AuthorizationState,
): void {
  if (!storage || !authorizationId || !isStableAuthorizationId(authorizationId)) return;

  const serialized = JSON.stringify({
    mode: state.mode,
    capabilities: state.capabilities,
    updatedAt: state.updatedAt,
  });
  storage.setItem(getAuthorizationStateStorageKey(authorizationId), serialized);
}

export function loadAuthorizationState(
  storage: KeyValueStorage | null,
  authorizationId: string,
): AuthorizationState | null {
  if (!storage || !authorizationId || !isStableAuthorizationId(authorizationId)) return null;

  const raw = storage.getItem(getAuthorizationStateStorageKey(authorizationId));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<AuthorizationState>;
    if (!parsed || typeof parsed !== 'object') return null;

    const mode = parsed.mode;
    const capabilities = Array.isArray(parsed.capabilities) ? parsed.capabilities.filter((capability): capability is AuthorizationState['capabilities'][number] => typeof capability === 'string' && VALID_CAPABILITIES.has(capability)) : [];

    if (!mode || !STANDARD_MODES.has(mode)) return null;
    return {
      mode,
      capabilities,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}
