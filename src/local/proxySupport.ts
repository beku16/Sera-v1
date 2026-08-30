import dns from 'node:dns';

/**
 * Outbound proxy support + DNS-integrity watchdog for restricted networks.
 *
 * Why this exists: some networks transparently hijack plain-text DNS
 * (port 53) — queries even to 1.1.1.1 / 8.8.8.8 are answered with fake
 * private IPs (10.x / 172.16-31.x / 192.168.x). Browsers keep working
 * (DoH / system proxy) but Node.js ignores the Windows system proxy, so
 * SERA's server-side connection to the Gemini Live API silently fails
 * and SERA "never replies".
 *
 * What code CAN fix (done here):
 * 1. fetch()-level proxying via undici EnvHttpProxyAgent — when the user
 *    sets HTTPS_PROXY/HTTP_PROXY, all outbound REST calls (GoogleGenAI
 *    REST, key-vault connection tests, web search, OpenAI/DeepSeek text)
 *    route through the proxy. NO_PROXY defaults to localhost,127.0.0.1,::1
 *    so the local Ollama endpoints stay direct.
 *
 * What code CANNOT safely fix (surfaced honestly instead):
 * - The Gemini Live *WebSocket* socket creation is captured inside the
 *   SDK's bundled `ws` at import time; overriding it would require
 *   preload hacks that risk breaking tsx/Electron startup. For the WS,
 *   the reliable cures are OS-level (Windows DNS-over-HTTPS, or a VPN/
 *   proxy in TUN mode) — the DNS watchdog + diagnostics now guide the
 *   user through them explicitly instead of failing silently.
 */

export interface ProxySupportResult {
  enabled: boolean;
  proxyUrl: string | null;
  fetchProxied: boolean;
  noProxy: string | null;
  notes: string[];
}

export async function installProxySupport(
  logger: Pick<Console, 'log' | 'warn'> = console,
): Promise<ProxySupportResult> {
  const result: ProxySupportResult = {
    enabled: false,
    proxyUrl: null,
    fetchProxied: false,
    noProxy: null,
    notes: [],
  };

  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    null;

  if (!proxyUrl) {
    result.notes.push('No HTTPS_PROXY/HTTP_PROXY configured — outbound connections are direct.');
    return result;
  }

  result.enabled = true;
  result.proxyUrl = proxyUrl;

  // Local services must never go through the proxy.
  if (!process.env.NO_PROXY && !process.env.no_proxy) {
    process.env.NO_PROXY = 'localhost,127.0.0.1,::1';
  }
  result.noProxy = process.env.NO_PROXY || process.env.no_proxy || null;

  try {
    // ESM-safe: tsx/Electron run as ESM where `require` is not defined.
    const undici = (await import('undici')) as typeof import('undici');
    undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent());
    result.fetchProxied = true;
    result.notes.push(`All fetch() calls now route via ${proxyUrl} (NO_PROXY=${result.noProxy})`);
  } catch (err) {
    result.notes.push(`Could not install undici proxy dispatcher: ${err instanceof Error ? err.message : String(err)}`);
  }

  logger.log(`[SERVER] 🌐 Outbound proxy support ENABLED → ${proxyUrl}`);
  for (const note of result.notes) logger.log(`[SERVER]    • ${note}`);
  return result;
}

/** Private / non-routable IP ranges (RFC 1918 + loopback + bogus). */
function isPrivateIPv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return true; // not even an IPv4 → treat as unusable
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

export interface HostResolutionReport {
  host: string;
  addresses: string[];
  hijacked: boolean;
  dohAddresses: string[];
  dohWorked: boolean;
}

/**
 * Resolves `host` via the OS resolver and classifies the answer. When the
 * OS answer is hijacked (private/bogus IPs only), retries via DNS-over-HTTPS
 * (Cloudflare first, then Google) to learn the real addresses. The report is
 * logged at boot and surfaced through diagnostics + connect errors.
 */
export async function auditHostResolution(
  host: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HostResolutionReport> {
  const report: HostResolutionReport = {
    host,
    addresses: [],
    hijacked: false,
    dohAddresses: [],
    dohWorked: false,
  };

  // 1. OS resolver — exactly what real connections will use.
  try {
    const looked = await dns.promises.lookup(host, { all: true, verbatim: true });
    report.addresses = looked.map((l) => l.address);
    const usable = looked.filter((l) => l.family === 4 && !isPrivateIPv4(l.address));
    if (usable.length === 0 && looked.length > 0) report.hijacked = true;
    if (looked.length === 0) report.hijacked = true;
  } catch {
    report.hijacked = true; // cannot resolve at all via OS
  }

  if (!report.hijacked) return report;

  // 2. DoH fallback — learn the real IPs (and prove the network CAN work).
  const dohEndpoints = [
    `https://cloudflare-dns.com/dns-query?name=${host}&type=A`,
    `https://dns.google/resolve?name=${host}&type=A`,
  ];
  for (const endpoint of dohEndpoints) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const resp = await fetchImpl(endpoint, {
        headers: { accept: 'application/dns-json' },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      const body = (await resp.json()) as { Answer?: Array<{ type: number; data: string }> };
      const ips = (body.Answer || [])
        .filter((a) => a.type === 1) // A records
        .map((a) => a.data)
        .filter((ip) => !isPrivateIPv4(ip));
      if (ips.length > 0) {
        report.dohAddresses = ips;
        report.dohWorked = true;
        break;
      }
    } catch {
      // try next endpoint
    }
  }
  return report;
}

/** Logs the audit result with actionable guidance when hijacked. */
export function logHostResolutionAudit(
  report: HostResolutionReport,
  logger: Pick<Console, 'log' | 'warn'> = console,
): void {
  if (!report.hijacked) {
    logger.log(`[SERVER] 🛰️  DNS check: ${report.host} → ${report.addresses[0] ?? 'ok'} (OS resolver, public IP)`);
    return;
  }
  logger.warn(`[SERVER] ⚠️  DNS HIJACK DETECTED: ${report.host} resolves via the OS to private/bogus IPs [${report.addresses.join(', ') || 'none'}].`);
  if (report.dohWorked) {
    logger.warn(`[SERVER]    Real IPs via DNS-over-HTTPS: ${report.dohAddresses.join(', ')}`);
    logger.warn('[SERVER]    FIX (recommended): enable DNS-over-HTTPS in Windows for your 1.1.1.1 / 8.8.8.8 entries:');
    logger.warn('[SERVER]      Settings → Network & internet → Wi-Fi/Ethernet → DNS server assignment → Edit → turn ON "Encrypted DNS (DNS over HTTPS)", then run: ipconfig /flushdns');
    logger.warn('[SERVER]    Alternative: run your VPN/proxy app in TUN mode, or set HTTPS_PROXY in .env (SERA proxies fetch calls automatically).');
  } else {
    logger.warn('[SERVER]    DoH probes failed too — the network may block Google/Cloudflare entirely. Use a VPN/proxy (TUN mode) on this network.');
  }
}
