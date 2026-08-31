import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { defaultBrowserSessionManager, defaultToolManager, defaultScreenController } from './src/tools/toolRegistry';
import { SERA_SYSTEM_INSTRUCTION, APP_CONFIG } from './src/config/config';
import { defaultMemoryManager } from './src/memory/MemoryManager';
import { LatencyTrace } from './src/diagnostics/LatencyTrace';
import { NodeMemoryStore } from './src/memory/NodeMemoryStore';
import { defaultSystemDiagnosticService } from './src/diagnostics/SystemDiagnosticService';
import { defaultSystemHealthMonitor } from './src/diagnostics/SystemHealthMonitor';
import { defaultAutoRepairEngine } from './src/diagnostics/AutoRepairEngine';
import { defaultErrorReflectionEngine } from './src/learning';
import { defaultHardwareInspector } from './src/local/HardwareInspector';
import { recommendLocalModel, LOCAL_MODEL_CATALOG, gradeCatalog } from './src/local/ModelRecommender';
import { OllamaClient, PullProgressEvent } from './src/local/OllamaClient';
import { LocalAgentEngine } from './src/local/LocalAgentEngine';
import { LocalWhisperStt, LocalPiperTts } from './src/local/LocalSpeechEngines';
import { defaultApiKeyVault, ApiProvider, API_PROVIDERS } from './src/local/ApiKeyVault';
import { defaultUninstallService } from './src/local/UninstallService';
import { defaultUpdateService } from './src/local/UpdateService';
import { installProxySupport, auditHostResolution, logHostResolutionAudit } from './src/local/proxySupport';
import { verdictForPull } from './src/local/diskSpace';
import { defaultOllamaManager } from './src/local/ollamaManager';
import {
  ensureSeraDirs,
  migrateLegacyData,
  frontendDistDir,
  ocrDataDir,
  tmpWorkDir,
  logsDir,
  isPackaged as isSeraPackaged,
} from './src/local/SERAPaths';
import { shrinkPngBase64, encodeFrameForLiveWire } from './src/vision/screenImage';
import { LiveScreenShareFeed } from './src/vision/liveScreenShare';
import { CognitiveEngine } from './src/agi';
import { defaultModelOrchestrator } from './src/orchestration';
import { createLocalRequestGuard, securityHeadersMiddleware } from './src/server/security';
import { listenWithFallback } from './src/server/listenWithFallback';
import { rateLimit } from './src/server/rateLimit';
import { createShutdownCoordinator, installShutdownHandlers } from './src/server/shutdown';
import { bootLogger, installFatalLogMirrors, rotateLogs } from './src/server/logging';
import {
  ScreenVisionRegistry,
  normalizeFrameData,
  type ScreenVisionSessionHook,
} from './src/server/screenVision';
import { TesseractScreenOcrEngine } from './src/server/screenOcr';
import type { ScreenShareEndedSummary } from './src/server/screenVision';
import { formatShareEndedFact } from './src/server/screenMemory';
import type { PlanStep } from './src/agi';
import type { ScreenFrame } from './src/actions/ControlProviders';
import { APP_VERSION } from './src/generated/appVersion';

// ── BOOT: resolve every writable directory BEFORE any store initialises
// (v1.9.0, BUG L5). One-time legacy migration copies repo-era memories /
// vault into the per-user home — never deletes, runs once, marked.
ensureSeraDirs();
try {
  migrateLegacyData();
} catch {
  /* migration is best-effort — never block boot */
}

defaultMemoryManager.setStore(new NodeMemoryStore());

// Meta-cognitive learning pipeline: attach the ErrorReflectionEngine to
// the core tool execution loop so every tool call gets a pre-flight
// anti-regression check and a post-mortem reflection on failure.
defaultToolManager.attachLearning(defaultErrorReflectionEngine);

// Autonomous AGI cognitive engine (perceive -> plan -> execute -> verify).
const cognitiveEngine = new CognitiveEngine(defaultToolManager);

// Local-mode engines (100% offline brain).
const ollamaClient = new OllamaClient();
const localWhisper = new LocalWhisperStt();
const localPiper = new LocalPiperTts();
const localAgentEngine = new LocalAgentEngine(defaultToolManager, ollamaClient, {
  systemInstruction: SERA_SYSTEM_INSTRUCTION,
});

// Current assistant mode ('online' = Gemini Live, 'local' = Ollama).
// The client persists its own preference; the server mode mirrors the
// last requested state so diagnostics can report it honestly.
// Local-first default (spec A): mirrors the last client WS ?mode= param.
// Starts 'local' so /api/health and /api/mode report the true default
// posture of the app before the first session connects.
let currentRunMode: 'online' | 'local' = 'local';

// v1.9.0 (BUG L3 FIX): port 3000 collided with half the dev ecosystem —
// every "EADDRINUSE" killed the server with exit(1) and the Electron shell
// showed a dead window. The default is now SERA's own 43110; PORT still
// wins (dev muscle memory unchanged), and when the chosen port is busy the
// server FALLS BACK to an ephemeral port instead of dying. The actual port
// is written to <SERA home>/sera.port and printed as a stdout marker so the
// Electron shell can follow it (see setupApp).
const configuredPort = Number.parseInt(process.env.PORT || '43110', 10);
const PORT = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535 ? configuredPort : 43110;
const BIND_HOST = process.env.SERA_BIND_HOST || '127.0.0.1';
const app = express();

// ── SECURITY MIDDLEWARE (v1.6.11) ────────────────────────────────────
// The SERA backend exposes computer-control endpoints (keyboard, mouse,
// clipboard, app launch, diagnostics repair). Before this stack existed,
// ANY webpage open in the user's browser could connect to
// ws://127.0.0.1:3000/api/live (browsers do not apply CORS to WebSocket
// handshakes) or POST to the HTTP API, and a DNS-rebinding page could reach
// the server with a forged Host header. One guard now protects both HTTP
// and WS with the SAME policy: loopback-only Host, loopback-only Origin,
// optional shared-secret token (SERA_AUTH_TOKEN).
app.disable('x-powered-by');
app.use(securityHeadersMiddleware);
// Mutable options: when the port falls back (EADDRINUSE → ephemeral), the
// guard's Origin-port check must follow the ACTUAL port, not the failed one.
const guardOptions = { port: PORT, bindHost: BIND_HOST };
const requestGuard = createLocalRequestGuard(guardOptions);
app.use(requestGuard.middleware);

app.use(express.json());

// ── RATE LIMITING (v1.6.11) ─────────────────────────────────────────
// Generous per-minute budget for the EXPENSIVE endpoints (deep scans,
// model pulls, agent turns, repairs, desktop spawns). A human never hits
// these limits; a runaway renderer retry loop no longer spawns dozens of
// concurrent Playwright probes / child processes. Configure with
// SERA_RATE_LIMIT_PER_MIN (0 disables).
const RATE_LIMIT_PER_MIN = Math.max(0, Number.parseInt(process.env.SERA_RATE_LIMIT_PER_MIN || '60', 10) || 60);
const heavyApiLimiter = RATE_LIMIT_PER_MIN > 0
  ? rateLimit({ name: 'heavy-api', limit: RATE_LIMIT_PER_MIN, windowMs: 60_000 })
  : (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();

const browserSessionId = 'sera-built-in-browser';

app.post('/api/desktop/launch', heavyApiLimiter, (_req, res) => {
  // v1.6.11 FIX: this endpoint always spawned `desktop:dev` — even when the
  // production bundle was serving. Now it launches the matching script, and
  // a spawn failure is reported instead of crashing via an unhandled 'error'
  // event on the detached child.
  const runningFromBundle =
    typeof __filename === 'string' && __filename.split(path.sep).includes('dist');
  const useDev = process.env.SERA_DEV === 'true' || (!runningFromBundle && process.env.NODE_ENV !== 'production');
  const script = useDev ? 'desktop:dev' : 'desktop';
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  let child;
  try {
    child = spawn(command, ['run', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(useDev ? { SERA_DEV: 'true' } : {}),
        SERA_USE_EXISTING_SERVER: 'true',
      },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
  } catch (error) {
    res.status(500).json({ error: `Failed to launch desktop app: ${error instanceof Error ? error.message : String(error)}` });
    return;
  }
  child.once('error', (err) => {
    console.error(`[DESKTOP_LAUNCH] spawn "${script}" failed:`, err.message);
  });
  child.unref();
  res.json({ status: 'launch_requested', script });
});

const describeWebSocketState = (ws: WebSocket | null): string => {
  if (!ws) return 'null';
  switch (ws.readyState) {
    case WebSocket.CONNECTING:
      return 'CONNECTING';
    case WebSocket.OPEN:
      return 'OPEN';
    case WebSocket.CLOSING:
      return 'CLOSING';
    case WebSocket.CLOSED:
      return 'CLOSED';
    default:
      return `UNKNOWN(${ws.readyState})`;
  }
};

const sanitizeError = (error: any) => {
  const details = {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    code: error?.code || error?.status || error?.error?.code || null,
    status: error?.status || error?.response?.status || null,
    cause: error?.cause ? String(error.cause) : null,
    stack: error instanceof Error ? error.stack : new Error(String(error)).stack || null,
    raw: error ? Object.getOwnPropertyNames(error).reduce((acc, key) => {
      if (key === 'stack' || key === 'cause') return acc;
      acc[key] = error[key];
      return acc;
    }, {} as Record<string, unknown>) : {},
  };

  return details;
};

const safeStringify = (value: unknown, depth = 2): unknown => {
  if (depth < 0) return '[MaxDepthReached]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => safeStringify(item, depth - 1));
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).reduce((acc, [key, entryValue]) => {
      if (key === 'stack' || key === 'request' || key === 'response') {
        acc[key] = typeof entryValue === 'string' ? entryValue.slice(0, 400) : safeStringify(entryValue, depth - 1);
        return acc;
      }
      acc[key] = safeStringify(entryValue, depth - 1);
      return acc;
    }, {} as Record<string, unknown>);
    return entries;
  }
  return String(value);
};

// v1.6.8: the SERA Server console was unreadable — every audio chunk (~25/s)
// printed 3 pretty-printed JSON blocks (CLIENT_MESSAGE_n + AUDIO_RECEIVED +
// AUDIO_ACCEPTED), and logLifecycleEvent pretty-printed everything across 20+
// lines. Default logging is now ONE compact line per event, and per-chunk
// audio logs are collapsed into a 15-second AUDIO_FLOW_SUMMARY. Set
// SERA_LOG_VERBOSE=1 to restore the old full-detail debugging output.
const VERBOSE_LOGS = /^(1|true|yes)$/i.test(String(process.env.SERA_LOG_VERBOSE || ''));

const logLifecycleEvent = (sessionId: string, event: string, details: Record<string, unknown> = {}) => {
  if (VERBOSE_LOGS) {
    console.log(`[SERVER] ${sessionId} ${event}`);
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...details }, null, 2));
  } else {
    console.log(`[SERVER] ${sessionId} ${event} ${JSON.stringify({ timestamp: new Date().toISOString(), ...details })}`);
  }
};

const summarizeGeminiCloseArgs = (args: unknown[]) => {
  const [firstArg, secondArg, thirdArg] = args;
  return {
    argumentsCount: args.length,
    arg0: safeStringify(firstArg),
    arg1: safeStringify(secondArg),
    arg2: safeStringify(thirdArg),
    firstArgType: firstArg?.constructor?.name || typeof firstArg,
    secondArgType: secondArg?.constructor?.name || typeof secondArg,
    thirdArgType: thirdArg?.constructor?.name || typeof thirdArg,
  };
};

