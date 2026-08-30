import { describe, expect, it } from 'vitest';
import { getStableAuthorizationId, KeyValueStorage, loadAuthorizationState, persistAuthorizationState } from '../authorization/AuthorizationIdentity';
import { ComputerAuthorizationManager } from '../authorization/ComputerAuthorizationManager';

class MemoryStorage implements KeyValueStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) || null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe('stable authorization identity', () => {
  it('reuses the same identity across session restarts', () => {
    const storage = new MemoryStorage();
    const first = getStableAuthorizationId(storage, () => 'first');
    const second = getStableAuthorizationId(storage, () => 'second');

    expect(first.startsWith('auth-')).toBe(true);
    expect(second).toBe(first);
  });

  it('persists authorization state under the stable identity so reconnects restore capability grants', () => {
    const storage = new MemoryStorage();
    const authId = getStableAuthorizationId(storage, () => 'persisted');
    persistAuthorizationState(storage, authId, {
      mode: 'TRUSTED',
      capabilities: ['MOUSE_CONTROL', 'KEYBOARD_CONTROL'],
      updatedAt: '2025-01-01T00:00:00.000Z',
    });

    const restored = loadAuthorizationState(storage, authId);
    expect(restored).toMatchObject({
      mode: 'TRUSTED',
      capabilities: ['MOUSE_CONTROL', 'KEYBOARD_CONTROL'],
    });
  });

  it('restores a granted capability after reconnect when the same stable identity is reused', () => {
    const storage = new MemoryStorage();
    const authId = getStableAuthorizationId(storage, () => 'reconnect');
    const first = new ComputerAuthorizationManager(storage);
    first.setAuthorizationMode('TRUSTED', authId);
    expect(first.hasCapability('MOUSE_CONTROL', authId)).toBe(true);

    const second = new ComputerAuthorizationManager(storage);
    expect(second.hasCapability('MOUSE_CONTROL', authId)).toBe(true);
  });

  it('denies access when a grant is stored under a different unrelated stable identity', () => {
    const storage = new MemoryStorage();
    const authorizedId = 'auth-authorized-user';
    const unrelatedId = 'auth-unrelated-user';
    const manager = new ComputerAuthorizationManager(storage);
    manager.setAuthorizationMode('TRUSTED', authorizedId);

    expect(manager.hasCapability('MOUSE_CONTROL', unrelatedId)).toBe(false);
    expect(loadAuthorizationState(storage, unrelatedId)).toBeNull();
    expect(loadAuthorizationState(storage, authorizedId)).toMatchObject({ mode: 'TRUSTED' });
  });

  it('denies restored capabilities after revoke and reconnect', () => {
    const storage = new MemoryStorage();
    const authId = getStableAuthorizationId(storage, () => 'revoke');
    const manager = new ComputerAuthorizationManager(storage);
    manager.setAuthorizationMode('TRUSTED', authId);
    manager.revokeCapability('MOUSE_CONTROL', authId);

    const restored = new ComputerAuthorizationManager(storage);
    expect(restored.hasCapability('MOUSE_CONTROL', authId)).toBe(false);
  });

  it('denies restored capabilities after a STANDARD reset and reconnect', () => {
    const storage = new MemoryStorage();
    const authId = getStableAuthorizationId(storage, () => 'reset');
    const manager = new ComputerAuthorizationManager(storage);
    manager.setAuthorizationMode('FULL_CONTROL', authId);
    manager.setAuthorizationMode('STANDARD', authId);

    const restored = new ComputerAuthorizationManager(storage);
    expect(restored.hasCapability('SYSTEM_SETTINGS', authId)).toBe(false);
    expect(restored.getAuthorizationState(authId).mode).toBe('STANDARD');
  });

  it('keeps multiple capabilities restored independently across reconnect', () => {
    const storage = new MemoryStorage();
    const authId = getStableAuthorizationId(storage, () => 'multi');
    const manager = new ComputerAuthorizationManager(storage);
    manager.setAuthorizationMode('TRUSTED', authId);
    manager.grantCapability('SYSTEM_SETTINGS', authId);

    const restored = new ComputerAuthorizationManager(storage);
    expect(restored.hasCapability('MOUSE_CONTROL', authId)).toBe(true);
    expect(restored.hasCapability('KEYBOARD_CONTROL', authId)).toBe(true);
    expect(restored.hasCapability('SYSTEM_SETTINGS', authId)).toBe(true);
  });

  it('does not persist when no storage is available', () => {
    const first = getStableAuthorizationId(null, () => 'first');
    const second = getStableAuthorizationId(null, () => 'second');
    expect(first).not.toBe(second);
  });
});

