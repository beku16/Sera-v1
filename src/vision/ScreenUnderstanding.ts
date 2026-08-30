import { ActionError, ACTION_ERROR_CODES } from '../actions/errors';
import { ScreenController, ScreenFrame } from '../actions/ControlProviders';
import { WindowControlProvider, WindowInfo } from '../actions/WindowExecutor';
import { OcrProvider, OcrWord, ScreenObservation, UiElement } from './types';

const ERROR_PATTERN = /\b(error|failed|failure|warning|denied|invalid| not found|cannot|could not)\b/i;

function classify(text: string): UiElement['type'] {
  if (/button|submit|ok|cancel|close|search|download|play|pause|enter/i.test(text)) return 'button';
  if (/input|search|name|email|password|address/i.test(text)) return 'field';
  if (/menu|file|edit|view|settings|help/i.test(text)) return 'menu';
  return 'text';
}

function wordElement(word: OcrWord, frame: ScreenFrame): UiElement {
  const scaleX = frame.scaleX || 1;
  const scaleY = frame.scaleY || 1;
  const originX = frame.originX || 0;
  const originY = frame.originY || 0;
  const x = originX + word.bbox.x0 * scaleX;
  const y = originY + word.bbox.y0 * scaleY;
  const width = Math.max(1, (word.bbox.x1 - word.bbox.x0) * scaleX);
  const height = Math.max(1, (word.bbox.y1 - word.bbox.y0) * scaleY);
  return {
    type: classify(word.text),
    role: classify(word.text),
    label: word.text,
    text: word.text,
    x,
    y,
    width,
    height,
    enabled: true,
    visible: true,
    clickable: classify(word.text) === 'button',
    source: 'ocr',
    confidence: word.confidence,
  };
}

export class ScreenUnderstanding {
  constructor(
    private readonly screen: ScreenController,
    private readonly windows: WindowControlProvider,
    private readonly ocr: OcrProvider
  ) {}

  public async inspectScreen(region?: { x: number; y: number; width: number; height: number }): Promise<ScreenObservation> {
    // Auto-start sharing on demand. Previously this method threw
    // `PERMISSION_DENIED: Screen sharing must be enabled before inspection.`
    // whenever the caller hadn't first run `controlScreen({operation:startSharing})`.
    // The system prompt explicitly tells the model that
    //   "controlScreen({operation:'inspect'}) and captureScreenshot work
    //    without needing a separate controlScreen({operation:'startSharing'})
    //    call first — sharing auto-starts on demand."
    // but the code contradicted the prompt — direct contradiction, broken
    // feature. Now we silently start sharing if it isn't active, mirroring
    // the existing behaviour in ScreenExecutor.screen.inspect.
    if (!this.screen.isSharing()) {
      try { await this.screen.startSharing(); } catch { /* fall through; capture() will still work or throw a clearer error */ }
    }
    const frame = region && this.screen.captureRegion ? await this.screen.captureRegion(region.x, region.y, region.width, region.height) : await this.screen.capture();
    const active = await this.windows.getActive();
    const words = await this.ocr.recognize(frame);
    return this.observation(frame, active, words);
  }

  public async locateElement(query: string, minimumConfidence = 0.7): Promise<UiElement | null> {
    if (!query.trim()) throw new ActionError(ACTION_ERROR_CODES.INVALID_ARGUMENT, 'An element description is required.');
    const observation = await this.inspectScreen();
    const normalized = query.trim().toLowerCase();
    const matches = observation.elements.filter((element) => `${element.label || ''} ${element.text || ''}`.toLowerCase().includes(normalized));
    if (matches.length === 0) return null;
    const match = matches.sort((a, b) => b.confidence - a.confidence)[0];
    return match.confidence >= minimumConfidence ? match : null;
  }

  private observation(frame: ScreenFrame, active: WindowInfo | undefined, words: OcrWord[]): ScreenObservation {
    const elements = words.map((word) => wordElement(word, frame));
    const errors = elements
      .filter((element) => ERROR_PATTERN.test(element.text || ''))
      .map((element) => ({ text: element.text || '', confidence: element.confidence, element }));
    return {
      capturedAt: frame.capturedAt,
      application: active?.application,
      window: active,
      text: words.map((word) => word.text).join(' '),
      elements,
      regions: [],
      visibleControls: elements.filter((element) => element.clickable || element.type === 'field' || element.type === 'menu'),
      errors,
      frame: { width: frame.width, height: frame.height, capturedAt: frame.capturedAt },
      cursor: frame.cursor || null,
      freshnessMs: Math.max(0, Date.now() - new Date(frame.capturedAt).getTime()),
      cursorStatus: frame.cursor ? 'available' : 'unavailable',
    };
  }
}
