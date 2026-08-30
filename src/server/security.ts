/**
 * SERA — local-server request security.
 *
 * The SERA backend is a LOCAL-FIRST server: it binds to 127.0.0.1, serves
 * the renderer from the same origin, and exposes powerful computer-control
 * endpoints (keyboard/mouse/clipboard/app-launch/diagnostics-repair). That
 * power makes it a juicy target for two browser-borne local attacks:
 *
 *  1. CROSS-SITE WEBSOCKET HIJACKING + CSRF: browsers do NOT apply CORS to
 *     WebSocket handshakes or "simple" form/fetch POSTs. Any webpage open in
 *     the user's browser (e.g. a malicious tab) can try to connect to
 *     ws://127.0.0.1:3000/api/live or POST to /api/diagnostics/repair.
 *     Mitigation: require the Origin header, when present, to be an
 *     allowed loopback origin (the real SERA UI). Requests without an
 *     Origin (curl, the Electron main process, local scripts) are allowed
 *     only when the Host header is a known local host.
 *
 *  2. DNS REBINDING: a public page at http://evil.com makes the victim's
 *     browser re-resolve evil.com to 127.0.0.1 after the page has loaded,
 *     so same-origin policy sees "evil.com" while the packets go to the
 *     local server. Mitigation: validate the Host header against a strict
 *     allowlist (localhost / 127.0.0.1 / ::1 / the configured bind host).
 *
 * Optionally, a shared token can be required (`SERA_AUTH_TOKEN`): when set,
 * every /api request and WebSocket connection must present it via
 * `Authorization: Bearer <token>` or `?token=<token>`. This also defends
 * against OTHER LOCAL PROCESSES (which can spoof Host and omit Origin).
 * The Electron launcher can inject the token via environment; browser
 * users keep working because the token is optional by default.
 */
import type { IncomingMessage } from 'node:http';
import type { Request, Response, NextFunction } from 'express';

export interface LocalRequestGuardOptions {
  /** Port the UI is served on (used to match Origin/Referer ports). */
  port: number;
  /** Host the HTTP server binds to (SERA_BIND_HOST). Defaults to 127.0.0.1. */
  bindHost?: string;
  /**
   * Shared-secret token. When non-empty, requests must present it.
   * Defaults to SERA_AUTH_TOKEN env var; empty string disables token checks.
   */
  token?: string;
  /** Extra origins to allow (e.g. the Vite dev server origin). */
  extraAllowedOrigins?: string[];
}

export interface GuardDecision {
  allowed: boolean;
  reason?: string;
  status?: 403 | 401;
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function normalizeHostname(host: string): string {
  let h = host.trim().toLowerCase();
  // Strip the port, but keep bracketed IPv6 literals intact.
  if (h.startsWith('[')) {
    const close = h.indexOf(']');
    if (close >= 0) return h.slice(0, close + 1);
    return h;
  }
  const colon = h.lastIndexOf(':');
  if (colon > 0) h = h.slice(0, colon);
  return h;
}

/** Host header allowlist check — the DNS-rebinding defense. */
export function isAllowedHost(hostHeader: string | undefined, bindHost?: string): boolean {
  if (!hostHeader) return false;
  const hostname = normalizeHostname(hostHeader);
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  if (bindHost && hostname === normalizeHostname(bindHost)) return true;
  // Explicit non-loopback bind (e.g. SERA_BIND_HOST=0.0.0.0) means the user
  // deliberately exposed the server; accept any Host but keep Origin checks.
  if (bindHost && normalizeHostname(bindHost) === '0.0.0.0') return true;
  return false;
}

/** Hostnames in RFC-1918 private ranges — allowed only when the user deliberately exposed the server (bind 0.0.0.0). */
function isPrivateHostname(hostname: string): boolean {
  if (/^10(\.\d{1,3}){3}$/.test(hostname)) return true;
  if (/^192\.168(\.\d{1,3}){2}$/.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}$/.test(hostname)) return true;
  if (/^169\.254(\.\d{1,3}){2}$/.test(hostname)) return true; // link-local (LAN discovery)
  return false;
}

