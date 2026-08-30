import { ScreenFrame } from '../actions/ControlProviders';
import { WindowInfo } from '../actions/WindowExecutor';

export type VisionSource = 'accessibility' | 'dom' | 'ocr' | 'vision';

export interface UiElement {
  type: 'text' | 'button' | 'field' | 'link' | 'checkbox' | 'menu' | 'unknown';
  role?: string;
  label?: string;
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  enabled?: boolean;
  visible: boolean;
  clickable?: boolean;
  focused?: boolean;
  source: VisionSource;
  confidence: number;
}

export interface ScreenObservation {
  capturedAt: string;
  application?: string;
  window?: WindowInfo;
  text: string;
  elements: UiElement[];
  regions: Array<{ label: string; x: number; y: number; width: number; height: number; confidence: number; source: VisionSource }>;
  visibleControls: UiElement[];
  errors: Array<{ text: string; confidence: number; element?: UiElement }>;
  frame: Pick<ScreenFrame, 'width' | 'height' | 'capturedAt'>;
  cursor: ScreenFrame['cursor'];
  freshnessMs: number;
  cursorStatus: 'available' | 'unavailable';
}

export interface OcrWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface OcrProvider {
  recognize(frame: ScreenFrame): Promise<OcrWord[]>;
  close?(): Promise<void>;
}
