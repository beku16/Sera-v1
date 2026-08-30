import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { listenWithFallback } from '../server/listenWithFallback';
import { verdictForPull, checkDiskSpace, ollamaModelsDirCandidates } from '../local/diskSpace';

/**
 * BUG L3 regression suite: a busy port must never kill the server — the
 * bind falls back to an ephemeral port and reports it.
 */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

const openedServers: http.Server[] = [];
afterEach(() => {
  for (const s of openedServers.splice(0)) {
    try { s.close(); } catch { /* already closed */ }
  }
});

describe('listenWithFallback', () => {
  it('binds the preferred port when it is free', async () => {
    const port = await freePort();
    const server = http.createServer();
    openedServers.push(server);
    const result = await listenWithFallback(server as never, { port, bindHost: '127.0.0.1' });
    expect(result.fellBack).toBe(false);
    expect(result.port).toBe(port);
    expect(result.fallbackReason).toBeNull();
  });

  it('BUG L3: falls back to an ephemeral port on EADDRINUSE instead of dying', async () => {
    const port = await freePort();
    const squatter = net.createServer();
    await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', resolve));
    try {
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('sera-alive');
      });
      openedServers.push(server);
      const result = await listenWithFallback(server as never, { port, bindHost: '127.0.0.1' });
      expect(result.fellBack).toBe(true);
      expect(result.fallbackReason).toBe('EADDRINUSE');
      expect(result.port).toBeGreaterThan(0);
      expect(result.port).not.toBe(port);
      // The fallback port actually answers requests.
      const body = await new Promise<string>((resolve, reject) => {
        const probe = http.get(`http://127.0.0.1:${result.port}`, (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => { data += chunk; });
          res.on('end', () => resolve(data));
        });
        probe.once('error', reject);
      });
      expect(body).toBe('sera-alive');
    } finally {
      squatter.close();
    }
  });

  it('still rejects genuine configuration errors', async () => {
    const server = http.createServer();
    openedServers.push(server);
    // Port -1 / bad host → EINVAL/EADDRNOTAVAIL-family error must propagate.
    await expect(
      listenWithFallback(server as never, { port: -1, bindHost: '127.0.0.1' }),
    ).rejects.toThrow();
  });
});

describe('diskSpace (spec §19 pre-check)', () => {
  it('probes the documented Ollama models dir candidates in order', () => {
    const candidates = ollamaModelsDirCandidates();
    expect(candidates.length).toBeGreaterThan(0);
    if (process.env.OLLAMA_MODELS) {
      expect(candidates[0]).toBe(process.env.OLLAMA_MODELS);
    }
  });

  it('never throws — unknown space is permissive, not blocking', () => {
    const report = checkDiskSpace();
    expect(typeof report.dir).toBe('string');
    if (!report.unknown) {
      expect(report.freeMB).toBeGreaterThanOrEqual(0);
    }
  });

  it('blocks absurd pulls (600 TB needed) with an actionable reason', () => {
    // 600,000,000 MB — no drive on earth has that free.
    const verdict = verdictForPull(600_000_000);
    if (!verdict.ok) {
      expect(verdict.reason).toMatch(/Not enough disk space/i);
      expect(verdict.reason).toMatch(/ollama rm|smaller model/i);
    } else {
      // Filesystem reported unknown/huge (some CI containers) — permissive is acceptable.
      expect(verdict.report.unknown || (verdict.report.freeMB ?? 0) > 600_000_000).toBe(true);
    }
  });

  it('allows small pulls on any measurable filesystem', () => {
    const verdict = verdictForPull(1);
    expect(verdict.ok).toBe(true);
  });
});
