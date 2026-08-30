/**
 * SERA — dependency-free in-memory rate limiter.
 *
 * Protects the local server's EXPENSIVE endpoints (deep diagnostics scans,
 * model pulls, agent chats, desktop spawns, repairs) from accidental
 * hammering — a retry loop in the renderer, a runaway script, or a
 * misbehaving client could otherwise spawn dozens of concurrent Playwright
 * probes / child processes and starve the machine.
 *
 * Design:
 *  - Fixed-window counter per (key, route-bucket). Tiny, predictable, and
 *    good enough for a single-process local server.
 *  - NEVER applied to the realtime audio path (/api/live WS) or cheap GETs
 *    by default — only to explicitly wrapped handlers.
 *  - Keys are the socket remote address (loopback-only server ⇒ a single
 *    key in practice, which is exactly the client we want to police).
 *  - Self-pruning: windows older than 2x the interval are dropped on write.
 */
import type { Request, Response, NextFunction } from 'express';

export interface RateLimitOptions {
  /** Logical bucket name — separate budgets per endpoint group. */
  name: string;
  /** Max requests per window per client. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
  /** Key extractor; defaults to the remote address. */
  keyFn?: (req: Request) => string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface WindowState {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Map<string, WindowState>>();

function pruneBucket(bucket: Map<string, WindowState>, now: number, windowMs: number): void {
  // Drop stale windows so the map cannot grow unbounded.
  const horizon = now - windowMs * 2;
  for (const [key, state] of bucket) {
    if (state.resetAt <= horizon) bucket.delete(key);
  }
}

/** Core check — exported for unit tests. */
export function checkRateLimit(
  bucketName: string,
  clientKey: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  let bucket = buckets.get(bucketName);
  if (!bucket) {
    bucket = new Map();
    buckets.set(bucketName, bucket);
  }
  pruneBucket(bucket, now, windowMs);

  const existing = bucket.get(clientKey);
  if (!existing || existing.resetAt <= now) {
    bucket.set(clientKey, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  if (existing.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  return { allowed: true, remaining: limit - existing.count, retryAfterSeconds: 0 };
}

/** Test-only helper: wipe all buckets. */
export function resetRateLimits(): void {
  buckets.clear();
}

/**
 * Express middleware factory. Responds 429 with Retry-After when the budget
 * is exhausted.
 */
export function rateLimit(options: RateLimitOptions): (req: Request, res: Response, next: NextFunction) => void {
  const keyFn = options.keyFn ?? ((req: Request) => req.socket.remoteAddress || 'unknown');
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = checkRateLimit(options.name, keyFn(req), options.limit, options.windowMs);
    if (result.allowed) {
      res.setHeader('X-RateLimit-Remaining', String(result.remaining));
      next();
      return;
    }
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    res.status(429).json({
      error: `Rate limit reached for ${options.name} — retry in ${result.retryAfterSeconds}s.`,
      retryAfterSeconds: result.retryAfterSeconds,
    });
  };
}
