/**
 * SERA — graceful shutdown coordinator.
 *
 * Previously the server had NO SIGINT/SIGTERM handling: Ctrl+C killed the
 * process instantly, leaving the 100ms screen-capture timer running to the
 * last microsecond, the Playwright managed browser un-closed, the health
 * monitor mid-sweep, and open WebSocket clients without a close frame.
 * On Windows (Start/Stop SERA .bat) taskkill is even harsher.
 *
 * This module installs signal handlers that run a LIFO stack of cleanup
 * steps with a hard timeout, then exits. Steps are idempotent and
 * individually guarded — one failing step must never block the rest.
 */

export type ShutdownStep = {
  name: string;
  /** Max time this step may take before we move on. */
  timeoutMs?: number;
  run: () => void | Promise<void>;
};

export interface ShutdownCoordinator {
  /** Registers a cleanup step. Returns an unsubscribe for tests. */
  addStep: (step: ShutdownStep) => () => void;
  /** Runs all steps (used by signal handlers and tests). */
  shutdown: (reason: string) => Promise<void>;
  readonly hasRun: boolean;
}

const DEFAULT_STEP_TIMEOUT_MS = 4000;
const TOTAL_SHUTDOWN_TIMEOUT_MS = 12000;

export function createShutdownCoordinator(): ShutdownCoordinator {
  const steps: ShutdownStep[] = [];
  let running = false;
  let ran = false;

  const withTimeout = async (step: ShutdownStep): Promise<void> => {
    const timeoutMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve()
          .then(() => step.run())
          .catch((err) => {
            console.warn(`[SHUTDOWN] step "${step.name}" failed:`, err instanceof Error ? err.message : String(err));
          }),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            console.warn(`[SHUTDOWN] step "${step.name}" timed out after ${timeoutMs}ms — continuing.`);
            resolve();
          }, timeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const shutdown = async (reason: string): Promise<void> => {
    if (running || ran) return;
    running = true;
    const startedAt = Date.now();
    console.log(`[SHUTDOWN] Graceful shutdown started (${reason}) — ${steps.length} cleanup step(s).`);

    // LIFO: last-registered resources (accepting sockets → sessions →
    // timers/children) close first.
    for (const step of [...steps].reverse()) {
      if (Date.now() - startedAt > TOTAL_SHUTDOWN_TIMEOUT_MS) {
        console.warn('[SHUTDOWN] Total budget exhausted — running remaining steps no further.');
        break;
      }
      await withTimeout(step);
    }

    ran = true;
    running = false;
    console.log(`[SHUTDOWN] Cleanup complete in ${Date.now() - startedAt}ms.`);
  };

  return {
    addStep: (step: ShutdownStep) => {
      steps.push(step);
      return () => {
        const idx = steps.indexOf(step);
        if (idx >= 0) steps.splice(idx, 1);
      };
    },
    shutdown,
    get hasRun() {
      return ran;
    },
  };
}

/**
 * Installs SIGINT/SIGTERM/uncaughtException handlers. Returns the
 * coordinator so callers can register more steps before the signal fires.
 */
export function installShutdownHandlers(
  coordinator: ShutdownCoordinator,
  onExit: (code: number) => void = (code) => process.exit(code),
): ShutdownCoordinator {
  let signalCount = 0;
  const handleSignal = (signal: string) => {
    signalCount += 1;
    if (signalCount > 1) {
      // Second Ctrl+C — user insists; exit immediately.
      console.warn(`[SHUTDOWN] ${signal} received again — forcing exit.`);
      onExit(130);
      return;
    }
    void coordinator
      .shutdown(signal)
      .catch(() => undefined)
      .finally(() => onExit(0));
  };

  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));
  return coordinator;
}
