import fs from 'node:fs';
import path from 'node:path';
import { logsDir } from '../local/SERAPaths';

/**
 * logging.ts — rotating structured logs with secret redaction (v1.9.0).
 *
 * WHY: packaged installs swallow stdout. When the backend misbehaves on a
 * user machine there was NOTHING to inspect — console output went to a
 * console window that closes, or to /dev/null under the Electron shell.
 * Every boot-critical path now also appends to
 *   %LOCALAPPDATA%\SERA\logs\sera-YYYY-MM-DD.log   (rotated, capped)
 *
 * REDACTION (spec §97): API keys, bearer tokens and passwords never reach
 * disk. The redactor rewrites the well-known key shapes to ***REDACTED***.
 *
 * Performance contract: file writes are synchronous-append on a best-effort
 * basis and NEVER throw — logging must not be able to kill the server.
 */

const MAX_LOG_FILES = 14; // two weeks of dailies
const MAX_BYTES_PER_FILE = 5 * 1024 * 1024; // 5 MB

/** Patterns whose values must never be persisted. */
const BEARER_PATTERN = /\b(bearer\s+)[A-Za-z0-9\-_.~+/]+=*/gi;
const SECRET_KEY_PATTERN =
  /\b(api[_-]?key|apikey|token|secret|password|authorization|x-goog-api-key|maskedkey)\b(\s*[:=]\s*|\s+)("[^"]*"|[^\s,;]+)/gi;

export function redactLine(line: string): string {
  return line
    .replace(BEARER_PATTERN, '$1***REDACTED***')
    .replace(SECRET_KEY_PATTERN, '$1=***REDACTED***');
}

function logFilePath(now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return path.join(logsDir(), `sera-${day}.log`);
}

/** Rotates: keeps the newest MAX_LOG_FILES daily files, trims oversized files. */
export function rotateLogs(): void {
  try {
    const dir = logsDir();
    fs.mkdirSync(dir, { recursive: true });
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^sera-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort();
    for (const stale of files.slice(0, Math.max(0, files.length - MAX_LOG_FILES))) {
      try { fs.rmSync(path.join(dir, stale), { force: true }); } catch { /* best-effort */ }
    }
    const current = logFilePath();
    try {
      const stat = fs.statSync(current);
      if (stat.size > MAX_BYTES_PER_FILE) {
        fs.rmSync(current, { force: true });
      }
    } catch { /* file doesn't exist yet */ }
  } catch {
    /* logging infrastructure must never throw */
  }
}

function append(level: string, scope: string, message: string, extra?: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level,
      scope,
      msg: redactLine(message),
      ...(extra ? { extra: JSON.parse(redactLine(JSON.stringify(extra))) } : {}),
    });
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.appendFileSync(logFilePath(), `${line}\n`, 'utf8');
  } catch {
    /* never throw from logging */
  }
}

export interface StructuredLogger {
  debug: (message: string, extra?: Record<string, unknown>) => void;
  info: (message: string, extra?: Record<string, unknown>) => void;
  warn: (message: string, extra?: Record<string, unknown>) => void;
  error: (message: string, extra?: Record<string, unknown>) => void;
  /** Log directory (for the OPEN LOG FOLDER diagnostic action). */
  dir: () => string;
}

export function createLogger(scope: string): StructuredLogger {
  return {
    debug: (m, e) => append('debug', scope, m, e),
    info: (m, e) => append('info', scope, m, e),
    warn: (m, e) => append('warn', scope, m, e),
    error: (m, e) => append('error', scope, m, e),
    dir: logsDir,
  };
}

/** The shared boot logger (startup, port handshake, backend boot). */
export const bootLogger = createLogger('boot');

/**
 * Installs mirror handlers so uncaught errors also land in the log file —
 * the #1 forensic request from the field ("it just died").
 */
export function installFatalLogMirrors(): void {
  process.on('uncaughtException', (err) => {
    bootLogger.error(`uncaughtException: ${err.stack || err.message}`);
  });
  process.on('unhandledRejection', (reason) => {
    bootLogger.error(`unhandledRejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
  });
}
