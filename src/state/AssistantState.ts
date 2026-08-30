import { AssistantStateType } from '../types';

export interface StateTransitionEvent {
  from: AssistantStateType;
  to: AssistantStateType;
  timestamp: number;
  reason?: string;
}

export type StateChangeListener = (state: AssistantStateType, event: StateTransitionEvent) => void;

// Valid transition map
const VALID_TRANSITIONS: Record<AssistantStateType, AssistantStateType[]> = {
  disconnected: ['connecting', 'idle', 'error'],
  connecting: ['idle', 'listening', 'disconnected', 'error'],
  idle: ['wake_word_detected', 'connecting', 'disconnected', 'error'],
  wake_word_detected: ['listening', 'processing', 'idle', 'disconnected', 'error'],
  listening: ['processing', 'speaking', 'disconnected', 'connecting', 'error'],
  processing: ['speaking', 'listening', 'idle', 'disconnected', 'error'],
  speaking: ['listening', 'processing', 'disconnected', 'connecting', 'error'],
  error: ['connecting', 'idle', 'disconnected'],
};

export class AssistantStateManager {
  private currentState: AssistantStateType = 'disconnected';
  private errorMessage: string | null = null;
  private listeners: Set<StateChangeListener> = new Set();
  private sessionStartTime: number | null = null;

  constructor(initialState: AssistantStateType = 'disconnected') {
    this.currentState = initialState;
  }

  public getState(): AssistantStateType {
    return this.currentState;
  }

  public getErrorMessage(): string | null {
    return this.errorMessage;
  }

  public getSessionDuration(): number {
    if (!this.sessionStartTime || this.currentState === 'disconnected') {
      return 0;
    }
    return Math.floor((Date.now() - this.sessionStartTime) / 1000);
  }

  /**
   * Validates and transitions to a target state
   */
  public transitionTo(targetState: AssistantStateType, reason?: string): boolean {
    if (this.currentState === targetState) {
      return true; // No-op
    }

    const allowed = VALID_TRANSITIONS[this.currentState];
    if (!allowed || !allowed.includes(targetState)) {
      console.warn(
        `[AssistantState] Invalid state transition attempted from "${this.currentState}" to "${targetState}". Ignoring.`
      );
      return false;
    }

    const from = this.currentState;
    this.currentState = targetState;

    if (targetState === 'connecting' && from === 'disconnected') {
      this.sessionStartTime = Date.now();
      this.errorMessage = null;
    } else if (targetState === 'disconnected') {
      this.sessionStartTime = null;
    }

    if (targetState !== 'error') {
      this.errorMessage = null;
    }

    const event: StateTransitionEvent = {
      from,
      to: targetState,
      timestamp: Date.now(),
      reason,
    };

    this.notifyListeners(targetState, event);
    return true;
  }

  /**
   * Helper to set error state with descriptive message
   */
  public setError(message: string): void {
    this.errorMessage = message;
    this.transitionTo('error', message);
  }

  public subscribe(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(state: AssistantStateType, event: StateTransitionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(state, event);
      } catch (err) {
        console.error('Error in state change listener:', err);
      }
    }
  }

  public reset(): void {
    // Capture the previous state BEFORE overwriting it — the previous
    // implementation set `currentState = 'disconnected'` first, then built
    // the event using `from: this.currentState`, so `from` was always
    // 'disconnected' instead of the actual prior state. Listeners relying
    // on `event.from` to detect "was previously connected, now reset"
    // could never fire.
    const from = this.currentState;
    this.currentState = 'disconnected';
    this.errorMessage = null;
    this.sessionStartTime = null;
    this.notifyListeners('disconnected', {
      from,
      to: 'disconnected',
      timestamp: Date.now(),
      reason: 'Manual reset',
    });
  }
}
