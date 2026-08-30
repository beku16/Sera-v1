/**
 * Copy text to the operating-system clipboard with layered fallbacks.
 *
 * Why this exists: the chat UI previously called
 * `navigator.clipboard.writeText()` fire-and-forget. Inside Electron that
 * API is unreliable — depending on window focus state and permission
 * quirks the promise rejects (or the API is entirely absent when the
 * renderer is not a secure context), and because the old code never
 * awaited or caught anything, the button showed the "copied" checkmark
 * while the clipboard stayed empty. Users experienced this as "the copy
 * button doesn't work".
 *
 * Strategy, most → least reliable:
 *  1. Electron main-process bridge (`window.seraDesktop.clipboardWrite`)
 *     — always works, no secure-context or focus requirements.
 *  2. Async Clipboard API — works in normal browsers on http(s)/localhost.
 *  3. Legacy `document.execCommand('copy')` via an off-screen textarea —
 *     last resort for non-secure contexts.
 *
 * Returns true only when a strategy actually succeeded, so callers can
 * show honest feedback instead of a fake checkmark.
 */
type DesktopBridge = { clipboardWrite?: (text: string) => Promise<boolean> };

export async function writeClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  // 1) Electron bridge (exposed by electron/preload.cjs).
  const bridge = (window as unknown as { seraDesktop?: DesktopBridge }).seraDesktop;
  if (typeof bridge?.clipboardWrite === 'function') {
    try {
      if (await bridge.clipboardWrite(text)) return true;
    } catch { /* fall through to the next strategy */ }
  }

  // 2) Standard async Clipboard API (secure contexts).
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the last strategy */ }

  // 3) Legacy execCommand fallback.
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-9999px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
