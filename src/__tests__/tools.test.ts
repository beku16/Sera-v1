import { describe, it, expect, vi } from 'vitest';
import { validateUrl, openWebsiteTool } from '../tools/tools/openWebsite';
import { ToolManager } from '../tools/ToolManager';
import { ToolPermissionLevel } from '../tools/types';
import { setAtmosphericPaletteTool } from '../tools/tools/paletteTools';
import { openBrowserUrl } from '../gemini/LiveSession';
import { computerInputTool } from '../tools/tools/computerControlTools';

describe('Tool System & openWebsite', () => {
  describe('validateUrl', () => {
    it('accepts valid HTTPS and HTTP URLs', () => {
      const httpsRes = validateUrl('https://google.com');
      expect(httpsRes.valid).toBe(true);
      expect(httpsRes.normalizedUrl).toBe('https://google.com/');

      const httpRes = validateUrl('http://example.com/test');
      expect(httpRes.valid).toBe(true);
      expect(httpRes.normalizedUrl).toBe('http://example.com/test');
    });

    it('auto-prepends https:// to bare domain names', () => {
      const bareRes = validateUrl('github.com');
      expect(bareRes.valid).toBe(true);
      expect(bareRes.normalizedUrl).toBe('https://github.com/');
    });

    it('rejects forbidden malicious schemes', () => {
      expect(validateUrl('javascript:alert(1)').valid).toBe(false);
      expect(validateUrl('data:text/html,<h1>XSS</h1>').valid).toBe(false);
      expect(validateUrl('file:///etc/passwd').valid).toBe(false);
      expect(validateUrl('blob:http://evil.com').valid).toBe(false);
    });

    it('rejects empty or malformed inputs', () => {
      expect(validateUrl('').valid).toBe(false);
      expect(validateUrl('not-a-url').valid).toBe(false);
    });
  });

  it('opens a browser URL with one window.open call and no fallback launch', () => {
    const open = vi.fn(() => ({ closed: false }));
    vi.stubGlobal('window', { open });

    expect(openBrowserUrl('https://www.youtube.com/')).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('does not try a second navigation when the popup handle is unavailable', () => {
    const open = vi.fn(() => null);
    vi.stubGlobal('window', { open });

    expect(openBrowserUrl('https://www.youtube.com/')).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  describe('ToolManager', () => {
    it('registers and retrieves tools by name', () => {
      const manager = new ToolManager();
      manager.registerTool(openWebsiteTool);

      const retrieved = manager.getTool('openWebsite');
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('openWebsite');
    });

    it('generates valid Gemini FunctionDeclarations', () => {
      const manager = new ToolManager();
      manager.registerTool(openWebsiteTool);

      const decls = manager.getGeminiFunctionDeclarations();
      expect(decls.length).toBe(1);
      expect(decls[0].name).toBe('openWebsite');
      expect(decls[0].parameters.type).toBe('OBJECT');
      expect(decls[0].parameters.properties.url).toBeDefined();
      expect(decls[0].parameters.required).toContain('url');
    });

    it('preserves nested array metadata inside Gemini function declarations', () => {
      const manager = new ToolManager();
      manager.registerTool(computerInputTool);

      const decls = manager.getGeminiFunctionDeclarations();
      const inputTool = decls.find((decl) => decl.name === 'controlComputerInput');

      expect(inputTool).toBeDefined();
      expect(inputTool?.parameters.properties.keys).toMatchObject({
        type: 'ARRAY',
        description: 'Recognized keys for a hotkey.',
        items: { type: 'STRING' },
      });
    });

    it('validates arguments and executes registered tools', async () => {
      const manager = new ToolManager();
      manager.registerTool(openWebsiteTool);

      // Invalid arguments
      const invalidExec = await manager.executeTool('openWebsite', { url: 'javascript:void(0)' });
      expect(invalidExec.success).toBe(false);
      expect(invalidExec.error).toBeDefined();

      // Valid execution
      const validExec = await manager.executeTool('openWebsite', { url: 'https://wikipedia.org' });
      expect(validExec.success).toBe(true);
      expect((validExec.data as any)?.domain).toBe('wikipedia.org');
    });

    it('handles non-existent tools with clear error', async () => {
      const manager = new ToolManager();
      const res = await manager.executeTool('nonExistentTool', {});
      expect(res.success).toBe(false);
      expect(res.error).toContain('not registered');
    });

    it('executes an idempotent execution key only once', async () => {
      const manager = new ToolManager();
      const execute = vi.fn(async () => ({ success: true, data: { ok: true } }));
      manager.registerTool({
        ...setAtmosphericPaletteTool,
        name: 'countedTool',
        execute,
      });

      const [first, second] = await Promise.all([
        manager.executeTool('countedTool', { palette: 'cyber-emerald' }, { executionId: 'session:call-1' }),
        manager.executeTool('countedTool', { palette: 'cyber-emerald' }, { executionId: 'session:call-1' }),
      ]);

      expect(first).toEqual(second);
      expect(execute).toHaveBeenCalledTimes(1);

      const repeated = await manager.executeTool(
        'countedTool',
        { palette: 'cyber-emerald' },
        { executionId: 'session:call-1' }
      );
      expect(repeated).toEqual(first);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('executes atmospheric palette changes and rejects unknown palettes', async () => {
      const manager = new ToolManager();
      manager.registerTool(setAtmosphericPaletteTool);

      const valid = await manager.executeTool('setAtmosphericPalette', { palette: 'cyber-emerald' });
      expect(valid.success).toBe(true);
      expect(valid.data).toEqual({ palette: 'cyber-emerald', name: 'Cyber Emerald' });

      const invalid = await manager.executeTool('setAtmosphericPalette', { palette: 'unknown' });
      expect(invalid.success).toBe(false);
      expect(invalid.error).toContain('Unknown atmospheric palette');
    });
  });
});