app.get('/api/browser/state', async (_req, res) => {
  try {
    const state = await defaultBrowserSessionManager.getSession(browserSessionId);
    res.json(state || await defaultBrowserSessionManager.createSession(browserSessionId));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/browser/screenshot', async (req, res) => {
  try {
    const screenshot = await defaultBrowserSessionManager.screenshot(browserSessionId, typeof req.query.tabId === 'string' ? req.query.tabId : undefined);
    if (!screenshot) {
      res.status(404).json({ error: 'The browser tab is not available.' });
      return;
    }
    res.type('png').send(screenshot);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/browser/action', async (req, res) => {
  try {
    const { type, parameters = {} } = req.body || {};
    if (typeof type !== 'string' || !type.startsWith('browser.')) {
      res.status(400).json({ error: 'A browser action type is required.' });
      return;
    }
    const action = defaultToolManager.getActionManager().createAction({
      taskId: browserSessionId,
      actionId: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      parameters: { ...parameters, sessionId: browserSessionId },
    });
    const result = await defaultToolManager.dispatchAction(action);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// System Diagnostics & Health endpoints
app.get('/api/diagnostics/health', async (_req, res) => {
  try {
    // CRITICAL FIX: Previously this returned the cached lastReport (up
    // to 45s old) via getHealthSummary(). Now we trigger a fresh sweep
    // if the cache is older than the sweep interval, so callers always
    // get a current snapshot. The `scanFresh` flag tells the renderer
    // whether a new scan was just run.
    const summary = await defaultSystemHealthMonitor.getFreshHealthSummary();
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// v1.9.0: where the rotating logs live — powers the OPEN LOG FOLDER action
// in the MY PC diagnostics panel (the Electron shell opens it via preload).
app.get('/api/diagnostics/log-folder', (_req, res) => {
  res.json({ dir: logsDir(), files: (() => {
    try {
      return fs.readdirSync(logsDir())
        .filter((f) => f.endsWith('.log'))
        .sort()
        .slice(-5);
    } catch {
      return [];
    }
  })() });
});

app.post('/api/diagnostics/scan', heavyApiLimiter, async (req, res) => {
  try {
    const autoRepair = req.body?.autoRepair === true;
    // deep=true — this endpoint is the user's explicit "Run Full Scan"
    // button. Background sweeps (SystemHealthMonitor / health endpoint)
    // run read-only so the user's clip history is never polluted.
    let report = await defaultSystemDiagnosticService.runFullScan({ deep: true });
    let repairResults = [];
    if (autoRepair) {
      repairResults = await defaultSystemDiagnosticService.autoRepairReport(report);
      // Re-scan so returned report reflects the newly repaired state
      report = await defaultSystemDiagnosticService.runFullScan({ deep: true });
    }
    res.json({ report, repairResults });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/diagnostics/repair', heavyApiLimiter, async (req, res) => {
  try {
    const { checkId } = req.body || {};
    if (!checkId) {
      res.status(400).json({ error: 'checkId is required for targeted repair' });
      return;
    }
    const result = await defaultAutoRepairEngine.executeRepair(checkId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/diagnostics/simulate-issue', heavyApiLimiter, async (_req, res) => {
  try {
    // Generate a test temporary cache artifact to demonstrate automated clean-up
    const tmpDir = tmpWorkDir();
    await fs.promises.mkdir(tmpDir, { recursive: true });
    const testFile = path.join(tmpDir, `test_cache_dump_${Date.now()}.tmp`);
    await fs.promises.writeFile(testFile, 'SIMULATED_STALE_DIAGNOSTIC_CACHE_FILE', 'utf8');

    // Run deep scan immediately to show the detected test item
    const report = await defaultSystemDiagnosticService.runFullScan();
    res.json({ success: true, message: 'Simulated issue injected. Diagnostic engine detected test artifact.', report });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ─── Uninstallation & Self-Uninstall Endpoints ──────────────────────────────
app.get('/api/uninstall/summary', (_req, res) => {
  try {
    const summary = defaultUninstallService.getMemorySummary();
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/uninstall/challenge', (_req, res) => {
  try {
    const challenge = defaultUninstallService.generateChallenge();
    res.json(challenge);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/uninstall/verify', (req, res) => {
  try {
    const { challengeId, inputPhrase } = req.body || {};
    if (!challengeId || !inputPhrase) {
      res.status(400).json({ valid: false, reason: 'challengeId and inputPhrase are required' });
      return;
    }
    const result = defaultUninstallService.verifyChallenge(challengeId, inputPhrase);
    res.json(result);
  } catch (error) {
    res.status(500).json({ valid: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/uninstall/backup', (req, res) => {
  try {
    const { customTargetDir } = req.body || {};
    const result = defaultUninstallService.exportMemoryBackup(customTargetDir);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/uninstall/execute', heavyApiLimiter, async (req, res) => {
  try {
    const { challengeId, inputPhrase, preserveMemory, preserveEngines } = req.body || {};
    if (!challengeId || !inputPhrase) {
      res.status(400).json({ success: false, message: 'Authentication challenge confirmation is required' });
      return;
    }
    const verification = defaultUninstallService.verifyChallenge(challengeId, inputPhrase);
    if (!verification.valid) {
      res.status(403).json({ success: false, message: verification.reason || 'Authentication verification failed' });
      return;
    }

    const isFullWipe = preserveMemory === false;
    const result = await defaultUninstallService.executeUninstall({
      preserveMemory: !isFullWipe,
      preserveEngines: !isFullWipe && preserveEngines === true,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// ─── In-App Self-Update Endpoints ───────────────────────────────────────────
app.get('/api/update/status', (_req, res) => {
  try {
    const status = defaultUpdateService.getStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/update/check', async (_req, res) => {
  try {
    await defaultUpdateService.checkForUpdates();
    const status = defaultUpdateService.getStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/update/download', heavyApiLimiter, async (_req, res) => {
  try {
    // Start asynchronous download and return current status
    void defaultUpdateService.startDownload();
    const status = defaultUpdateService.getStatus();
    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/update/cancel', (_req, res) => {
  try {
    defaultUpdateService.cancelDownload();
    const status = defaultUpdateService.getStatus();
    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/update/install', heavyApiLimiter, async (_req, res) => {
  try {
    const result = await defaultUpdateService.applyUpdateAndRestart();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// API health endpoint
// Single source of truth for the version: the GENERATED appVersion module
// (written from package.json by the build — see scripts/write-version.mjs).
// The old runtime package.json read broke in packaged installs where no
// package.json sits next to the bundle; the generated constant is bundled
// INTO server.cjs and can never drift or go missing.
function readAppVersion(): string {
  return APP_VERSION;
}

// v1.7.0 — BROWSER SCREEN VISION registry. The /api/screen-vision socket
// (below) registers sharing channels here; the /api/live Gemini sessions
// register themselves as frame destinations. Pure logic, unit-tested in
// src/__tests__/screenVision.test.ts.
//
// v1.8.0 — TWO NEW CAPABILITIES, both injected (registry stays pure):
//  1) TesseractScreenOcrEngine — ultra-precise reading: every few seconds
//     (v1.8.1: per-channel interval, client-selectable via the dock's
//     OCR EVERY stepper, live-adjustable over the wire) the newest shared
//     frame is OCR'd; the exact visible text rides along with the image
//     into the model (and gives LOCAL MODE text-vision).
//  2) Screen memory bridge — each distinct screen state is digested into
//     a bounded per-user log ("what was on my screen earlier?" works
//     during AND after the share), and when a share ends the summary is
//     persisted into the same MemoryManager the user's facts live in —
//     with its secret filter refusing anything password-shaped.
const screenOcrEngine = new TesseractScreenOcrEngine();
const commitScreenShareMemory = (summary: ScreenShareEndedSummary): void => {
  // Fire-and-forget: persistence must never block teardown. MemoryManager
  // blocks secrets (passwords / tokens / card numbers) by design.
  void (async () => {
    try {
      const fact = formatShareEndedFact(
        summary.digest,
        summary.startedAt,
        summary.endedAt,
        summary.source,
      );
      await defaultMemoryManager.rememberForSpeaker(
        summary.authorizationId,
        fact,
        'other',
        undefined,
        'medium',
      );
      console.log(
        `[SCREEN-MEMORY] Share session persisted (${summary.source}, ${Math.round((summary.endedAt - summary.startedAt) / 1000)}s).`,
      );
    } catch (err) {
      console.warn('[SCREEN-MEMORY] Persisting share summary failed:', err instanceof Error ? err.message : err);
    }
  })();
};
const screenVisionRegistry = new ScreenVisionRegistry({
  ocr: screenOcrEngine,
  onShareEnded: commitScreenShareMemory,
});

app.get('/api/health', (req, res) => {
  // v1.6.11: richer liveness payload — uptime, memory footprint, live WS
  // client count and auth posture so the launcher / diagnostics panel can
  // distinguish "up" from "up and actually serving sessions".
  const memory = process.memoryUsage();
  res.json({
    status: 'ok',
    app: APP_CONFIG.appName,
    version: readAppVersion(),
    model: APP_CONFIG.geminiLiveModel,
    mode: currentRunMode,
    hasApiKey: Boolean(process.env.GEMINI_API_KEY) || defaultApiKeyVault.has('gemini'),
    uptimeSeconds: Math.floor(process.uptime()),
    nodeVersion: process.version,
    memoryRssMb: Math.round(memory.rss / (1024 * 1024)),
    connectedWebSocketClients: connectedClients.size,
    tokenAuthEnabled: Boolean(process.env.SERA_AUTH_TOKEN),
    // v1.7.0: browser screen-vision channel telemetry.
    screenVision: screenVisionRegistry.status(),
  });
});

/* ──────────────────────────────────────────────────────────────────
 * MODE SWITCHER — 1-click Local ↔ Online (spec section A.2)
 * ────────────────────────────────────────────────────────────────── */
app.get('/api/mode', (_req, res) => {
  res.json({ mode: currentRunMode });
});

app.post('/api/mode', (req, res) => {
  const requested = req.body?.mode;
  if (requested !== 'online' && requested !== 'local') {
    res.status(400).json({ error: 'mode must be "online" or "local"' });
    return;
  }
  currentRunMode = requested;
  res.json({ mode: currentRunMode, switchedAt: new Date().toISOString() });
});

/* ──────────────────────────────────────────────────────────────────
 * LOCAL MODE — hardware audit, model recommendation, Ollama manager
 * (spec section A.1)
 * ────────────────────────────────────────────────────────────────── */
app.get('/api/local/hardware', async (req, res) => {
  try {
    // ?rescan=1 forces a fresh probe (RE-SCAN HARDWARE button); the default
    // serves the 5-minute cache so opening panels stops spawning nvidia-smi.
    const hardware = await defaultHardwareInspector.audit({ fresh: req.query.rescan === '1' });
    const recommendation = recommendLocalModel(hardware);
    res.json({ hardware, recommendation });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/local/status', async (req, res) => {
  try {
    const fresh = req.query.rescan === '1';
    const [ollama, hardware] = await Promise.all([
      ollamaClient.status(),
      defaultHardwareInspector.audit({ fresh }),
    ]);
    const recommendation = recommendLocalModel(hardware);
    const installedModels = ollama.running ? await ollamaClient.listModels() : [];
    res.json({
      ollama,
      hardware,
      recommendation,
      installedModels,
      recommendedModelInstalled: installedModels.some((m) => m.name.startsWith(recommendation.model.split(':')[0])),
      speech: {
        stt: localWhisper.availability(),
        tts: localPiper.availability(),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * GET /api/local/catalog — every locally-runnable model SERA knows about,
 * with the hardware budget so the MY PC tab can render the full
 * "choose your own model" picker (recommended card stays on top).
 */
app.get('/api/local/catalog', async (req, res) => {
  try {
    const hardware = await defaultHardwareInspector.audit({ fresh: req.query.rescan === '1' });
    const recommendation = recommendLocalModel(hardware);
    res.json({
      tier: hardware.tier,
      vramAvailableMB: recommendation.budget.vramAvailableMB,
      recommended: recommendation.model,
      // v1.9.0: every entry now carries its honest fit grading so the MY PC
      // picker can badge models (EXCELLENT FIT / PARTIAL OFFLOAD / …)
      // instead of a raw fits-or-not boolean.
      catalog: gradeCatalog(hardware),
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/local/pull', heavyApiLimiter, async (req, res) => {
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  if (!model || !/^[\w.:/-]+$/.test(model)) {
    res.status(400).json({ error: 'A valid model name is required (e.g. qwen2.5:7b-instruct-q4_K_M).' });
    return;
  }

  // Stream NDJSON progress lines so the wizard can render a live bar.
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const sendLine = (event: PullProgressEvent) => {
    try {
      res.write(`${JSON.stringify(event)}\n`);
    } catch {
      // Client disconnected — pull continues server-side; harmless.
    }
  };

  // v1.8.4: pre-check the daemon BEFORE touching /api/pull. When Ollama is
  // not installed / not running, the old code let the fetch to
  // 127.0.0.1:11434 fail with a raw Node error — the MY PC tab and the
  // startup wizard showed the cryptic "Pull failed — NOT installed:
  // fetch failed" and the user had no idea what to do. Now the pull
  // streams an honest, actionable error immediately.
  if (!(await ollamaClient.isRunning())) {
    sendLine({
      status: 'error',
      completedBytes: null,
      totalBytes: null,
      fraction: null,
      done: true,
      error:
        'Ollama is not running, so the model cannot be downloaded. Fix in 2 minutes: ' +
        '1) Install Ollama from https://ollama.com/download if it is not installed yet. ' +
        '2) Start it — open "Ollama" from the Start Menu (Windows keeps it in the system tray) ' +
        'or run "ollama serve" in a terminal. 3) Come back and click INSTALL again. ' +
        'Or flip to Online Mode in the header — it needs no local setup at all.',
    });
    res.end();
    return;
  }

  // v1.9.0 (spec §19): disk-space pre-check. Dying at 97% of a 5 GB pull
  // because the disk filled wastes an hour and leaves a broken blob. Check
  // the drive Ollama unpacks models onto BEFORE the download starts; only
  // catalog models are checked (their size is known) — custom tags pass
  // through with Ollama's own error handling.
  const catalogSpec = LOCAL_MODEL_CATALOG.find((s) => s.id === model || s.id.split(':')[0] === model.split(':')[0]);
  if (catalogSpec) {
    const verdict = verdictForPull(catalogSpec.downloadMB);
    if (!verdict.ok && verdict.reason) {
      sendLine({ status: 'error', completedBytes: null, totalBytes: null, fraction: null, done: true, error: verdict.reason });
      res.end();
      return;
    }
  }

  try {
    const result = await ollamaClient.pullModel(model, sendLine);
    bootLogger.info(`model pull ${result.success ? 'ok' : 'failed'}`, { model, error: result.error });
    sendLine({ status: result.success ? 'complete' : 'failed', completedBytes: null, totalBytes: null, fraction: result.success ? 1 : null, done: true, error: result.error });
  } catch (error) {
    sendLine({ status: 'error', completedBytes: null, totalBytes: null, fraction: null, done: true, error: error instanceof Error ? error.message : String(error) });
  } finally {
    res.end();
  }
});

app.post('/api/local/chat', heavyApiLimiter, async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : 'http-local-session';
  const model = typeof req.body?.model === 'string' ? req.body.model : undefined;
  if (!text) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  if (!(await ollamaClient.isRunning())) {
    res.status(503).json({ error: 'Ollama is not running. Start it (ollama serve) or switch to Online mode.' });
    return;
  }
  try {
    const events: unknown[] = [];
    const result = await localAgentEngine.processTurn(sessionId, text, {
      model,
      emit: (event) => events.push(event),
    });
    res.json({ ...result, events });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/local/echo-test', async (_req, res) => {
  // Round-trip probe used by the diagnostics panel for local engines.
  const running = await ollamaClient.isRunning();
  res.json({ ollamaRunning: running, stt: localWhisper.availability(), tts: localPiper.availability() });
});

/* ── v1.9.0 OLLAMA MANAGER (spec §11/§12) ────────────────────────
 * GET  /api/local/ollama  → honest state A/B/C snapshot
 * POST /api/local/ollama/start → State B: spawn `ollama serve` ONLY when
 * the CLI was found and the daemon is down; SERA owns + later kills only
 * the process it started. The official tray app is never touched. */
app.get('/api/local/ollama', async (_req, res) => {
  res.json(await defaultOllamaManager.report());
});

app.post('/api/local/ollama/start', heavyApiLimiter, async (_req, res) => {
  const report = await defaultOllamaManager.ensureRunning();
  res.json(report);
});

/* ──────────────────────────────────────────────────────────────────
 * API KEY VAULT — encrypted custom key manager (spec section A.1.2)
 * ────────────────────────────────────────────────────────────────── */
app.get('/api/keys', (_req, res) => {
  res.json({
    providers: API_PROVIDERS.map((p) => ({ id: p.id, label: p.label, keyUrl: p.keyUrl, envVar: p.envVar })),
    entries: defaultApiKeyVault.list(),
  });
});

app.put('/api/keys/:provider', async (req, res) => {
  const provider = req.params.provider as ApiProvider;
  if (!API_PROVIDERS.some((p) => p.id === provider)) {
    res.status(400).json({ error: `Unknown provider "${provider}"` });
    return;
  }
  const key = typeof req.body?.key === 'string' ? req.body.key : '';
  if (!key.trim()) {
    res.status(400).json({ error: 'key is required' });
    return;
  }
  try {
    const entry = defaultApiKeyVault.setKey(provider, key);
    // Optional instant validation right after save.
    const test = req.body?.test === true ? await defaultApiKeyVault.testKey(provider, key) : undefined;
    res.json({ entry, test });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete('/api/keys/:provider', (req, res) => {
  const provider = req.params.provider as ApiProvider;
  // v1.6.11 FIX: an unknown provider used to return 200 {deleted:false} —
  // a typo'd client looked like a success. Asymmetric with PUT/POST too.
  if (!API_PROVIDERS.some((p) => p.id === provider)) {
    res.status(404).json({ error: `Unknown provider "${provider}"` });
    return;
  }
  const deleted = defaultApiKeyVault.deleteKey(provider);
  res.json({ deleted });
});

app.post('/api/keys/:provider/test', async (req, res) => {
  const provider = req.params.provider as ApiProvider;
  if (!API_PROVIDERS.some((p) => p.id === provider)) {
    res.status(400).json({ error: `Unknown provider "${provider}"` });
    return;
  }
  const providedKey = typeof req.body?.key === 'string' ? req.body.key : undefined;
  try {
    const result = await defaultApiKeyVault.testKey(provider, providedKey);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/* ──────────────────────────────────────────────────────────────────
 * AGI COGNITIVE ENGINE + LEARNING introspection (spec sections D & E)
 * ────────────────────────────────────────────────────────────────── */
app.post('/api/agi/goal', heavyApiLimiter, async (req, res) => {
  const goal = typeof req.body?.goal === 'string' ? req.body.goal.trim() : '';
  if (!goal) {
    res.status(400).json({ error: 'goal is required' });
    return;
  }
  try {
    const { report, perception } = await cognitiveEngine.pursueGoal(goal, {
      sessionId: 'agi-http',
      // Multi-model planning: let the orchestrator pick a brain for the
      // planning subtask; the regex planner stays as the offline fallback.
      llmPlanner: orchestratorPlanSteps,
    });
    res.json({ report, perception });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/agi/mistakes', (_req, res) => {
  // v1.6.11 FIX: the old `recentLessons(Number.MAX_SAFE_INTEGER)` hack
  // materialized the entire mistake memory just to count it.
  res.json({
    lessons: defaultErrorReflectionEngine.recentLessons(10),
    mistakeMemorySize: defaultErrorReflectionEngine.lessonCount(),
  });
});

/* ──────────────────────────────────────────────────────────────────
 * MODEL ORCHESTRATOR — free-first multi-model routing
 * (classify -> route -> execute -> fallback -> telemetry)
 * ────────────────────────────────────────────────────────────────── */

/**
 * Orchestrator-backed LLM planner for the AGI goal engine. Asks the best
 * available brain for a JSON DAG; returns null on ANY problem so the
 * deterministic regex planner takes over (offline-safe by construction).
 */
async function orchestratorPlanSteps(goal: string): Promise<PlanStep[] | null> {
  try {
    const result = await defaultModelOrchestrator.generate({
      text: goal,
      taskType: 'planning',
      system:
        'You are a planning module. Decompose the goal into 2-6 concrete steps. ' +
        'Reply with ONLY a JSON array, no prose, no code fences. Each item: ' +
        '{"id":"s1","description":"imperative step","tool":"optional-tool-name",' +
        '"args":{},"dependsOn":[]}. Use dependsOn ids for ordering. If the goal is ' +
        'not decomposable into computer actions, reply [].',
      temperature: 0.2,
      maxTokens: 700,
    });
    if (!result.ok) return null;
    const match = result.text.match(/\[[\s\S]*\]/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as PlanStep[];
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 8) return null;
    return parsed
      .filter((s) => s && typeof s.id === 'string' && typeof s.description === 'string')
      .map((s, i) => ({
        id: String(s.id),
        description: String(s.description),
        tool: typeof s.tool === 'string' && s.tool.length > 0 ? String(s.tool) : undefined,
        args: s.args && typeof s.args === 'object' ? (s.args as Record<string, unknown>) : undefined,
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : i > 0 ? [parsed[i - 1]?.id ?? ''] : [],
      }));
  } catch {
    return null; // any planner failure -> deterministic rules take over
  }
}

app.get('/api/orchestrator/status', (_req, res) => {
  res.json(defaultModelOrchestrator.status());
});

// Explainability: classify + score a request WITHOUT executing it.
app.post('/api/orchestrator/route', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (!text.trim()) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  const decision = defaultModelOrchestrator.routeOnly({ text, hasImages: Boolean(req.body?.hasImages) });
  res.json({ decision, explanation: defaultModelOrchestrator.explain(decision) });
});

// Full routed generation with smart fallback.
app.post('/api/orchestrator/chat', heavyApiLimiter, async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (!text.trim()) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  try {
    const result = await defaultModelOrchestrator.generate({
      text,
      sessionId: typeof req.body?.sessionId === 'string' ? req.body.sessionId : 'orchestrator-http',
      system: typeof req.body?.system === 'string' ? req.body.system : undefined,
      taskType: typeof req.body?.taskType === 'string' ? req.body.taskType : undefined,
      privacy: typeof req.body?.privacy === 'string' ? req.body.privacy : undefined,
    });
    res.json({
      ok: result.ok,
      text: result.text,
      explanation: result.explanation,
      attempts: result.attempts,
      decision: result.decision,
      telemetry: result.telemetry,
      error: result.error,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Settings: routing mode, paid-provider kill switch, per-provider controls.
app.post('/api/orchestrator/settings', (req, res) => {
  const body = req.body ?? {};
  const applied: string[] = [];
  const rejected: string[] = [];

  if (typeof body.routingMode === 'string') {
    const modes = ['free_first', 'local_first', 'balanced', 'performance_first', 'custom'];
    if (modes.includes(body.routingMode)) {
      defaultModelOrchestrator.setRoutingMode(body.routingMode);
      applied.push(`routingMode=${body.routingMode}`);
    } else rejected.push('routingMode invalid');
  }

  if (typeof body.allowPaidProviders === 'boolean') {
    defaultModelOrchestrator.cost.setAllowPaid(body.allowPaidProviders);
    applied.push(`allowPaidProviders=${body.allowPaidProviders}`);
  }

  if (typeof body.providerId === 'string') {
    if (typeof body.enabled === 'boolean') {
      const provider = defaultModelOrchestrator.registry.get(body.providerId);
      // PAID providers additionally need the global switch — refuse the
      // per-provider enable while paid is locked OFF (never spend silently).
      const isPaid = provider?.type === 'paid';
      const paidAllowed = defaultModelOrchestrator.cost.allowsPaid() || defaultModelOrchestrator.cost.summary().allowPaidProviders;
      if (isPaid && body.enabled && !paidAllowed) {
        rejected.push(`${body.providerId}: enable "Allow paid providers" first`);
      } else if (defaultModelOrchestrator.setProviderEnabled(body.providerId, body.enabled)) {
        applied.push(`${body.providerId}.enabled=${body.enabled}`);
      } else rejected.push(`${body.providerId}: unknown provider`);
    }
    if (typeof body.priority === 'number') {
      if (defaultModelOrchestrator.setProviderPriority(body.providerId, body.priority)) applied.push(`${body.providerId}.priority=${body.priority}`);
      else rejected.push(`${body.providerId}: priority not applied`);
    }
    if (typeof body.trustedForPrivate === 'boolean') {
      if (defaultModelOrchestrator.setProviderTrustedForPrivate(body.providerId, body.trustedForPrivate)) applied.push(`${body.providerId}.trustedForPrivate=${body.trustedForPrivate}`);
      else rejected.push(`${body.providerId}: trust not applied`);
    }
  }

  res.json({ applied, rejected, status: defaultModelOrchestrator.status() });
});

app.post('/api/orchestrator/providers/test', heavyApiLimiter, async (req, res) => {
  const id = typeof req.body?.providerId === 'string' ? req.body.providerId : '';
  if (!id) {
    res.status(400).json({ error: 'providerId is required' });
    return;
  }
  try {
    res.json(await defaultModelOrchestrator.testProvider(id));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Startup model audit: hardware + roles (primary/voice/reasoning/fallback).
app.get('/api/orchestrator/audit', async (_req, res) => {
  try {
    res.json(await defaultModelOrchestrator.audit());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/tools', (req, res) => {
  res.json({
    tools: defaultToolManager.getAllTools().map((t) => ({
      name: t.name,
      description: t.description,
      permissionLevel: t.permissionLevel,
      capability: t.capability || null,
      dynamicCapability: Boolean(t.capabilityForArgs),
      parameters: t.parameters,
    })),
  });
});

const server = http.createServer(app);

// All currently-connected /api/live clients — used by /api/health stats
// and by graceful shutdown (close every socket before exiting).
const connectedClients = new Set<WebSocket>();

// WebSocket server for Gemini Live real-time bidirectional audio.
// v1.6.11 SECURITY: the upgrade is validated by the SAME guard as HTTP —
// a webpage in the user's browser (browsers do NOT apply CORS to WebSocket
// handshakes) can no longer drive the 36-tool computer-control surface.
//
// v1.7.0 ROUTER: two WS endpoints now live on this HTTP server (/api/live
// and /api/screen-vision), so both WebSocketServers run in noServer mode
// and a single server.on('upgrade') dispatcher routes by pathname. (The
// ws library's path-matching mode makes the FIRST server abort any
// handshake whose path doesn't match ITS OWN — with two path-based
// servers the /api/live instance 400-killed every /api/screen-vision
// upgrade before the screen-vision instance could accept it.)
const websocketUpgradeGuard = (info: { req: http.IncomingMessage }, cb: (ok: boolean, code?: number, reason?: string) => void) => {
  try {
    const decision = requestGuard.evaluate(info.req);
    if (decision.allowed) {
      cb(true);
      return;
    }
    console.warn(`[SECURITY] Rejected WebSocket upgrade — ${decision.reason ?? 'blocked'}`);
    cb(false, decision.status ?? 403, decision.reason ?? 'Forbidden');
  } catch (err) {
    console.warn('[SECURITY] WebSocket upgrade validation crashed:', err);
    cb(false, 1011, 'Upgrade validation failed');
  }
};

const wss = new WebSocketServer({
  noServer: true,
  verifyClient: websocketUpgradeGuard,
});

wss.on('error', (err) => {
  console.error('WebSocket server error:', err);
});

// ── v1.7.0 BROWSER SCREEN VISION CHANNEL ─────────────────────────
// A dedicated WebSocket (noServer; the upgrade dispatcher above routes
// /api/screen-vision here) for the browser screen share. Frames are capped
// at 1MB wire size and flood-guarded by the registry (connection handling
// and the full rationale live below, above the 'connection' handler).
const screenVisionWss = new WebSocketServer({
  noServer: true,
  maxPayload: 1_000_000,
  verifyClient: websocketUpgradeGuard,
});

screenVisionWss.on('error', (err) => {
  console.error('Screen vision WebSocket server error:', err);
});

// Single upgrade dispatcher: route by pathname to the owning server.
// Unknown WS paths get the socket destroyed (never a silent hang).
server.on('upgrade', (req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
  let pathname = '';
  try {
    pathname = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`).pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname === '/api/screen-vision') {
    screenVisionWss.handleUpgrade(req, socket, head, (ws) => screenVisionWss.emit('connection', ws, req));
  } else if (pathname === '/api/live') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ── v1.7.0 BROWSER SCREEN VISION CHANNEL (connection handling) ────
// A dedicated WebSocket for the browser screen share. Decoupled from
// /api/live on purpose: the share must survive Gemini session rollovers
// (Google closes Live sessions every ~7-10 min). Frames arriving while no
// live session exists buffer server-side (bounded) and are injected into
// the next session the instant it becomes ready — before any queued
// question — so "what is on my screen?" is ALWAYS answered from the
// CURRENT screen. Same security guard as /api/live; frames are capped at
// 1MB wire size and flood-guarded by the registry.
//
// (The server instance itself is created above in noServer mode; the
// upgrade dispatcher routes /api/screen-vision here.)

screenVisionWss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  const channelUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const authorizationId = channelUrl.searchParams.get('authorizationId') || 'anonymous';
  const logChannel = (event: string, details: Record<string, unknown> = {}) => {
    console.log(
      `[SCREEN-VISION] ${event} ${JSON.stringify({ authorizationId: authorizationId.slice(0, 24), ...details })}`,
    );
  };
  let registered = false;

  const notify = (event: Record<string, unknown>) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(event));
    } catch { /* socket dying — registry state stays internal */ }
  };

  ws.on('message', (rawMsg: Buffer | string) => {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawMsg.toString()) as Record<string, unknown>;
    } catch {
      return; // malformed packet — never kill the channel over one frame
    }
    if (!payload || typeof payload !== 'object') return;

    switch (payload.type) {
      case 'start': {
        screenVisionRegistry.registerChannel(authorizationId, {
          visionMode: payload.visionMode === true,
          source: typeof payload.source === 'string' ? payload.source : undefined,
          intervalMs: typeof payload.intervalMs === 'number' ? payload.intervalMs : undefined,
          ocrIntervalMs: typeof payload.ocrIntervalMs === 'number' ? payload.ocrIntervalMs : undefined,
          notify,
        });
        registered = true;
        logChannel('SHARE_STARTED', {
          visionMode: payload.visionMode === true,
          source: typeof payload.source === 'string' ? payload.source : 'unknown',
          ocrIntervalMs: screenVisionRegistry.getChannelSnapshot(authorizationId)?.ocrIntervalMs,
        });
        break;
      }
      case 'frame': {
        const result = screenVisionRegistry.ingestFrame(authorizationId, payload, {
          oneShot: payload.oneShot === true,
        });
        if (result === 'forwarded' || result === 'buffered') {
          if (result === 'forwarded') {
            logChannel('FRAME_FORWARDED', {
              bytes: typeof payload.bytes === 'number' ? payload.bytes : undefined,
              oneShot: payload.oneShot === true,
            });
          }
        } else if (result !== 'dropped-paused' && result !== 'dropped-mode-off') {
          // Expected quiet drops are not logged; real problems are.
          logChannel('FRAME_DROPPED', {
            result,
            dataChars: typeof payload.data === 'string' ? payload.data.length : 0,
          });
          if (result === 'dropped-invalid' || result === 'dropped-oversize') {
            notify({
              type: 'screen_vision_error',
              error: 'A screen frame was rejected by the server (invalid or oversized) and was skipped.',
            });
          }
        }
        break;
      }
      case 'vision_mode': {
        screenVisionRegistry.setVisionMode(authorizationId, payload.enabled === true);
        logChannel('VISION_MODE', { enabled: payload.enabled === true });
        break;
      }
      // v1.8.1 — live OCR interval change from the dock stepper. The
      // registry clamps the value and echoes the effective interval back
      // via screen_channel_state; an unknown channel is a quiet no-op (the
      // client may fire this while reconnecting).
      case 'ocr_interval': {
        const effectiveMs = screenVisionRegistry.setOcrInterval(authorizationId, payload.ocrIntervalMs);
        if (effectiveMs !== null) {
          logChannel('OCR_INTERVAL', { effectiveMs, requested: payload.ocrIntervalMs });
        }
        break;
      }
      case 'pause': {
        screenVisionRegistry.setPaused(authorizationId, true);
        break;
      }
      case 'resume': {
        screenVisionRegistry.setPaused(authorizationId, false);
        break;
      }
      case 'stop': {
        screenVisionRegistry.markChannelStopped(authorizationId, 'user_stop');
        registered = false;
        logChannel('SHARE_STOPPED', {});
        break;
      }
      case 'ping': {
        notify({ type: 'pong' });
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    // Grace period lives in the registry: a blip-and-reconnect cancels the
    // drop; a truly dead tab tells the live model it can no longer see.
    if (registered) {
      screenVisionRegistry.dropChannel(authorizationId, notify);
      logChannel('CHANNEL_CLOSED', {});
    }
  });

  ws.on('error', () => {
    // 'close' always follows — cleanup happens there.
  });
});

/**
 * LOCAL MODE live session (100% offline brain, spec sections A + D).
 *
 * Mirrors the Gemini Live wire protocol so the frontend LocalSession can
 * render identical events: ready / transcript / tool_call / tool_result /
 * browser_action / error. Audio input attempts local whisper first; when
 * unavailable the client falls back to browser speech recognition.
 */
function runLocalLiveSession(
  clientWs: WebSocket,
  ctx: { sessionId: string; startAttemptId: string; logSession: (event: string, details?: Record<string, unknown>) => void; requestedModel: string | null; authorizationId: string },
): void {
  const { sessionId, startAttemptId, logSession } = ctx;
  let currentSpeakerId: string | undefined;
  let closed = false;

  // Serialize agent turns so overlapping user messages queue cleanly.
  let turnChain: Promise<void> = Promise.resolve();

  const send = (payload: Record<string, unknown>): void => {
    if (closed || clientWs.readyState !== WebSocket.OPEN) return;
    try {
      clientWs.send(JSON.stringify(payload));
    } catch (err) {
      logSession('LOCAL_SEND_FAILED', { error: err instanceof Error ? err.message : String(err) });
    }
  };

  logSession('LOCAL_MODE_SESSION_START', { model: ctx.requestedModel || 'auto' });
  send({ type: 'ready', mode: 'local', sessionId, model: ctx.requestedModel || 'auto' });

  // v1.9.0 (spec §52 — missing-model UX): if the client explicitly selected
  // a model that Ollama no longer has (deleted, different machine profile,
  // failed update), say so IMMEDIATELY and explicitly. NEVER silently
  // substitute another model — the user must reinstall, choose another, or
  // run a system check. The notice is advisory: turns still go to Ollama,
  // which will answer with its own honest "model not found" error.
  if (ctx.requestedModel) {
    void (async () => {
      const ollamaRunning = await ollamaClient.isRunning().catch(() => false);
      if (!ollamaRunning) return;
      const present = await ollamaClient.hasModel(ctx.requestedModel).catch(() => true);
      if (!present && !closed) {
        logSession('LOCAL_MODEL_MISSING', { model: ctx.requestedModel });
        send({
          type: 'model_missing',
          model: ctx.requestedModel,
          message:
            `The selected model "${ctx.requestedModel}" is not installed in Ollama anymore. ` +
            'REINSTALL it: Settings → MY PC → INSTALL. ' +
            'Or CHOOSE ANOTHER: Settings → MY PC → pick any installed model. ' +
            'Or run a SYSTEM CHECK: Settings → MY PC → the diagnostics panel explains what is missing.',
          actions: ['reinstall', 'choose-another', 'system-check'],
        });
      }
    })();
  }

  /**
   * One agent turn from either input channel (typed text or whisper-
   * transcribed voice). Both paths previously duplicated this logic —
   * and the voice path never actually called processTurn at all, which
   * is the "local mode mic doesn't work" root cause: whisper could
   * transcribe your voice but the transcribed text went nowhere.
   */
  const runAgentTurn = (text: string): void => {
    send({ type: 'transcript', sender: 'user', text, isPartial: false });
    send({ type: 'status', state: 'processing' });
    // v1.7.0: the user may be screen-sharing via the browser channel, but
    // Ollama cannot see images. Prepend an honest hint on screen questions
    // so the local model admits the limitation instead of inventing what
    // is on screen.
    const screenHint = screenVisionRegistry.localModeScreenHint(ctx.authorizationId, text);
    const effectiveText = screenHint ? `${text}\n\n${screenHint}` : text;
    turnChain = turnChain
      .then(() => localAgentEngine.processTurn(sessionId, effectiveText, {
        model: ctx.requestedModel || undefined,
        speakerId: currentSpeakerId,
        emit: (event) => send(event as unknown as Record<string, unknown>),
        // Tools are capability-gated. Online mode executes them under
        // the stable auth-... ID (auto-trusted for the desktop app);
        // local mode previously ran under the ephemeral session-... ID,
        // which stayed STANDARD and denied EVERY system tool — the
        // real root cause of "local mode can't open anything".
        toolSessionId: ctx.authorizationId,
        // The raw user utterance lets the engine's desktop-control guard
        // tell a hallucinated "press ctrl+c" apart from a real request.
        utterance: text,
      }))
      .then((result) => {
        logSession('LOCAL_TURN_COMPLETE', {
          iterations: result.iterations,
          toolCallsExecuted: result.toolCallsExecuted,
          blockedToolCalls: result.blockedToolCalls,
          replyLength: result.reply.length,
        });
        send({ type: 'turn_complete' });
      })
      .catch((err) => {
        logSession('LOCAL_TURN_ERROR', { error: err instanceof Error ? err.message : String(err) });
        send({ type: 'error', error: err instanceof Error ? err.message : String(err) });
      });
  };

  clientWs.on('message', (rawMsg: Buffer | string) => {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawMsg.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    if (payload.type === 'speaker_context' && typeof payload.speakerId === 'string') {
      currentSpeakerId = payload.known ? String(payload.speakerId) : undefined;
      return;
    }

    if (payload.type === 'interrupt') {
      // Nothing streaming server-side in local mode; acknowledged for parity.
      send({ type: 'interrupted' });
      return;
    }

    if (payload.type === 'audio' && typeof payload.data === 'string') {
      // Voice input: transcribe through local whisper, then run the SAME
      // agent turn the typed-text path uses. Previously this only sent a
      // transcript event the client never acted on — transcribed speech
      // literally went nowhere.
      const pcm16 = Buffer.from(payload.data, 'base64');
      if (pcm16.length < 100) return; // noise / click guard
      turnChain = turnChain.then(async () => {
        send({ type: 'status', state: 'processing' });
        const result = await localWhisper.transcribePcm16(pcm16);
        if (result.success && result.text.trim()) {
          logSession('LOCAL_STT_TRANSCRIBED', { chars: result.text.trim().length });
          runAgentTurn(result.text.trim());
        } else {
          send({
            type: 'stt_unavailable',
            reason: result.error || 'Local whisper not installed',
            fallback: 'browser',
          });
        }
      }).catch((err) => {
        logSession('LOCAL_STT_ERROR', { error: err instanceof Error ? err.message : String(err) });
      });
      return;
    }

    if (payload.type === 'text' && typeof payload.text === 'string' && payload.text.trim()) {
      runAgentTurn(String(payload.text).trim());
      return;
    }

    logSession('LOCAL_UNKNOWN_MESSAGE', { messageType: String(payload.type || 'unknown') });
  });

  clientWs.on('close', () => {
    closed = true;
    logSession('LOCAL_MODE_SESSION_CLOSED', {});
    // v1.6.11 FIX: local-mode tools (controlScreen startSharing) start the
    // shared 100ms screen-capture timer through the SAME controller the
    // online mode uses. The old handler never stopped it — a local session
    // that shared its screen kept capturing at ~10fps forever after the
    // client disconnected.
    try { void defaultScreenController.stopSharing(); } catch { /* already off */ }
  });

  clientWs.on('error', (err) => {
    logSession('LOCAL_MODE_SOCKET_ERROR', { error: err.message });
  });
}

wss.on('connection', (clientWs: WebSocket, req) => {
  connectedClients.add(clientWs);
  clientWs.on('close', () => connectedClients.delete(clientWs));

  // v1.6.11: verifyClient already validated the upgrade, but a socket that
  // slips through (e.g. a future bypass) gets a second check here.
  const guardDecision = requestGuard.evaluate(req);
  if (!guardDecision.allowed) {
    console.warn(`[SECURITY] Closing WebSocket after upgrade — ${guardDecision.reason ?? 'blocked'}`);
    try { clientWs.close(1008, 'Forbidden'); } catch { /* already closing */ }
    return;
  }

  // v1.6.11 FIX: the handler used to be an `async` callback registered
  // directly with `wss.on('connection')` — any synchronous throw (e.g.
  // `new URL` on a malformed request URL) became an unhandled rejection
  // and left the socket dangling half-initialized. It is now a guarded
  // standalone async function.
  void handleLiveConnection(clientWs, req).catch((err) => {
    console.error('[SERVER] WebSocket connection handler failed:', err instanceof Error ? err.message : String(err));
    try { clientWs.close(1011, 'Internal server error'); } catch { /* already closed */ }
  });
});

async function handleLiveConnection(clientWs: WebSocket, req: http.IncomingMessage): Promise<void> {
  // Online-mode key resolution: environment first, then encrypted vault.
  const apiKey = process.env.GEMINI_API_KEY || defaultApiKeyVault.resolveKey('gemini') || null;
  const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestUrl = new URL(req.url || '', 'http://' + (req.headers.host || 'localhost'));
  const startAttemptId = requestUrl.searchParams.get('startAttemptId') || 'unknown';
  const authorizationId = requestUrl.searchParams.get('authorizationId') || sessionId;

  let geminiSessionState = 'INITIALIZING';
  const logSession = (event: string, details: Record<string, unknown> = {}) => {
    logLifecycleEvent(sessionId, event, {
      startAttemptId,
      websocketState: describeWebSocketState(clientWs),
      geminiSessionState,
      ...details,
    });
  };

  // v1.6.8: per-chunk audio logging collapsed into a rolling 15s summary.
  // The user's "SERA Server" window was a wall of GEMINI_CLIENT_AUDIO_*
  // JSON blocks; now one line every 15s carries the same signal.
  let audioChunkCount = 0;
  let audioChunkBytes = 0;
  let audioMaxGapMs = 0;
  let prevAudioChunkAt = 0;
  let lastAudioSummaryAt = Date.now();
  const noteClientAudioChunk = (bytes: number) => {
    audioChunkCount += 1;
    audioChunkBytes += bytes;
    const now = Date.now();
    if (prevAudioChunkAt > 0) audioMaxGapMs = Math.max(audioMaxGapMs, now - prevAudioChunkAt);
    prevAudioChunkAt = now;
    if (now - lastAudioSummaryAt >= 15000) {
      logSession('AUDIO_FLOW_SUMMARY', {
        windowMs: now - lastAudioSummaryAt,
        chunks: audioChunkCount,
        approxKb: Math.round(audioChunkBytes / 1024),
        maxChunkGapMs: audioMaxGapMs,
      });
      audioChunkCount = 0;
      audioChunkBytes = 0;
      audioMaxGapMs = 0;
      lastAudioSummaryAt = now;
    }
  };
  const flushAudioSummary = (reason: string) => {
    if (audioChunkCount <= 0) return;
    logSession('AUDIO_FLOW_SUMMARY', {
      reason,
      chunks: audioChunkCount,
      approxKb: Math.round(audioChunkBytes / 1024),
      maxChunkGapMs: audioMaxGapMs,
    });
    audioChunkCount = 0;
    audioChunkBytes = 0;
    audioMaxGapMs = 0;
  };

  console.log(`[SERVER] 🔵 NEW WEBSOCKET CONNECTION: ${sessionId}`);
  console.log(`[SERVER] ${sessionId} START_ATTEMPT_ID: ${startAttemptId}`);
  logSession('CLIENT_SOCKET_CONNECTED', {
    requestUrl: req.url || '(none)',
    remoteAddress: req.socket.remoteAddress || '(unknown)',
  });

  // ── MODE ROUTING ────────────────────────────────────────────────
  // ?mode=local routes the socket to the 100% offline agent (Ollama +
  // local tool loop). Everything below falls through to Online mode
  // (Gemini Live). The client reconnects when the user flips modes,
  // giving a clean 1-click switch without closing the app.
  const requestedMode = requestUrl.searchParams.get('mode') === 'local' ? 'local' : 'online';
  if (requestedMode === 'local') {
    currentRunMode = 'local';
    runLocalLiveSession(clientWs, {
      sessionId,
      startAttemptId,
      logSession,
      requestedModel: requestUrl.searchParams.get('model'),
      authorizationId,
    });
    return;
  }
  currentRunMode = 'online';

  if (!apiKey) {
    const errorMessage = 'GEMINI_API_KEY environment variable is not configured on the server.';
    logSession('API_KEY_MISSING', { errorMessage });
    clientWs.send(
      JSON.stringify({
        type: 'error',
        error: errorMessage,
      })
    );
    clientWs.close(1008, 'API Key missing');
    return;
  }

  let session: any = null;
  let currentSpeakerId: string | undefined;
  let isSessionActive = false;
  const pendingTextQueue: string[] = [];
  const executionNamespace = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dispatchedActionIds = new Set<string>();
  const latencyTrace = new LatencyTrace();

  // ── v1.6.10 DISCORD-STYLE LIVE SCREEN SHARE ────────────────────
  // While sharing is active, `screenShareFeed` captures the screen ~1x/1.2s
  // and pushes changed JPEG frames into the Gemini session through the
  // realtimeInput media channel. The model SEES the screen continuously —
  // like a Discord screen share — instead of staring at one old screenshot.
  let screenShareFeed: LiveScreenShareFeed | null = null;

  const notifyScreenShareState = (event: { active: boolean; reason?: string; fps?: number; framesSent?: number; framesSkipped?: number }) => {
    if (clientWs.readyState !== WebSocket.OPEN) return;
    try {
      clientWs.send(JSON.stringify({ type: 'screen_share_state', ...event }));
    } catch { /* socket already dying — nothing to notify */ }
  };

  const startScreenShareFeed = (reason: string) => {
    if (screenShareFeed?.isActive) {
      logSession('SCREEN_SHARE_ALREADY_ACTIVE', { reason });
      return;
    }
    const ensureSharing = async (): Promise<ScreenFrame | null> => {
      if (!defaultScreenController.isSharing()) {
        try { await defaultScreenController.startSharing(); } catch { /* capture() still works without the flag */ }
      }
      return await defaultScreenController.capture();
    };
    screenShareFeed = new LiveScreenShareFeed(
      {
        capture: () => ensureSharing(),
        send: (image) => {
          if (!session || !isSessionActive) return false;
          try {
            session.sendRealtimeInput({ media: { data: image.data, mimeType: 'image/jpeg' } });
            return true;
          } catch (err) {
            logSession('SCREEN_SHARE_FRAME_REJECTED', { error: sanitizeError(err) });
            return false;
          }
        },
        onStateChange: (event) => {
          logSession(event.active ? 'SCREEN_SHARE_STARTED' : 'SCREEN_SHARE_STOPPED', { ...event } as Record<string, unknown>);
          notifyScreenShareState(event);
        },
      },
      { intervalMs: 1200, maxDimension: 1024, quality: 60, maxFrameBytes: 160_000 },
    );
    screenShareFeed.start();
    logSession('SCREEN_SHARE_FEED_REQUESTED', { reason });
  };

  const stopScreenShareFeed = (reason: string) => {
    if (screenShareFeed?.isActive) {
      screenShareFeed.stop(reason);
      return;
    }
    // Even with no feed running, mirror the OFF state so a stale UI badge
    // never sticks after a session rollover.
    notifyScreenShareState({ active: false, reason });
  };

  // ── v1.7.0 BROWSER SCREEN VISION — live-session side ──────────
  // This hook is what the ScreenVisionRegistry drives: browser share
  // frames arrive on the /api/screen-vision socket and are forwarded
  // through HERE into this Gemini session (realtimeInput media — the
  // wire path Google designed for continuous vision).
  const screenVisionHook: ScreenVisionSessionHook = {
    sendMedia: (frame) => {
      if (!session || !isSessionActive) return false;
      try {
        session.sendRealtimeInput({ media: { data: frame.data, mimeType: 'image/jpeg' } });
        return true;
      } catch (err) {
        logSession('SCREEN_VISION_FRAME_REJECTED', { error: sanitizeError(err) });
        return false;
      }
    },
    injectContext: (content) => {
      if (!session || !isSessionActive) return false;
      try {
        session.sendClientContent(content);
        return true;
      } catch (err) {
        logSession('SCREEN_VISION_INJECT_REJECTED', { error: sanitizeError(err) });
        return false;
      }
    },
    isActive: () => Boolean(session) && isSessionActive,
  };

  const urlParams = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`).searchParams;
  const requestedVoice = urlParams.get('voice') || APP_CONFIG.defaultSettings.voice;
  // Gemini session-resumption: when the client auto-reconnects after
  // Google closes a Live session (hard ~7-10 min limit), it passes the
  // previous session's handle so the new session RESUMES the conversation
  // with full context instead of starting a fresh one that re-introduces
  // itself — the #1 cause of the "SERA reconnects and greets again every
  // ~7-8 minutes" complaint.
  const resumeHandle = urlParams.get('resumeHandle') || undefined;

  // v1.6.11 — per-session serialization chain for Gemini server messages.
  let geminiMessageChain: Promise<void> = Promise.resolve();
  // v1.6.11 FIX: Gemini normally sends call ids; when absent, the old
  // per-message `callIndex` fallback restarted at 0 for EVERY message —
  // cross-message executionId collisions made ToolManager's dedupe return
  // the WRONG cached result. A session-scoped counter is unique forever.
  let sessionCallSeq = 0;
  const MAX_PENDING_TEXT_MESSAGES = 50;

  /**
   * Sends text to Gemini when the session can accept it. Returns false when
   * the session is missing/inactive or the send was rejected — the caller
   * queues the text for a later flush instead of dropping it.
   */
  const sendTextToGemini = (text: string): boolean => {
    if (!session || !isSessionActive) return false;
    try {
      if (typeof session.sendRealtimeInput === 'function') {
        session.sendRealtimeInput({ text });
        return true;
      }
      if (typeof session.sendClientContent === 'function') {
        try {
          session.sendClientContent({
            turns: [{ role: 'user', parts: [{ text }] }],
            turnComplete: true,
          });
          return true;
        } catch {
          return false;
        }
      }
      return false;
    } catch (err) {
      logSession('GEMINI_CLIENT_TEXT_REJECTED', { error: sanitizeError(err) });
      return false;
    }
  };

  /** One Gemini Live server message (audio, transcripts, tool calls). */
  const handleGeminiMessage = async (message: LiveServerMessage): Promise<void> => {
    if (clientWs.readyState !== WebSocket.OPEN) return;

    const responseMark = latencyTrace.mark('gemini.response');

    // Lightweight non-blocking telemetry (avoid deep stringifying large raw audio chunks)
    const hasAudio = Boolean(message.serverContent?.modelTurn?.parts?.some((p: any) => p.inlineData?.data));
    if (!hasAudio) {
      const messageSummary = {
        latencyMark: responseMark,
        hasServerContent: !!message.serverContent,
        hasToolCall: !!message.toolCall,
        hasTurnComplete: !!message.serverContent?.turnComplete,
        hasInterrupted: !!message.serverContent?.interrupted,
      };
      logSession('GEMINI_MESSAGE_RECEIVED', messageSummary);
    }

    // 0. Session resumption updates — forward the latest resumable
    //    handle to the client so an auto-reconnect can RESUME this
    //    exact conversation (no re-greet, no context loss).
    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
      try {
        clientWs.send(
          JSON.stringify({
            type: 'session_handle',
            handle: message.sessionResumptionUpdate.newHandle,
          })
        );
      } catch (sendErr) {
        console.warn(`[SERVER] ${sessionId} Failed to deliver session_handle:`, sendErr);
      }
    }

    // 1. Audio stream chunks and direct text parts from Gemini model turn
    const parts = message.serverContent?.modelTurn?.parts;
    if (parts && parts.length > 0) {
      for (const part of parts) {
        if (part.inlineData?.data) {
          clientWs.send(
            JSON.stringify({
              type: 'audio',
              data: part.inlineData.data,
              mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000',
            })
          );
        }
        if (part.text) {
          clientWs.send(
            JSON.stringify({
              type: 'transcript',
              sender: 'sera',
              text: part.text,
            })
          );
        }
      }
    }

    // 2. Real-time audio transcription events
    const serverContentAny = message.serverContent as any;
    const outputText = serverContentAny?.outputTranscription?.text || serverContentAny?.outputAudioTranscription?.text;
    if (outputText) {
      clientWs.send(
        JSON.stringify({
          type: 'transcript',
          sender: 'sera',
          text: outputText,
        })
      );
    }

    const inputText = serverContentAny?.inputTranscription?.text || serverContentAny?.inputAudioTranscription?.text;
    if (inputText) {
      clientWs.send(
        JSON.stringify({
          type: 'transcript',
          sender: 'user',
          text: inputText,
        })
      );
    }

    // 3. Interruption event (user barge-in)
    if (message.serverContent?.interrupted) {
      clientWs.send(
        JSON.stringify({
          type: 'interrupted',
        })
      );
    }

    // 4. Turn complete
    if (message.serverContent?.turnComplete) {
      const turnMark = latencyTrace.mark('turn.complete');
      clientWs.send(
        JSON.stringify({
          type: 'turn_complete',
        })
      );
    }

    // 5. Function call / Tool call handling
    if (message.toolCall) {
      const toolMark = latencyTrace.mark('tool.call');
      const calls = message.toolCall.functionCalls || [];
      const functionResponses: Array<{ id: string; name: string; response: { output: unknown } }> = [];
      const browserUrlsInBatch = new Set<string>();

      for (const call of calls) {
        const callId = call.id || `${executionNamespace}:auto-${++sessionCallSeq}`;
        const toolName = call.name;
        const toolArgs = call.args || {};

        // Notify client of invoked tool
        clientWs.send(
          JSON.stringify({
            type: 'tool_call',
            id: callId,
            name: toolName,
            args: toolArgs,
          })
        );

        // Execute tool safely via ToolManager.
        // v1.6.11 FIX: ToolManager guards tool.execute() failures, but a
        // THROWING validateArgs / capabilityForArgs used to reject straight
        // out of this loop — the remaining calls in the batch never received
        // functionResponses and the Gemini session hung waiting for them.
        // Every call is now individually guarded and always produces a
        // functionResponse, even on a crash.
        let executionResult: Awaited<ReturnType<typeof defaultToolManager.executeTool>>;
        try {
          executionResult = await defaultToolManager.executeTool(toolName, toolArgs, {
            sessionId: authorizationId,
            executionId: `${executionNamespace}:${callId}`,
            speakerId: currentSpeakerId,
          });
        } catch (toolErr) {
          executionResult = {
            success: false,
            error: `Tool "${toolName}" crashed: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`,
          };
        }

        // ── v1.6.10 LIVE SCREEN SHARE TRIGGER ──────────
        // When the model turns sharing ON, the live frame feed
        // starts (Discord-style continuous vision). When it turns
        // sharing OFF (or any tool reports sharing stopped), the
        // feed dies with it.
        if (toolName === 'controlScreen' || toolName === 'screenControl') {
          const op = (toolArgs as { operation?: string } | null)?.operation;
          if (executionResult.success && op === 'startSharing') {
            startScreenShareFeed('tool_controlScreen_startSharing');
          } else if (op === 'stopSharing') {
            stopScreenShareFeed('tool_controlScreen_stopSharing');
          }
        } else if (executionResult.success && executionResult.data && typeof executionResult.data === 'object') {
          const sharingFlag = (executionResult.data as { sharing?: unknown }).sharing;
          if (sharingFlag === true) startScreenShareFeed(`tool_${toolName}_sharing_true`);
          if (sharingFlag === false) stopScreenShareFeed(`tool_${toolName}_sharing_false`);
        }

        // Build the function response. For tool calls that
        // return image data (captureScreenshot, captureWindowScreenshot,
        // inspectScreen), include the image as an `inlineData` Part
        // in the response.output. Gemini Live's function-response
        // schema accepts an array of Parts — the image Part lets
        // the model actually SEE the screenshot pixels instead of
        // getting only the metadata string. This is the wire path
        // for VLM-style inspection on top of the JSON tool protocol.
        //
        // Previously the screenshot was returned as a base64 string
        // inside a JSON object field, but Gemini's tool-response
        // schema treats string fields as text — the model never
        // saw the pixels and could only read the dimensions.
        // That was the structural cause of "I took a screenshot
        // but couldn't tell you what's on the screen."
        const isImageResult = executionResult.success
          && executionResult.data
          && typeof executionResult.data === 'object'
          && 'format' in executionResult.data
          && (executionResult.data as { format?: string }).format === 'png'
          && 'data' in executionResult.data
          && typeof (executionResult.data as { data?: string }).data === 'string'
          && ((executionResult.data as { data: string }).data.length > 0);

        if (isImageResult) {
          const img = executionResult.data as {
            data: string;
            width?: number;
            height?: number;
            capturedAt?: string;
            displayId?: string;
            windowHandle?: string | number;
          };
          // Strip the heavy base64 payload from the JSON object
          // Gemini sees as text, and ship it as a Part instead.
          const meta: Record<string, unknown> = {
            width: img.width,
            height: img.height,
            capturedAt: img.capturedAt,
            format: 'png',
          };
          if (img.displayId) meta.displayId = img.displayId;
          if (img.windowHandle !== undefined) meta.windowHandle = img.windowHandle;

          // v1.6.10 FIX — JPEG-encode EVERY image before it
          // touches the Live wire. The v1.6.9 log proved the 700KB
          // PNG path was still lethal: a 482KB screenshot passed
          // through UNCHANGED (under the threshold) and Google
          // killed the session 3 seconds later; the 566KB one died
          // 10s after its function response. Screenshots now go
          // out as ~60-150KB JPEG (4-6x smaller than any PNG we
          // could ship), with PNG as fallback and metadata-only
          // as the last resort — the session survives every time.
          // v1.6.11: the encode pipeline itself is guarded — a decoder
          // hiccup degrades to the metadata-only response instead of
          // killing the whole tool-call batch.
          let wireImage: { data: string; mimeType: string; width?: number; height?: number; bytes?: number } | null = null;
          try {
            wireImage =
              encodeFrameForLiveWire(
                { format: 'png', data: img.data, width: img.width, height: img.height, capturedAt: img.capturedAt },
                { maxDimension: 1024, quality: 60, maxBytes: 160_000 },
              )
              || (() => {
                const pngFallback = shrinkPngBase64(img.data, { maxDimension: 1024, maxBytes: 150_000 });
                return pngFallback
                  ? { data: pngFallback, mimeType: 'image/png' as const, width: img.width || 0, height: img.height || 0, bytes: Math.round(pngFallback.length * 0.75) }
                  : null;
              })();
          } catch (encodeErr) {
            logSession('SCREENSHOT_WIRE_ENCODE_FAILED', { error: sanitizeError(encodeErr) });
            wireImage = null;
          }
          if (wireImage) {
            if (wireImage.mimeType === 'image/jpeg') meta.shrunkForLive = true;
            meta.wireFormat = wireImage.mimeType;
            meta.wireBytes = wireImage.bytes;
            functionResponses.push({
              id: callId,
              name: toolName,
              response: {
                output: [
                  { text: `Screenshot captured. Metadata: ${JSON.stringify(meta)}` },
                  { inlineData: { data: wireImage.data, mimeType: wireImage.mimeType } },
                ],
              },
            });
          } else {
            meta.inlineSkipped = 'image too large for the live wire — pixels available via the vision tools';
            functionResponses.push({
              id: callId,
              name: toolName,
              response: {
                output: [
                  { text: `Screenshot captured (pixels too large to inline safely). Metadata: ${JSON.stringify(meta)}` },
                ],
              },
            });
          }
        } else {
          functionResponses.push({
            id: callId,
            name: toolName,
            response: {
              output: executionResult.success
                ? executionResult.data || { status: 'success' }
                : { error: executionResult.error },
            },
          });
        }

        // Notify client of tool execution result. For screenshot
        // tools, strip the heavy base64 payload before sending
        // over the websocket — the client already has access
        // to the same image via the /api/browser/screenshot HTTP
        // endpoint or the screenshotExecutor's in-memory cache.
        const clientPayload = executionResult.data && typeof executionResult.data === 'object'
          ? (() => {
              const d = executionResult.data as Record<string, unknown>;
              if (typeof d.data === 'string' && d.data.length > 1024) {
                const { data: _stripped, ...rest } = d;
                return { ...rest, dataTruncated: true, dataLength: d.data.length };
              }
              return d;
            })()
          : executionResult.data;
        clientWs.send(
          JSON.stringify({
            type: 'tool_result',
            id: callId,
            name: toolName,
            success: executionResult.success,
            data: clientPayload,
            error: executionResult.error,
            userMessage: executionResult.userMessage,
          })
        );

        // Only dispatch explicit browser popup if the tool is explicitly an open website/browser navigation tool
        const isExplicitBrowserTool = toolName === 'openWebsite' || toolName === 'browserOpen' || toolName === 'browserNavigate';
        const navigationData = executionResult.data && typeof executionResult.data === 'object' && 'url' in executionResult.data
          ? executionResult.data as { url: string; domain?: string; siteName?: string; openedVia?: string }
          : null;
        const isDuplicateNavigation = navigationData ? browserUrlsInBatch.has(navigationData.url) : false;
        // v1.6.9 FIX — TWO-TAB BUG: when openWebsite already handed
        // the URL to the OS default browser (openedVia:
        // 'default-browser'), the page is VISIBLY open. Also
        // sending a browser_action open_url event made the
        // renderer window.open() the SAME url — the user got one
        // YouTube tab per utterance... times two. Only dispatch
        // the client event when the OS open did NOT happen.
        const osAlreadyOpened = navigationData?.openedVia === 'default-browser';

        if (isExplicitBrowserTool && executionResult.success && !isDuplicateNavigation && !osAlreadyOpened && !dispatchedActionIds.has(callId) && navigationData) {
          dispatchedActionIds.add(callId);
          browserUrlsInBatch.add(navigationData.url);
          clientWs.send(
            JSON.stringify({
              type: 'browser_action',
              id: callId,
              action: 'open_url',
              url: navigationData.url,
              domain: navigationData.domain || '',
              siteName: navigationData.siteName || navigationData.domain || 'Website',
            })
          );
        }
        if (executionResult.success && !dispatchedActionIds.has(callId) && toolName === 'setAtmosphericPalette' && executionResult.data && typeof executionResult.data === 'object' && 'palette' in executionResult.data) {
          dispatchedActionIds.add(callId);
          clientWs.send(JSON.stringify({
            type: 'palette_action',
            id: callId,
            palette: executionResult.data.palette,
          }));
        }
      }

      // Send tool responses back to Gemini Live session
      if (functionResponses.length > 0 && session) {
        try {
          session.sendToolResponse({ functionResponses });
        } catch (err) {
          console.error('Error sending tool response to Gemini Live:', err);
        }
      }
    }
  };

  /** One message from the frontend client (audio / text / share controls). */
  const handleClientMessage = async (rawMsg: Buffer | string): Promise<void> => {
    const rawMessageLength = Buffer.isBuffer(rawMsg) ? rawMsg.length : Buffer.byteLength(rawMsg, 'utf8');
    const messageIndex = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      const messageText = rawMsg.toString();
      const payload = JSON.parse(messageText);

      // v1.6.8: audio chunks no longer log a lifecycle block each (~25/s).
      // They feed the AUDIO_FLOW_SUMMARY aggregator instead; verbose mode
      // keeps the old per-chunk detail.
      const isAudioPayload = payload.type === 'audio';
      if (!isAudioPayload || VERBOSE_LOGS) {
        logLifecycleEvent(sessionId, `CLIENT_MESSAGE_${messageIndex}`, {
          startAttemptId,
          messageType: payload.type || 'unknown',
          payloadSizeBytes: rawMessageLength,
          timestamp: new Date().toISOString(),
          sessionState: geminiSessionState,
          payloadMeta: isAudioPayload
            ? {
                type: payload.type,
                audioBytes: typeof payload.data === 'string' ? payload.data.length : Array.isArray(payload.data) ? payload.data.length : 0,
                sampleRate: 16000,
                encoding: 'base64',
                channels: 1,
              }
            : {
                type: payload.type,
                keys: Object.keys(payload || {}),
              },
        });
      }

      if (payload.type === 'speaker_context' && typeof payload.speakerId === 'string' && ['high', 'medium', 'low'].includes(payload.confidence)) {
        currentSpeakerId = payload.known ? payload.speakerId : undefined;
      } else if (payload.type === 'audio' && payload.data && session && isSessionActive) {
        const clientSentAt = typeof payload.clientSentAt === 'number' ? payload.clientSentAt : undefined;
        const audioSampleSize = typeof payload.data === 'string' ? payload.data.length : Array.isArray(payload.data) ? payload.data.length : 0;
        const receivedMark = latencyTrace.mark('client.audio.received');
        noteClientAudioChunk(audioSampleSize);
        if (VERBOSE_LOGS) {
          logSession('GEMINI_CLIENT_AUDIO_RECEIVED', {
            audioSampleSize,
            latencyMark: receivedMark,
            clientToServerMs: clientSentAt === undefined ? undefined : Math.max(0, Date.now() - clientSentAt),
            mimeType: 'audio/pcm;rate=16000',
            sessionActive: isSessionActive,
          });
        }
        try {
          session.sendRealtimeInput({
            audio: {
              data: payload.data,
              mimeType: 'audio/pcm;rate=16000',
            },
          });
          const acceptedMark = latencyTrace.mark('gemini.audio.accepted');
          if (VERBOSE_LOGS) {
            logSession('GEMINI_CLIENT_AUDIO_ACCEPTED', {
              audioSampleSize,
              latencyMark: acceptedMark,
              mimeType: 'audio/pcm;rate=16000',
            });
          }
        } catch (err) {
          logSession('GEMINI_CLIENT_AUDIO_REJECTED', {
            error: sanitizeError(err),
            audioSampleSize,
          });
          throw err;
        }
      } else if (payload.type === 'screen_share_stop') {
        // v1.6.10: the user clicked STOP on the LIVE badge — kill the feed
        // AND the underlying sharing state so the model knows too.
        stopScreenShareFeed('user_stop');
        try { await defaultScreenController.stopSharing(); } catch { /* already off */ }
      } else if (payload.type === 'screen_share_start') {
        // v1.6.10: manual start (future UI toggle / API). Same path the
        // model uses, so state stays in sync.
        startScreenShareFeed('user_start');
      } else if (payload.type === 'screen_frame' && typeof payload.data === 'string') {
        // v1.7.0 BROWSER SCREEN VISION — one-shot frame riding the live
        // socket. It lands BEFORE the question text that follows on this
        // same connection (ordered), so "what is on my screen?" is answered
        // from the moment of asking even with continuous vision OFF.
        const result = screenVisionRegistry.ingestFrame(authorizationId, payload, { oneShot: true });
        if (result === 'dropped-no-channel' && screenVisionHook.isActive()) {
          // Channel record missing (mid-reconnect) — still honor the
          // explicit look-now request: send straight into the session.
          const direct = normalizeFrameData(payload.data);
          if (direct) {
            try {
              session.sendRealtimeInput({ media: { data: direct, mimeType: 'image/jpeg' } });
              logSession('SCREEN_VISION_ONESHOT_DIRECT', { dataChars: direct.length });
            } catch (err) {
              logSession('SCREEN_VISION_ONESHOT_REJECTED', { error: sanitizeError(err) });
            }
          }
        } else {
          logSession('SCREEN_VISION_ONESHOT_FRAME', { result });
        }
      } else if (payload.type === 'text' && payload.text) {
        const textStr = String(payload.text);
        logSession('GEMINI_CLIENT_TEXT_RECEIVED', { textLength: textStr.length });
        // v1.7.0: if the user is screen-sharing, keep the model's view
        // honest at question time (refresh a stale frame / note a paused
        // share) — context-only injection, never triggers speech.
        const visionRefresh = screenVisionRegistry.onTextArrived(authorizationId, textStr);
        if (visionRefresh.reason !== 'not-sharing' && visionRefresh.reason !== 'not-screen-related') {
          logSession('SCREEN_VISION_TEXT_REFRESH', { ...visionRefresh });
        }
        if (sendTextToGemini(textStr)) {
          logSession('GEMINI_CLIENT_TEXT_ACCEPTED', { textLength: textStr.length });
        } else {
          // v1.6.11: the queue is BOUNDED (it used to grow forever when the
          // session died without a socket close — every later message just
          // piled up for a flush that never came).
          if (pendingTextQueue.length >= MAX_PENDING_TEXT_MESSAGES) {
            pendingTextQueue.shift();
            logSession('GEMINI_CLIENT_TEXT_QUEUE_OVERFLOW', { capacity: MAX_PENDING_TEXT_MESSAGES });
          }
          pendingTextQueue.push(textStr);
          logSession('GEMINI_CLIENT_TEXT_QUEUED_WAITING_FOR_SESSION', { textLength: textStr.length, queueDepth: pendingTextQueue.length });
        }
      }
    } catch (err) {
      logSession('CLIENT_MESSAGE_PROCESSING_ERROR', {
        error: sanitizeError(err),
        rawMessageLength,
        messageTextPreview: rawMsg.toString().slice(0, 400),
      });
      console.error('Error processing client message:', err);
    }
  };

  // v1.6.11 FIX: the message listener used to be attached only AFTER
  // ai.live.connect() resolved — text typed during the connect window was
  // silently DROPPED (the pendingTextQueue flush had already run by the
  // time any listener existed). The listener is now registered immediately;
  // messages arriving before the session is ready are queued and flushed
  // once the connect succeeds.
  clientWs.on('message', handleClientMessage);

  // v1.6.11 FIX: the online path had NO socket error listener — a socket
  // error surfaced as an uncaught exception and left the session half-alive.
  // 'close' always fires after 'error', so cleanup happens there.
  clientWs.on('error', (err) => {
    logSession('CLIENT_WEBSOCKET_ERROR', { error: sanitizeError(err) });
  });

  try {
    // Connect to Gemini Live API with model fallback support
    // (v1.6.11: single source of truth for the candidate list — logged in
    // GEMINI_CLIENT_INIT below and iterated after it.)
    const modelsToTry = [
      APP_CONFIG.geminiLiveModel,
      'gemini-2.5-flash-preview',
      'gemini-2.0-flash-001',
    ];

    logSession('GEMINI_CLIENT_INIT', {
      modelCandidates: modelsToTry,
      voice: requestedVoice,
    });

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const functionDeclarations = defaultToolManager.getGeminiFunctionDeclarations();
    const memoryContext = await defaultMemoryManager.context(3);
    const effectiveSystemInstruction = memoryContext
      ? `${SERA_SYSTEM_INSTRUCTION}\n\n[PERSISTENT USER CONTEXT]\n${memoryContext}`
      : SERA_SYSTEM_INSTRUCTION;

    logSession('GEMINI_SETUP_COMPLETED', {
      functionDeclarationsCount: functionDeclarations.length,
      hasMemoryContext: Boolean(memoryContext),
      systemInstructionLength: effectiveSystemInstruction.length,
      modelName: APP_CONFIG.geminiLiveModel,
      voiceName: requestedVoice,
      responseModalities: [Modality.AUDIO],
      hasSystemInstruction: Boolean(effectiveSystemInstruction),
      toolsConfig: functionDeclarations.length > 0 ? { functionDeclarationsCount: functionDeclarations.length } : 'none',
      sessionResumption: resumeHandle ? `resume:${resumeHandle.slice(0, 12)}…` : 'fresh',
      liveConnectConfig: {
        responseModalities: [Modality.AUDIO],
        outputAudioTranscription: {},
        inputAudioTranscription: {},
      },
    });

    // Connect to Gemini Live API with model fallback support
    // (see modelsToTry above)

    let connectedModel = APP_CONFIG.geminiLiveModel;
    let connectError: any = null;

    for (const modelCandidate of modelsToTry) {
      try {
        session = await ai.live.connect({
          model: modelCandidate,
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: requestedVoice,
                },
              },
            },
            systemInstruction: effectiveSystemInstruction,
            tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
            outputAudioTranscription: {},
            inputAudioTranscription: {},
            // Session resumption: the server periodically sends
            // sessionResumptionUpdate messages; we forward the latest
            // resumable handle to the client. On reconnect the client
            // passes it back as ?resumeHandle= and the conversation
            // continues exactly where Google's session limit cut it.
            sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
            // Keep long sessions healthy: the context window compresses
            // instead of growing until Google kills the socket.
            contextWindowCompression: { slidingWindow: {} },
          },
          callbacks: {
            // v1.6.11 FIX: the SDK does not serialize onmessage invocations —
            // two toolCall batches arriving back-to-back interleaved their
            // awaited tool executions (racing keyboard/clipboard writes).
            // Every message now flows through a per-session promise chain,
            // the same serialization the local mode uses (turnChain).
            onmessage: (message: LiveServerMessage) => {
              geminiMessageChain = geminiMessageChain
                .then(() => handleGeminiMessage(message))
                .catch((chainErr) => {
                  console.error(`[SERVER] ${sessionId} Gemini message chain error:`, chainErr);
                });
            },
            onclose: (...args: any[]) => {
              geminiSessionState = 'CLOSED';
              isSessionActive = false;
              const diagnostics = {
                sessionId,
                startAttemptId,
                source: 'GeminiLive.onclose',
                closeArgs: summarizeGeminiCloseArgs(args),
                closeInitiator: 'GEMINI_LIVE_SESSION',
                clientWebSocketReadyState: describeWebSocketState(clientWs),
                geminiSessionState,
                stack: new Error('Gemini session close stack').stack,
                timestamp: new Date().toISOString(),
              };
              logSession('GEMINI_LIVE_SESSION_CLOSED', diagnostics);

              // v1.6.10: Google closed the Gemini side — stop the live
              // screen-share feed BEFORE the client socket goes away so the
              // OFF state reaches the UI while the socket can still send.
              stopScreenShareFeed('gemini_session_closed');

              if (clientWs.readyState === WebSocket.OPEN) {
                // Send session_closed then close the client WS. Previously
                // only the notification was sent — the client WS stayed open
                // and kept streaming raw PCM audio that was silently dropped
                // (since isSessionActive=false). Closing the WS forces both
                // sides to clean up audio resources and lets the client
                // surface a "reconnect?" affordance to the user.
                clientWs.send(
                  JSON.stringify({
                    type: 'session_closed',
                    source: 'gemini_onclose',
                    sessionId,
                  }),
                  (sendErr) => {
                    if (sendErr) {
                      console.warn(`[SERVER] ${sessionId} Failed to deliver session_closed:`, sendErr);
                    }
                    try { clientWs.close(1000, 'Gemini session closed'); } catch {}
                  }
                );
              }
            },
            onerror: (err: any) => {
              geminiSessionState = 'ERROR';
              // v1.6.11 FIX: the session is dead — deactivate it, kill the
              // screen-share feed, and CLOSE the client socket so the
              // frontend reconnects. Previously isSessionActive stayed true
              // and the client kept streaming audio into a dead session
              // (every sendRealtimeInput threw, nothing ever recovered).
              isSessionActive = false;
              const diagnostics = {
                sessionId,
                startAttemptId,
                source: 'GeminiLive.onerror',
                error: sanitizeError(err),
                clientWebSocketReadyState: describeWebSocketState(clientWs),
                geminiSessionState,
                stack: new Error('Gemini error stack').stack,
                timestamp: new Date().toISOString(),
              };
              console.error(`[SERVER] ${sessionId} ❌ GEMINI_LIVE_SESSION_ERROR:`);
              console.error(JSON.stringify(diagnostics, null, 2));

              stopScreenShareFeed('gemini_session_error');

              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(
                  JSON.stringify({
                    type: 'error',
                    source: 'gemini_onerror',
                    error: err?.message || 'Error occurred in Gemini Live connection',
                  })
                );
                try { clientWs.close(1011, 'Gemini session error'); } catch { /* already closing */ }
              }
            },
          },
        });

        connectedModel = modelCandidate;
        connectError = null;
        const sessionExists = Boolean(session);
        const sessionMeta = session
          ? {
              type: typeof session,
              hasClose: typeof session.close === 'function',
              hasSendRealtimeInput: typeof session.sendRealtimeInput === 'function',
              hasSendClientContent: typeof session.sendClientContent === 'function',
              hasSendToolResponse: typeof session.sendToolResponse === 'function',
              keys: Object.keys(session || {}).slice(0, 40),
            }
          : { type: 'null', hasClose: false, hasSendRealtimeInput: false, hasSendClientContent: false, hasSendToolResponse: false, keys: [] };
        logSession('GEMINI_SESSION_CREATED', {
          modelCandidate,
          sessionObjectExists: sessionExists,
          sessionMeta,
          timestamp: new Date().toISOString(),
        });
        break;
      } catch (err: any) {
        console.warn(`Could not connect using model candidate "${modelCandidate}":`, err?.message || err);
        connectError = err;
      }
    }

    if (!session || connectError) {
      throw connectError || new Error('All Gemini Live models failed to connect');
    }

    geminiSessionState = 'CONNECTED';
    isSessionActive = true;
    logSession('GEMINI_SESSION_CONNECTED', {
      model: connectedModel,
      voice: requestedVoice,
      readyToReceiveAudio: true,
    });

    // v1.7.0: this Gemini session is now the screen-vision destination
    // for this browser. Register FIRST, then inject the current screen
    // (if the user is mid-share) BEFORE any queued question flushes —
    // so the very first "what is on my screen?" is answered from the
    // CURRENT view, never a stale one.
    screenVisionRegistry.registerSession(authorizationId, screenVisionHook);
    const screenVisionReady = screenVisionRegistry.onSessionReady(authorizationId);
    if (screenVisionReady.reason !== 'not-sharing') {
      logSession('SCREEN_VISION_SESSION_READY', { ...screenVisionReady });
    }

    // v1.6.11: flush text that arrived while the session was still
    // connecting — the listener now queues instead of dropping, so every
    // message typed during the connect window survives.
    while (pendingTextQueue.length > 0) {
      const pendingText = pendingTextQueue.shift();
      if (pendingText && sendTextToGemini(pendingText)) {
        logSession('GEMINI_CLIENT_TEXT_ACCEPTED_FROM_QUEUE', { textLength: pendingText.length });
      }
    }

    clientWs.send(
      JSON.stringify({
        type: 'ready',
        voice: requestedVoice,
        model: connectedModel,
      })
    );
  } catch (err) {
    geminiSessionState = 'ERROR';
    const errorMsg = err instanceof Error ? err.message : String(err);
    logSession('GEMINI_SESSION_CONNECT_FAILED', {
      source: 'ai.live.connect',
      error: sanitizeError(err),
      sessionState: geminiSessionState,
    });
    console.error('[SERVER] Failed to establish Gemini Live session:', JSON.stringify(sanitizeError(err), null, 2));

    // Actionable, honest failure guidance — classified by failure mode so
    // the user sees WHY SERA cannot reply and HOW to fix it, instead of a
    // bare "could not connect".
    let guidance = '';
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network|socket|timeout/i.test(errorMsg)) {
      guidance = ' Network guidance: this machine could not reach generativelanguage.googleapis.com. If your network hijacks DNS (see the DNS diagnostic), enable DNS-over-HTTPS in Windows for your 1.1.1.1/8.8.8.8 entries (adapter settings → Edit DNS → "Encrypted DNS (DNS over HTTPS)" ON → then run "ipconfig /flushdns"), or run your VPN/proxy in TUN mode, or set HTTPS_PROXY=http://127.0.0.1:PORT in .env (SERA routes fetch calls through it automatically) and restart.';
    } else if (/API key not valid|API_KEY_INVALID|401|403|permission/i.test(errorMsg)) {
      guidance = ' Key guidance: your Gemini key was rejected. Open Settings → API KEYS, re-paste a valid key from https://aistudio.google.com/apikey and hit Test.';
    } else if (/429|quota|RESOURCE_EXHAUSTED/i.test(errorMsg)) {
      guidance = ' Quota guidance: Gemini free-tier quota is exhausted for now — wait a minute or switch to Local Mode (Ollama).';
    }

    clientWs.send(
      JSON.stringify({
        type: 'error',
        error: `Could not connect to Gemini Live API: ${errorMsg}.${guidance}`,
      })
    );
    clientWs.close(1011, 'Session Init Failed');
    return;
  } finally {
    logSession('GEMINI_SESSION_STATE_FINAL', {
      finalState: geminiSessionState,
      isSessionActive,
      clientWebSocketState: describeWebSocketState(clientWs),
    });
  }

  clientWs.on('close', (code: number, reason: Buffer | string | undefined) => {
    flushAudioSummary('client_socket_closed');
    const reasonText = Buffer.isBuffer(reason) ? reason.toString('utf8') : (reason ? String(reason) : '(no reason provided)');
    const diagnostics = {
      sessionId,
      startAttemptId,
      source: 'clientWebSocket.onclose',
      closeInitiator: 'CLIENT_WEBSOCKET',
      closeCode: code,
      closeReason: reasonText,
      clientWebSocketState: describeWebSocketState(clientWs),
      geminiSessionState,
      wasSessionActive: isSessionActive,
      stack: new Error('Client socket close stack').stack,
      timestamp: new Date().toISOString(),
    };
    logSession('CLIENT_WEBSOCKET_CLOSED', diagnostics);
    
    isSessionActive = false;
    // v1.7.0: this session is no longer a screen-vision destination.
    screenVisionRegistry.unregisterSession(authorizationId, screenVisionHook);
    // v1.6.10: the live frame feed must ALWAYS die with the session —
    // no orphaned capture timers across reconnects.
    stopScreenShareFeed('client_socket_closed');
    // v1.6.11 FIX: stopping the FEED was not enough — the underlying screen
    // controller kept its own 100ms capture timer running (started by the
    // feed's ensureSharing() or a controlScreen.startSharing tool call), so
    // the screen kept being captured at ~10fps after the client vanished.
    // The queued text is also dropped — a flush can never run now.
    pendingTextQueue.length = 0;
    try { void defaultScreenController.stopSharing(); } catch { /* already off */ }
    if (session) {
      geminiSessionState = 'CLOSING';
      try {
        logSession('CLOSING_GEMINI_SESSION_DUE_TO_CLIENT_CLOSE', {
          closeCode: code,
          closeReason: reasonText,
        });
        session.close();
      } catch (err) {
        logSession('GEMINI_CLOSE_ON_CLIENT_DISCONNECT_FAILED', {
          error: sanitizeError(err),
        });
      }
    }
  });
}

// v1.6.11: unknown /api routes return a JSON 404 instead of falling through
// to the SPA catch-all (which used to answer unknown API calls with the HTML
// shell and a 200 — impossible to debug from a client).
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Unknown API route.' });
});

// Setup Vite middleware or static serving
async function setupApp() {
  // Production detection (v1.9.0): the old heuristic (bundle filename under
  // dist/) plus the explicit SERA_PACKAGED flag set by the Electron shell.
  // When SERA is started via "node dist/server.cjs" (double-click launcher,
  // npm start, Electron desktop shell) NODE_ENV is often unset — but we must
  // still serve the static production build instead of booting Vite dev
  // middleware, which would serve unbuilt sources and require dev deps.
  const runningFromBundle =
    typeof __filename === 'string' && __filename.split(path.sep).includes('dist');
  const isProductionServer = process.env.NODE_ENV === 'production' || runningFromBundle || isSeraPackaged();
  if (!isProductionServer) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        watch: {
          ignored: [
            '**/sera_memories*.json',
            '**/*.bak.*',
            '**/*.bak',
            '**/backups/**',
            '**/tmp/**',
            '**/.scratch/**',
            '**/*.tmp',
            '**/*.log',
          ],
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // v1.9.0 (BUG L5): the static root is resolved through SERAPaths —
    // cwd-based serving breaks the moment the CWD isn't the install dir
    // (packaged Electron, Start-Menu launch, service wrapper).
    const distPath = frontendDistDir();
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const listenResult = await listenWithFallback(server, { port: PORT, bindHost: BIND_HOST });
  if (listenResult.fellBack) {
    console.warn(`[PORT] Port ${PORT} is busy (${listenResult.fallbackReason}) — fell back to an ephemeral port.`);
  }
  // v1.9.0: every boot writes a structured line to %LOCALAPPDATA%\SERA\logs —
  // packaged installs have no console, and "it just died" needs a paper trail.
  rotateLogs();
  bootLogger.info('backend boot', {
    version: readAppVersion(),
    requestedPort: PORT,
    actualPort: listenResult.port,
    portFallback: listenResult.fellBack,
    bindHost: BIND_HOST,
    packaged: isSeraPackaged(),
    node: process.version,
    platform: process.platform,
  });

  // ── PORT HANDSHAKE (v1.9.0) ───────────────────────────────────
  // Two channels, both written AFTER the real port is known:
  //  1. stdout marker  SERA_LISTENING_PORT=<port>  — the Electron shell
  //     parses this from the child's stdout (works for dev AND package);
  //  2. <SERA home>/sera.port — survives stdout buffering quirks; the shell
  //     falls back to reading it. Removed again on clean shutdown.
  const actualPort: number = listenResult.port;
  guardOptions.port = actualPort;
  if (actualPort !== PORT) {
    console.warn(`[PORT] SERA is now on http://${BIND_HOST}:${actualPort} (default ${PORT} was busy).`);
  }
  console.log(`SERA_LISTENING_PORT=${actualPort}`);
  try {
    const { ensureSeraHome, seraHomeDir } = await import('./src/local/EngineHome');
    ensureSeraHome();
    fs.writeFileSync(path.join(seraHomeDir(), 'sera.port'), String(actualPort), 'utf8');
    shutdownCoordinator.addStep({
      name: 'remove-port-handshake',
      run: () => {
        try { fs.rmSync(path.join(seraHomeDir(), 'sera.port'), { force: true }); } catch { /* best-effort */ }
      },
    });
  } catch { /* handshake is advisory — never block boot */ }

  // Start continuous passive health monitoring daemon
  defaultSystemHealthMonitor.start();

  console.log(`SERA Voice AI Server running on http://${BIND_HOST}:${actualPort}`);
  console.log('[DIAGNOSTICS] Proactive passive system health monitor active');

  // ── v1.9.0 AUTO-SETUP (rewritten for packaged installs) ────────────
  // FIELD PAIN: after every SERA update the user had to re-run
  //   npm run setup:ocr
  // because optional engines lived in the app folder (wiped by updates).
  // The server still self-heals OCR data in the background — now into the
  // per-user LOCALAPPDATA OCR cache, with a spawn that works in packages.
  //
  // v1.9.0 changes (audit BUG L6/L8/L9):
  //  - eng.traineddata lives in SERAPaths.ocrDataDir() (writable, per-user,
  //    survives updates) instead of the CWD (read-only under Program Files,
  //    and tesseract.js's CWD cache broke the packaged app).
  //  - the setup script is spawned with ELECTRON_RUN_AS_NODE when the
  //    backend itself runs under Electron — process.execPath inside a
  //    package is SERA.exe, and spawning it with a .mjs argument would
  //    RELAUNCH the app instead of running node.
  //  - the pip-based Piper auto-setup is GONE (BUG L8): it assumed Python
  //    on the user machine and failed on every Python-less install. Piper
  //    is a documented drop-in in %USERPROFILE%\.sera\engines; SERA falls
  //    back to system/browser voices (LocalSpeechEngines already degrades
  //    gracefully) and the MY PC tab explains the optional install.
  void (async () => {
    const { isFileReadable } = await import('./src/local/EngineHome');
    const { execFile } = await import('node:child_process');
    const { resourcesRoot } = await import('./src/local/SERAPaths');

    // 1) Tesseract OCR English data → per-user OCR cache.
    // v1.6.11: the statSync race (file vanishing between the readability
    // probe and the size probe) is now contained instead of relying on the
    // blanket outer catch to swallow a crash.
    const trainedData = path.join(ocrDataDir(), 'eng.traineddata');
    const ocrDataTooSmall = (): boolean => {
      try { return fs.statSync(trainedData).size < 1_000_000; } catch { return true; }
    };
    const setupScript = path.join(resourcesRoot(), 'scripts', 'setup-ocr.mjs');
    const needOcr = !isFileReadable(trainedData) || ocrDataTooSmall();
    if (needOcr && fs.existsSync(setupScript)) {
      console.log(`[AUTO-SETUP] eng.traineddata missing — downloading in the background to ${trainedData} (one-time, survives updates)…`);
      execFile(
        process.execPath,
        [setupScript],
        {
          windowsHide: true,
          timeout: 180_000,
          env: { ...process.env, SERA_OCR_DIR: ocrDataDir() },
        },
        (err, stdout) => {
          if (err) console.warn('[AUTO-SETUP] OCR data download failed (OCR falls back to slower paths):', err.message);
          else console.log(`[AUTO-SETUP] OCR data ready. ${String(stdout).trim().split('\n').pop() ?? ''}`);
        },
      );
    }
  })().catch(() => { /* never break startup over optional engines */ });


  // ── Outbound connectivity watchdog (restricted / DNS-hijacking nets) ──
  // Routes fetch() through HTTPS_PROXY when the user sets one, then audits
  // how the OS resolver resolves the Gemini host. On hijacked networks this
  // logs the exact Windows DNS-over-HTTPS fix INSTEAD of failing silently
  // later ("SERA never replies").
  await installProxySupport();
  void auditHostResolution('generativelanguage.googleapis.com')
    .then((report) => logHostResolutionAudit(report))
    .catch(() => { /* never block boot on the audit */ });
}

// Install process-level error handlers BEFORE setupApp() so that any uncaught
// exception or unhandled rejection during boot (or later, during tool
// execution) is logged instead of silently crashing the server. The
// `uncaught_handler_installed` diagnostic check (comprehensiveChecks.ts) reads
// process.listenerCount('uncaughtException') and listenerCount('unhandledRejection')
// and reports CRITICAL when either is 0 — without these handlers, the smallest
// stray rejection from a tool would kill the server with no log trail.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  bootLogger.error(`uncaught exception: ${err.stack || err.message}`);
  // Intentionally do NOT exit — keep the server alive so the user can
  // see the error in the diagnostic panel. Genuine unrecoverable
  // states (port already in use, missing .env) fail fast in setupApp()
  // before reaching here.
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
  bootLogger.error(`unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
  // Same reasoning: log and continue. The Live WebSocket loop has its
  // own try/catch around the model invocation; this is the safety net
  // for everything else (tool registry, memory store, etc.).
});

// ── GRACEFUL SHUTDOWN (v1.6.11) ────────────────────────────────────
// Previously there was NO SIGINT/SIGTERM handling: Ctrl+C killed the process
// mid-flight, leaving the 100ms screen-capture timer, the Playwright managed
// browser, the health monitor, and every WebSocket client without a close
// frame. Steps run LIFO (sockets first, timers/children last), each guarded
// and time-boxed so one slow cleanup can never block exit.
const shutdownCoordinator = createShutdownCoordinator();
// v1.9.0: fatal-error mirrors into the rotating log file (packaged installs
// have no console — crashes used to leave zero evidence).
installFatalLogMirrors();
shutdownCoordinator.addStep({ name: 'stop-health-monitor', run: () => { defaultSystemHealthMonitor.stop(); } });
shutdownCoordinator.addStep({ name: 'stop-screen-share', run: async () => { try { await defaultScreenController.stopSharing(); } catch { /* already off */ } } });
shutdownCoordinator.addStep({ name: 'close-browser-session', run: async () => { try { await defaultBrowserSessionManager.closeSession(browserSessionId); } catch { /* no session */ } } });
shutdownCoordinator.addStep({ name: 'close-screen-vision', run: () => new Promise<void>((resolve) => { try { screenVisionRegistry.finalizeDropsNow(); screenVisionWss.close(() => resolve()); } catch { resolve(); } }) });
// v1.8.0 — terminate the Tesseract worker so the process never hangs on
// exit (a live OCR worker keeps the event loop alive).
shutdownCoordinator.addStep({ name: 'close-screen-ocr', run: async () => { try { await screenOcrEngine.close(); } catch { /* already closed */ } } });
shutdownCoordinator.addStep({ name: 'close-websocket-server', run: () => new Promise<void>((resolve) => { try { wss.close(() => resolve()); } catch { resolve(); } }) });
shutdownCoordinator.addStep({
  name: 'close-websocket-clients',
  run: () => {
    for (const ws of connectedClients) {
      try { ws.close(1001, 'Server shutting down'); } catch { /* already closing */ }
    }
  },
});
shutdownCoordinator.addStep({ name: 'close-http-server', run: () => new Promise<void>((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } }) });
shutdownCoordinator.addStep({ name: 'stop-owned-ollama', run: () => { try { defaultOllamaManager.stopOwned(); } catch { /* already stopped */ } } });
installShutdownHandlers(shutdownCoordinator);

setupApp().catch((err) => {
  console.error('Failed to start SERA server:', err);
  process.exit(1);
});



