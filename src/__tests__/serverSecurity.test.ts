import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  createLocalRequestGuard,
  evaluateRequest,
  extractToken,
  isAllowedHost,
  isAllowedOrigin,
} from '../server/security';

function fakeReq(headers: Record<string, string | undefined>, url = '/api/health'): IncomingMessage {
  return { headers, url } as unknown as IncomingMessage;
}

describe('security — isAllowedHost (DNS-rebinding defense)', () => {
  it('allows loopback hosts', () => {
    expect(isAllowedHost('localhost:3000')).toBe(true);
    expect(isAllowedHost('127.0.0.1:3000')).toBe(true);
    expect(isAllowedHost('[::1]:3000')).toBe(true);
  });

  it('allows the configured bind host', () => {
    expect(isAllowedHost('192.168.1.5:3000', '192.168.1.5')).toBe(true);
  });

  it('rejects public hostnames (DNS rebinding)', () => {
    expect(isAllowedHost('evil.com:3000')).toBe(false);
    expect(isAllowedHost('attacker.io')).toBe(false);
  });

  it('rejects missing host headers', () => {
    expect(isAllowedHost(undefined)).toBe(false);
  });

  it('accepts any host when the user deliberately bound 0.0.0.0', () => {
    expect(isAllowedHost('192.168.1.9:3000', '0.0.0.0')).toBe(true);
  });
});

describe('security — isAllowedOrigin (CSRF / WS-hijacking defense)', () => {
  const opts = { port: 3000 };

  it('allows same-origin loopback origins', () => {
    expect(isAllowedOrigin('http://localhost:3000', opts)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:3000', opts)).toBe(true);
  });

  it('allows non-browser clients (no Origin header)', () => {
    expect(isAllowedOrigin(undefined, opts)).toBe(true);
    expect(isAllowedOrigin('', opts)).toBe(true);
  });

  it('rejects cross-site origins — the malicious-webpage attack', () => {
    expect(isAllowedOrigin('http://evil.com', opts)).toBe(false);
    expect(isAllowedOrigin('https://evil.com:3000', opts)).toBe(false);
    expect(isAllowedOrigin('http://localhost:9999', opts)).toBe(false); // wrong port
  });

  it('rejects Origin: null (sandboxed frame spoof)', () => {
    expect(isAllowedOrigin('null', opts)).toBe(false);
  });

  it('rejects malformed origins', () => {
    expect(isAllowedOrigin('not a url', opts)).toBe(false);
  });

  it('allows private LAN origins only when deliberately exposed (0.0.0.0)', () => {
    expect(isAllowedOrigin('http://192.168.1.5:3000', { port: 3000 })).toBe(false);
    expect(isAllowedOrigin('http://192.168.1.5:3000', { port: 3000, bindHost: '0.0.0.0' })).toBe(true);
    // Public hostnames stay blocked even with 0.0.0.0.
    expect(isAllowedOrigin('http://evil.com:3000', { port: 3000, bindHost: '0.0.0.0' })).toBe(false);
  });
});

describe('security — extractToken', () => {
  it('reads bearer tokens from the Authorization header', () => {
    expect(extractToken(fakeReq({ authorization: 'Bearer abc123' }))).toBe('abc123');
    expect(extractToken(fakeReq({ authorization: 'bearer abc123' }))).toBe('abc123');
  });

  it('reads tokens from the query string', () => {
    expect(extractToken(fakeReq({}, '/api/live?token=abc123'))).toBe('abc123');
    expect(extractToken(fakeReq({}, '/api/live?mode=local&auth=xyz'))).toBe('xyz');
  });

  it('returns null when no token is presented', () => {
    expect(extractToken(fakeReq({}))).toBeNull();
    expect(extractToken(fakeReq({}, '/api/health'))).toBeNull();
  });
});

describe('security — evaluateRequest', () => {
  const opts = { port: 3000, bindHost: '127.0.0.1' };

  it('allows a normal same-origin browser request', () => {
    const decision = evaluateRequest(
      fakeReq({ host: 'localhost:3000', origin: 'http://localhost:3000' }),
      opts,
    );
    expect(decision.allowed).toBe(true);
  });

  it('blocks the forged-Host (DNS rebinding) request with 403', () => {
    const decision = evaluateRequest(
      fakeReq({ host: 'evil.com', origin: 'http://evil.com' }),
      opts,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(403);
  });

  it('blocks a cross-origin API call from a malicious page with 403', () => {
    const decision = evaluateRequest(
      fakeReq({ host: 'localhost:3000', origin: 'http://evil.com' }),
      opts,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe(403);
    expect(decision.reason).toContain('local-only');
  });

  it('enforces the shared token when configured (401 without, 200 with)', () => {
    const noToken = evaluateRequest(
      fakeReq({ host: 'localhost:3000' }),
      { ...opts, token: 'sekrit' },
    );
    expect(noToken.allowed).toBe(false);
    expect(noToken.status).toBe(401);

    const withToken = evaluateRequest(
      fakeReq({ host: 'localhost:3000', authorization: 'Bearer sekrit' }),
      { ...opts, token: 'sekrit' },
    );
    expect(withToken.allowed).toBe(true);
  });
});

describe('security — createLocalRequestGuard middleware', () => {
  it('blocks a cross-origin POST to the API', () => {
    const guard = createLocalRequestGuard({ port: 3000 });
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const next = vi.fn();
    const res = { status } as never;
    const req = {
      headers: { host: 'localhost:3000', origin: 'http://evil.com' },
      url: '/api/diagnostics/repair',
      method: 'POST',
      path: '/api/diagnostics/repair',
      socket: { remoteAddress: '127.0.0.1' },
    } as never;

    guard.middleware(req, res, next);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('passes same-origin traffic through to next()', () => {
    const guard = createLocalRequestGuard({ port: 3000 });
    const next = vi.fn();
    const req = {
      headers: { host: 'localhost:3000', origin: 'http://localhost:3000' },
      url: '/api/health',
      method: 'GET',
      path: '/api/health',
      socket: { remoteAddress: '127.0.0.1' },
    } as never;

    guard.middleware(req, {} as never, next);
    expect(next).toHaveBeenCalled();
  });

  it('evaluate() can be reused for WebSocket upgrades', () => {
    const guard = createLocalRequestGuard({ port: 3000 });
    const legit = guard.evaluate(fakeReq({ host: 'localhost:3000' }, '/api/live?mode=local'));
    expect(legit.allowed).toBe(true);
    const attack = guard.evaluate(fakeReq({ host: 'localhost:3000', origin: 'http://evil.com' }, '/api/live'));
    expect(attack.allowed).toBe(false);
  });
});
