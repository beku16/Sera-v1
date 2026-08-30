import type { Server } from 'node:http';

/**
 * listenWithFallback — port resilience for the SERA backend (BUG L3, v1.9.0).
 *
 * Previously `server.listen(PORT)` with a busy port rejected with EADDRINUSE
 * and setupApp() caught it → `process.exit(1)`: the Electron shell showed a
 * dead window and the user had NO app and NO explanation. Now the bind
 * falls back to an ephemeral port (`listen(0)`), the caller is told about
 * the fallback, and the handshake file / stdout marker point everyone at
 * the ACTUAL port.
 */

export interface ListenResult {
  /** The port the server actually bound to. */
  port: number;
  /** True when the preferred port was busy and an ephemeral one was used. */
  fellBack: boolean;
  /** Error code that triggered the fallback (null when no fallback). */
  fallbackReason: string | null;
}

export type FallbackServer = Server & { address(): { port: number } | string | null };

const FALLBACK_CODES = new Set(['EADDRINUSE', 'EACCES']);

function listenOnce(server: FallbackServer, port: number, bindHost: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, bindHost);
  });
}

/**
 * Binds `server` to `port`; on EADDRINUSE/EACCES retries once with an
 * ephemeral port. Any other error rejects (genuine misconfiguration must
 * still fail loudly).
 */
export async function listenWithFallback(
  server: FallbackServer,
  options: { port: number; bindHost: string },
): Promise<ListenResult> {
  try {
    await listenOnce(server, options.port, options.bindHost);
    return { port: options.port, fellBack: false, fallbackReason: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (!FALLBACK_CODES.has(code)) throw err;
    await listenOnce(server, 0, options.bindHost);
    const bound = server.address();
    const port = typeof bound === 'object' && bound ? bound.port : 0;
    return { port, fellBack: true, fallbackReason: code };
  }
}
