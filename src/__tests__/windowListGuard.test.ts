/**
 * Regression guard: WindowsWindowProvider.list() / getActive() must degrade to
 * empty results when the active-win native binding is unavailable (Linux
 * without libx11, sandboxed or degraded desktop sessions) — it used to crash
 * the AGI perception loop with "Cannot read properties of undefined
 * (reading 'map')".
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

const getOpenWindowsSync = vi.fn(() => undefined as unknown as ReturnType<never>);
const sync = vi.fn(() => undefined as unknown as ReturnType<never>);

vi.mock('active-win', () => ({
  default: { getOpenWindowsSync, sync },
  __esModule: true,
}));

describe('WindowsWindowProvider degraded-native guards', () => {
  let WindowsWindowProvider: typeof import('../actions/WindowExecutor').WindowsWindowProvider;
  let provider: InstanceType<typeof WindowsWindowProvider>;

  beforeAll(async () => {
    ({ WindowsWindowProvider } = await import('../actions/WindowExecutor'));
    provider = new WindowsWindowProvider();
  });

  it('list() returns [] instead of crashing when getOpenWindowsSync yields undefined', async () => {
    await expect(provider.list()).resolves.toEqual([]);
    expect(getOpenWindowsSync).toHaveBeenCalled();
  });

  it('list() returns [] when the native function itself is missing', async () => {
    getOpenWindowsSync.mockImplementation(undefined as never);
    await expect(provider.list()).resolves.toEqual([]);
  });

  it('getActive() returns undefined instead of crashing when sync yields undefined', async () => {
    await expect(provider.getActive()).resolves.toBeUndefined();
    expect(sync).toHaveBeenCalled();
  });

  it('list() maps real window payloads through toWindowInfo and drops empty titles', async () => {
    getOpenWindowsSync.mockImplementation(() => [
      {
        id: 111,
        title: 'Notepad - hello.txt',
        owner: { name: 'notepad.exe', processId: 4242, path: 'C:\\Windows\\notepad.exe' },
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      },
      { id: 222, title: '   ', owner: { name: 'ghost.exe', processId: 1, path: '' }, bounds: {} },
    ] as never);
    const windows = await provider.list();
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ handle: '111', application: 'notepad.exe', title: 'Notepad - hello.txt' });
  });
});
