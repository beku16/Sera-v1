import { describe, expect, it, vi } from 'vitest';
import {
  checkRateLimit,
  rateLimit,
  resetRateLimits,
} from '../server/rateLimit';
import type { Request, Response } from 'express';

function fakeReq(key = '127.0.0.1'): Request {
  return { socket: { remoteAddress: key }, method: 'POST', path: '/x' } as unknown as Request;
}

function fakeRes(): Response & { statusCode: number; headers: Record<string, string>; body: unknown } {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader: (k: string, v: string) => {
      res.headers[k] = v;
    },
    status: (code: number) => {
      res.statusCode = code;
      return res;
    },
    json: (payload: unknown) => {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as Response & typeof res;
}

describe('rateLimit — checkRateLimit core', () => {
  it('allows requests up to the limit and then blocks', () => {
    resetRateLimits();
    const windowMs = 60_000;
    let now = Date.now();

    for (let i = 0; i < 3; i += 1) {
      const result = checkRateLimit('core-test', 'client-a', 3, windowMs, now);
      expect(result.allowed).toBe(true);
      now += 100;
    }
    const blocked = checkRateLimit('core-test', 'client-a', 3, windowMs, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('resets the budget after the window passes', () => {
    resetRateLimits();
    const windowMs = 1_000;
    const t0 = Date.now();
    checkRateLimit('window-test', 'client', 1, windowMs, t0);
    const blockedAt = checkRateLimit('window-test', 'client', 1, windowMs, t0 + 500);
    const allowedAfter = checkRateLimit('window-test', 'client', 1, windowMs, t0 + 1_001);
    expect(blockedAt.allowed).toBe(false);
    expect(allowedAfter.allowed).toBe(true);
  });

  it('tracks clients independently', () => {
    resetRateLimits();
    const t0 = Date.now();
    checkRateLimit('clients-test', 'client-a', 1, 60_000, t0);
    const otherClient = checkRateLimit('clients-test', 'client-b', 1, 60_000, t0);
    expect(otherClient.allowed).toBe(true);
  });

  it('tracks buckets independently', () => {
    resetRateLimits();
    const t0 = Date.now();
    checkRateLimit('bucket-a', 'client', 1, 60_000, t0);
    const otherBucket = checkRateLimit('bucket-b', 'client', 1, 60_000, t0);
    expect(otherBucket.allowed).toBe(true);
  });
});

describe('rateLimit — express middleware', () => {
  it('calls next() while under the limit', () => {
    resetRateLimits();
    const middleware = rateLimit({ name: 'mw-test', limit: 2, windowMs: 60_000 });
    const next = vi.fn();
    middleware(fakeReq(), fakeRes(), next);
    middleware(fakeReq(), fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('responds 429 with Retry-After once exhausted', () => {
    resetRateLimits();
    const middleware = rateLimit({ name: 'mw-test-429', limit: 1, windowMs: 60_000 });
    const res = fakeRes();
    middleware(fakeReq(), res, vi.fn()); // consumes the budget
    const blockedRes = fakeRes();
    const next = vi.fn();
    middleware(fakeReq(), blockedRes, next);
    expect(next).not.toHaveBeenCalled();
    expect(blockedRes.statusCode).toBe(429);
    expect(blockedRes.headers['Retry-After']).toBeDefined();
    expect((blockedRes.body as { error: string }).error).toContain('Rate limit');
  });
});