/** Origin allowlist check — the cross-site-WebSocket-hijacking / CSRF defense. */
export function isAllowedOrigin(
  originHeader: string | undefined,
  options: { port: number; bindHost?: string; extraAllowedOrigins?: string[] },
): boolean {
  if (originHeader === undefined || originHeader === '') {
    // Non-browser clients (Electron main, curl, local scripts) send no
    // Origin. These are gated by the Host check + optional token instead.
    return true;
  }
  const extra = options.extraAllowedOrigins ?? [];
  if (extra.includes(originHeader)) return true;

  let parsed: URL;
  try {
    parsed = new URL(originHeader);
  } catch {
    return false;
  }
  // Chrome sends "Origin: null" for sandboxed frames — never accept it.
  if (parsed.host === 'null' || parsed.hostname === 'null') return false;
  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? '443' : '80') : parsed.port;
  if (port !== String(options.port)) return false;
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  const bindHost = options.bindHost ? normalizeHostname(options.bindHost) : undefined;
  // The user deliberately exposed the server to the LAN — allow access via
  // the machine's private LAN address (still never via public hostnames).
  if (bindHost === '0.0.0.0' && isPrivateHostname(hostname)) return true;
  // Custom bind host (e.g. SERA_BIND_HOST=192.168.1.5): same-host origin only.
  if (bindHost && hostname === bindHost) return true;
  return false;
}

/** Extracts a bearer token from an Authorization header or ?token= query. */
export function extractToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const url = req.url || '';
  const qIndex = url.indexOf('?');
  if (qIndex >= 0) {
    const query = url.slice(qIndex + 1);
    const match = query.match(/(?:^|&)(?:token|auth)=([^&]*)/);
    if (match) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }
  }
  return null;
}

/**
 * Core decision function for one incoming request (HTTP or WS upgrade).
 * Pure: no request mutation, no side effects — fully unit-testable.
 */
export function evaluateRequest(
  req: IncomingMessage,
  options: LocalRequestGuardOptions,
): GuardDecision {
  const host = req.headers.host;
  if (!isAllowedHost(host, options.bindHost)) {
    return { allowed: false, reason: `Blocked request with unrecognized Host header "${String(host)}" (possible DNS rebinding).`, status: 403 };
  }

  if (!isAllowedOrigin(req.headers.origin, options)) {
    return { allowed: false, reason: `Blocked cross-origin request from "${String(req.headers.origin)}" (the SERA API is local-only).`, status: 403 };
  }

  const token = options.token ?? process.env.SERA_AUTH_TOKEN ?? '';
  if (token) {
    const presented = extractToken(req);
    if (presented !== token) {
      return { allowed: false, reason: 'Missing or invalid SERA access token.', status: 401 };
    }
  }

  return { allowed: true };
}

export interface LocalRequestGuard {
  /** Decision function for raw http.IncomingMessage (WS upgrades). */
  evaluate: (req: IncomingMessage) => GuardDecision;
  /** Express middleware for HTTP requests. */
  middleware: (req: Request, res: Response, next: NextFunction) => void;
}

/**
 * Builds the guard used by both the Express app and the WebSocket server so
 * HTTP and WS share ONE security policy.
 */
export function createLocalRequestGuard(options: LocalRequestGuardOptions): LocalRequestGuard {
  const evaluate = (req: IncomingMessage): GuardDecision => evaluateRequest(req, options);

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    // Static assets and the SPA shell stay reachable without the token (the
    // Electron renderer must be able to load the page even in token mode —
    // it cannot present a bearer header for a document navigation). The
    // token therefore gates /api/* routes; Host/Origin checks gate everything.
    const isApiRoute = req.path === '/api' || req.path.startsWith('/api/');
    const decision = evaluateRequest(req, isApiRoute ? options : { ...options, token: '' });
    if (decision.allowed) {
      next();
      return;
    }
    // Log the reason server-side; never echo presented tokens back.
    console.warn(`[SECURITY] ${decision.status ?? 403} ${req.method} ${req.path} — ${decision.reason ?? 'blocked'}`);
    res.status(decision.status ?? 403).json({ error: decision.reason ?? 'Request blocked.' });
  };

  return { evaluate, middleware };
}

/**
 * Baseline security headers for all responses. The Electron shell sets a
 * full CSP; this covers plain-browser usage and defense-in-depth.
 */
export function securityHeadersMiddleware(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}
