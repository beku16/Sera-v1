import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ActionManager } from '../actions/ActionManager';
import { ClipboardExecutor } from '../actions/ClipboardExecutor';
import { ClipboardProvider } from '../clipboard/ClipboardManager';
import { getClipboardTool, setClipboardTool, pasteClipboardTool } from '../tools/tools/clipboardTools';
import { ComputerAuthorizationManager } from '../authorization/ComputerAuthorizationManager';

// Mock clipboard provider for testing
class MockClipboardProvider implements ClipboardProvider {
  private clipboard = '';

  async get(): Promise<string | null> {
    return this.clipboard || null;
  }

  async set(content: string): Promise<boolean> {
    this.clipboard = content;
    return true;
  }

  reset(): void {
    this.clipboard = '';
  }
}

describe('Clipboard Operations', () => {
  let actionManager: ActionManager;
  let clipboardExecutor: ClipboardExecutor;
  let mockProvider: MockClipboardProvider;

  beforeEach(() => {
    mockProvider = new MockClipboardProvider();
    clipboardExecutor = new ClipboardExecutor(mockProvider);
    actionManager = new ActionManager();
    actionManager.registerExecutor(clipboardExecutor);
  });

  afterEach(() => {
    mockProvider.reset();
  });

  describe('Clipboard Get', () => {
    it('should handle clipboard.get action', async () => {
      await mockProvider.set('test content');
      const action = actionManager.createAction({
        type: 'clipboard.get',
        parameters: {},
      });
      const result = await actionManager.execute(action);
      expect(result.status).toBe('succeeded');
      expect(result.result).toHaveProperty('operation', 'get');
      expect(result.result).toHaveProperty('length');
      expect((result.result as any).length).toBe('test content'.length);
    });

    it('should return failure when clipboard is empty', async () => {
      const action = actionManager.createAction({
        type: 'clipboard.get',
        parameters: {},
      });
      const result = await actionManager.execute(action);
      expect(result.status).toBe('failed');
    });
  });

  describe('Clipboard Set', () => {
    it('should set clipboard content and verify', async () => {
      const testContent = 'Hello, Clipboard!';
      const action = actionManager.createAction({
        type: 'clipboard.set',
        parameters: { content: testContent },
      });
      const result = await actionManager.execute(action);
      expect(result.status).toBe('succeeded');
      expect(result.result).toHaveProperty('operation', 'set');
      expect(result.result).toHaveProperty('length', testContent.length);
      const verification = await mockProvider.get();
      expect(verification).toBe(testContent);
    });

    it('should handle unicode content', async () => {
      const unicodeContent = '🎉 Hello 世界 Привет';
      const action = actionManager.createAction({
        type: 'clipboard.set',
        parameters: { content: unicodeContent },
      });
      const result = await actionManager.execute(action);
      expect(result.status).toBe('succeeded');
      const verification = await mockProvider.get();
      expect(verification).toBe(unicodeContent);
    });

    it('should handle multiline content', async () => {
      const multilineContent = 'Line 1\nLine 2\nLine 3';
      const action = actionManager.createAction({
        type: 'clipboard.set',
        parameters: { content: multilineContent },
      });
      const result = await actionManager.execute(action);
      expect(result.status).toBe('succeeded');
      const verification = await mockProvider.get();
      expect(verification).toBe(multilineContent);
    });

    it('should reject empty content', async () => {
      const action = actionManager.createAction({
        type: 'clipboard.set',
        parameters: { content: '' },
      });
      const result = await actionManager.execute(action);
      expect(result.status).toBe('failed');
    });
  });

  describe('Clipboard Verification', () => {
    it('should verify get operation with non-empty content', async () => {
      await mockProvider.set('test');
      const action = actionManager.createAction({
        type: 'clipboard.get',
        parameters: {},
      });
      const result = await actionManager.execute(action);
      const verification = await clipboardExecutor.verify(action, result);
      expect(verification.status).toBe('success');
    });

    it('should verify set operation with matching content', async () => {
      const content = 'verify me';
      const action = actionManager.createAction({
        type: 'clipboard.set',
        parameters: { content },
      });
      const result = await actionManager.execute(action);
      const verification = await clipboardExecutor.verify(action, result);
      expect(verification.status).toBe('success');
    });
  });

  describe('Clipboard Tools', () => {
    it('setClipboardTool should validate and execute', async () => {
      const validation = setClipboardTool.validateArgs({ content: 'tool test' });
      expect(validation.valid).toBe(true);
    });

    it('setClipboardTool should reject empty content', async () => {
      const validation = setClipboardTool.validateArgs({ content: '' });
      expect(validation.valid).toBe(false);
    });

    it('setClipboardTool should reject whitespace-only content', async () => {
      const validation = setClipboardTool.validateArgs({ content: '   ' });
      expect(validation.valid).toBe(false);
    });

    it('getClipboardTool should have no required parameters', async () => {
      const validation = getClipboardTool.validateArgs({});
      expect(validation.valid).toBe(true);
    });

    it('pasteClipboardTool should require KEYBOARD_CONTROL capability', () => {
      expect(pasteClipboardTool.capability).toBe('KEYBOARD_CONTROL');
    });
  });

  describe('Capability-based Authorization', () => {
    it('setClipboardTool requires CLIPBOARD_WRITE capability', () => {
      expect(setClipboardTool.capability).toBe('CLIPBOARD_WRITE');
    });

    it('getClipboardTool requires CLIPBOARD_READ capability', () => {
      expect(getClipboardTool.capability).toBe('CLIPBOARD_READ');
    });

    it('clipboard tools should enforce capability gates in STANDARD mode', () => {
      const authManager = new ComputerAuthorizationManager();
      const sessionId = 'test-session';
      
      // Default is STANDARD with no capabilities
      expect(authManager.hasCapability('CLIPBOARD_WRITE', sessionId)).toBe(false);
      expect(authManager.hasCapability('CLIPBOARD_READ', sessionId)).toBe(false);
      
      // Grant TRUSTED mode
      authManager.setAuthorizationMode('TRUSTED', sessionId);
      expect(authManager.hasCapability('CLIPBOARD_WRITE', sessionId)).toBe(true);
      expect(authManager.hasCapability('CLIPBOARD_READ', sessionId)).toBe(true);
    });
  });

  describe('Clipboard Round-trip', () => {
    it('should preserve content through get-set cycle', async () => {
      const original = 'Test content for round-trip';
      
      // Set initial content
      const setAction = actionManager.createAction({
        type: 'clipboard.set',
        parameters: { content: original },
      });
      const setResult = await actionManager.execute(setAction);
      expect(setResult.status).toBe('succeeded');
      
      // Retrieve and verify
      const getAction = actionManager.createAction({
        type: 'clipboard.get',
        parameters: {},
      });
      const getResult = await actionManager.execute(getAction);
      expect(getResult.status).toBe('succeeded');
      
      // Verify the mock provider has the right content
      const retrieved = await mockProvider.get();
      expect(retrieved).toBe(original);
    });

    it('should handle large content', async () => {
      const largeContent = 'x'.repeat(100000); // 100KB of data
      const action = actionManager.createAction({
        type: 'clipboard.set',
        parameters: { content: largeContent },
      });
      const result = await actionManager.execute(action);
      expect(result.status).toBe('succeeded');
      const verification = await mockProvider.get();
      expect(verification).toBe(largeContent);
    });
  });

  describe('Windows DefaultClipboardProvider implementation', () => {
    // Regression guard for the user-reported "clipboard writing was failing
    // verification" bug. The previous setClipboardWindows implementation
    // spawned `powershell.exe -Command "Set-Clipboard"` and piped the content
    // to stdin — which NEVER worked, because PowerShell in -Command mode
    // doesn't pipe stdin into the named cmdlet. The fix uses a temp file +
    // -EncodedCommand approach. We can't actually run PowerShell on Linux
    // CI, but we can assert that:
    //   1. DefaultClipboardProvider.set() returns false (not true) on
    //      non-Windows platforms (rather than silently lying).
    //   2. The implementation no longer references the broken stdin-pipe
    //      pattern — we verify by source inspection that the temp-file
    //      approach is in place.
    it('returns false on non-Windows hosts instead of silently reporting success', async () => {
      const originalPlatform = process.platform;
      if (originalPlatform === 'win32') {
        // On Windows we'd actually round-trip through PowerShell; skip in
        // CI runners that are Windows-based (rare for this repo's CI).
        return; // skip on actual Windows hosts because PowerShell works there
      }
      const { defaultClipboardProvider } = await import('../clipboard/ClipboardManager');
      const setResult = await defaultClipboardProvider.set('sera-probe');
      expect(setResult).toBe(false);
      const getResult = await defaultClipboardProvider.get();
      expect(getResult).toBe(null);
    });

    it('uses the temp-file + -EncodedCommand approach (no broken stdin pipe)', async () => {
      // Source-inspection guard: the broken legacy pattern was
      //   spawn('powershell.exe', [..., '-Command', 'Set-Clipboard'], { stdio: ['pipe', ...] })
      //   proc.stdin.write(content);
      //   proc.stdin.end();
      // The fixed implementation writes content to a temp file and runs
      //   powershell.exe -EncodedCommand <base64>
      // We can read the ClipboardManager.ts source and assert that the
      // broken pattern is gone and the fixed pattern is present.
      const fs = await import('node:fs');
      const path = await import('node:path');
      const source = fs.readFileSync(
        path.resolve(__dirname, '..', 'clipboard', 'ClipboardManager.ts'),
        'utf8',
      );
      // Fixed pattern must be present.
      expect(source).toContain('-EncodedCommand');
      expect(source).toContain('System.IO.File');
      expect(source).toContain('Set-Clipboard -Value');
      // Broken legacy pattern must be gone.
      expect(source).not.toContain("-Command', 'Set-Clipboard']");
      expect(source).not.toMatch(/proc\.stdin\.write\(content\)/);
    });
  });
});
