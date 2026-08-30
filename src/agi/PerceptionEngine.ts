import { ToolManager } from '../tools/ToolManager';

/**
 * Snapshot of the observable desktop state at a moment in time.
 */
export interface DesktopSnapshot {
  capturedAt: number;
  windows: Array<{
    title: string;
    application?: string;
    processId?: number;
    isMinimized?: boolean;
    handle?: string | number;
  }>;
  activeWindow?: {
    title: string;
    application?: string;
  };
  /** OCR text of the screen, when capture succeeded. */
  screenText?: string;
  notes: string[];
}

/**
 * The Perception engine of the AGI loop.
 *
 * Uses SERA's own tools (listWindows, getActiveWindow, inspectScreen) to
 * build a snapshot of the desktop. Used both for planning context and
 * for verification ("did the OS actually change the way we expected?").
 */
export class PerceptionEngine {
  constructor(private readonly toolManager: ToolManager) {}

  /**
   * Captures a desktop snapshot. Every probe is best-effort — a failing
   * probe adds a note instead of throwing, so verification can still
   * proceed with partial state.
   */
  public async perceive(options: { includeOcr?: boolean; sessionId?: string } = {}): Promise<DesktopSnapshot> {
    const notes: string[] = [];
    const snapshot: DesktopSnapshot = { capturedAt: Date.now(), windows: [], notes };

    // 1. Enumerate windows.
    try {
      const windowsResult = await this.toolManager.executeTool('listWindows', {}, { sessionId: options.sessionId });
      if (windowsResult.success) {
        const data = windowsResult.data as { windows?: Array<Record<string, unknown>> } | undefined;
        snapshot.windows = (data?.windows || []).map((w) => ({
          title: String(w.title ?? ''),
          application: typeof w.application === 'string' ? w.application : typeof w.ownerName === 'string' ? String(w.ownerName) : undefined,
          processId: typeof w.processId === 'number' ? w.processId : undefined,
          isMinimized: Boolean(w.isMinimized),
          handle: (w.handle as string | number | undefined) ?? undefined,
        }));
      } else {
        notes.push(`listWindows failed: ${windowsResult.error || 'unknown error'}`);
      }
    } catch (err) {
      notes.push(`listWindows threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. Active window.
    try {
      const activeResult = await this.toolManager.executeTool('getActiveWindow', {}, { sessionId: options.sessionId });
      if (activeResult.success && activeResult.data) {
        const data = activeResult.data as Record<string, unknown>;
        snapshot.activeWindow = {
          title: String(data.title ?? ''),
          application: typeof data.application === 'string' ? data.application : typeof data.ownerName === 'string' ? String(data.ownerName) : undefined,
        };
      }
    } catch (err) {
      notes.push(`getActiveWindow threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. Optional OCR of the screen.
    if (options.includeOcr) {
      try {
        const inspectResult = await this.toolManager.executeTool('inspectScreen', {}, { sessionId: options.sessionId });
        if (inspectResult.success && inspectResult.data) {
          const data = inspectResult.data as Record<string, unknown>;
          snapshot.screenText = typeof data.text === 'string' ? data.text : typeof data.ocrText === 'string' ? String(data.ocrText) : undefined;
          if (!snapshot.screenText) notes.push('inspectScreen returned no text field.');
        } else {
          notes.push(`inspectScreen failed: ${inspectResult.error || 'unknown error'}`);
        }
      } catch (err) {
        notes.push(`inspectScreen threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return snapshot;
  }

  /**
   * Evaluates a verification expectation against a fresh snapshot.
   * Returns { verified, detail } — never throws.
   */
  public async verify(
    expectation: { kind: string; value?: string; description?: string },
    options: { sessionId?: string } = {},
  ): Promise<{ verified: boolean; detail: string }> {
    try {
      switch (expectation.kind) {
        case 'tool_success':
          // Pure tool-result verification is handled by the executor.
          return { verified: true, detail: 'tool-level success accepted' };

        case 'window_visible': {
          const snapshot = await this.perceive({ sessionId: options.sessionId });
          const needle = (expectation.value || '').toLowerCase();
          if (!needle) return { verified: snapshot.windows.length > 0, detail: `checked any window (found ${snapshot.windows.length})` };
          const found = snapshot.windows.find((w) =>
            w.title.toLowerCase().includes(needle) || (w.application || '').toLowerCase().includes(needle),
          );
          return {
            verified: Boolean(found),
            detail: found ? `window "${found.title}" visible` : `no window matching "${needle}" among ${snapshot.windows.length} windows`,
          };
        }

        case 'text_contains': {
          const snapshot = await this.perceive({ includeOcr: true, sessionId: options.sessionId });
          const text = (snapshot.screenText || '').toLowerCase().replace(/\s+/g, '');
          const needle = (expectation.value || '').toLowerCase().replace(/\s+/g, '');
          if (!needle) return { verified: text.length > 0, detail: 'screen produced OCR text' };
          return {
            verified: text.includes(needle),
            detail: text.includes(needle) ? `OCR contains "${expectation.value}"` : `OCR does not contain "${expectation.value}"`,
          };
        }

        case 'clipboard_equals': {
          const result = await this.toolManager.executeTool('getClipboard', {}, { sessionId: options.sessionId });
          const actual = result.success && result.data && typeof (result.data as Record<string, unknown>).content === 'string'
            ? String((result.data as Record<string, unknown>).content)
            : '';
          return {
            verified: actual === expectation.value,
            detail: actual === expectation.value ? 'clipboard matches expected value' : `clipboard mismatch (expected "${expectation.value}", got "${actual.slice(0, 80)}")`,
          };
        }

        case 'process_running':
        default:
          // Unknown kinds degrade to accepted (tool-level success already checked).
          return { verified: true, detail: `verification kind "${expectation.kind}" not directly observable — accepted on tool success` };
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { verified: false, detail: `verification error: ${detail}` };
    }
  }

  /** Compact natural-language summary used in planner prompts and logs. */
  public summarize(snapshot: DesktopSnapshot): string {
    const lines = [
      `Windows(${snapshot.windows.length}): ${snapshot.windows.slice(0, 8).map((w) => w.title || w.application || '?').join(' | ') || '(none)'}`,
    ];
    if (snapshot.activeWindow) lines.push(`Active: ${snapshot.activeWindow.title || snapshot.activeWindow.application || '(unknown)'}`);
    if (snapshot.screenText) lines.push(`Screen text (first 200): ${snapshot.screenText.slice(0, 200)}`);
    if (snapshot.notes.length) lines.push(`Notes: ${snapshot.notes.join('; ')}`);
    return lines.join('\n');
  }
}
