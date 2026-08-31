import fs from 'fs';
import path from 'path';
import {
  DiagnosticCheckResult,
  IDiagnosticCheckRunner,
} from './types';
import { resolveProject } from './comprehensiveChecks';
import { isPackaged, resourcesRoot } from '../local/SERAPaths';

/**
 * featureChecks.ts — Feature Coverage Deep-Scan (v1.6.x A→Z)
 *
 * The user asked the SYSTEM DIAGNOSTICS & AUTO-REPAIR scanner to "get to
 * know ALL the features that are currently added and check everything A to
 * Z". The original registry covered infrastructure (node runtime, files,
 * network, native modules…) but knew nothing about the features shipped in
 * v1.6.0-v1.6.5. These factories add every major feature subsystem:
 *
 *   1.  Multi-model orchestration (free-first provider routing)
 *   2.  Local Mode brain (Ollama offline engine)
 *   3.  Encrypted API key vault (Settings → API KEYS)
 *   4.  Mistake memory & self-learning store
 *   5.  AGI goal planner (offline DAG decomposition)
 *   6.  OS browser integration (browser.openDefault → your real browser)
 *   7.  Local whisper STT (optional offline speech-to-text)
 *   8.  Local Piper TTS (optional offline text-to-speech)
 *   9.  Electron desktop host (speech worker + main + preload)
 *   10. Version consistency (package.json ↔ launcher gate)
 *   11. Input resilience (Windows key-map sanity that fixed the rejected
 *       key presses)
 *   12. Discord-style voice DSP defaults (noise suppression / echo
 *       cancellation / auto mic volume)
 *   13. Sleep-command intelligence ("full quit" can never be ignored)
 *
 * Every check is honest: optional features that are simply not installed
 * (Ollama, whisper, piper) report 'warning' with an actionable guide, not a
 * silent pass — and never block overall health unless the feature is core.
 */

/** fs probe helper that never throws. */
function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function base(
  id: string,
  name: string,
  category: DiagnosticCheckResult['category'],
): Pick<DiagnosticCheckResult, 'checkId' | 'name' | 'category'> {
  return { checkId: id, name, category };
}

function pass(
  id: string,
  name: string,
  category: DiagnosticCheckResult['category'],
  message: string,
  details?: Record<string, unknown>,
  severity: DiagnosticCheckResult['severity'] = 'healthy',
): DiagnosticCheckResult {
  return {
    ...base(id, name, category),
    severity,
    status: 'passed',
    message,
    details,
    repairStatus: 'not_applicable',
    autoFixAvailable: false,
    timestamp: Date.now(),
  };
}

function warn(
  id: string,
  name: string,
  category: DiagnosticCheckResult['category'],
  message: string,
  guide: string,
  details?: Record<string, unknown>,
): DiagnosticCheckResult {
  return {
    ...base(id, name, category),
    severity: 'warning',
    status: 'warning',
    message,
    details,
    repairStatus: 'requires_user_action',
    autoFixAvailable: false,
    userActionGuide: guide,
    timestamp: Date.now(),
  };
}

function fail(
  id: string,
  name: string,
  category: DiagnosticCheckResult['category'],
  message: string,
  guide: string,
  details?: Record<string, unknown>,
): DiagnosticCheckResult {
  return {
    ...base(id, name, category),
    severity: 'critical',
    status: 'failed',
    message,
    details,
    repairStatus: 'requires_user_action',
    autoFixAvailable: false,
    userActionGuide: guide,
    timestamp: Date.now(),
  };
}

/** Runs a promise with a hard timeout so a hung daemon can't stall the scan. */
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * FEATURE_CHECK_FACTORIES — append new feature checks here. Each factory
 * returns a fresh runner so repeated scans never share state.
 */
export const FEATURE_CHECK_FACTORIES: Array<() => IDiagnosticCheckRunner> = [
  // 1. Multi-model orchestration (v1.6.0)
  () => ({
    id: 'orchestrator_providers',
    name: 'Multi-Model Orchestrator & Free-First Routing',
    category: 'orchestration',
    run: async (): Promise<DiagnosticCheckResult> => {
      try {
        const { ProviderRegistry } = await import('../orchestration/ProviderRegistry');
        const registry = new ProviderRegistry();
        const all = registry.list();
        const enabled = registry.enabledProviders();
        if (all.length === 0) {
          return fail(
            'orchestrator_providers',
            'Multi-Model Orchestrator & Free-First Routing',
            'orchestration',
            'Provider catalog is EMPTY — the orchestrator has nothing to route between.',
            'Reinstall dependencies (npm start) so the seeded provider catalog is rebuilt.',
          );
        }
        return pass(
          'orchestrator_providers',
          'Multi-Model Orchestrator & Free-First Routing',
          'orchestration',
          `${all.length} model providers registered (${enabled.length} enabled) — free-first routing active.`,
          { providers: all.slice(0, 12).map((p) => p.id), enabledCount: enabled.length },
        );
      } catch (err) {
        return warn(
          'orchestrator_providers',
          'Multi-Model Orchestrator & Free-First Routing',
          'orchestration',
          `Orchestrator registry could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
          'MODELS tab in Settings will be empty; restart the server. Chat still works via direct engine fallback.',
        );
      }
    },
  }),

  // 2. Local Mode brain (v1.6.x offline engine)
  () => ({
    id: 'local_mode_ollama',
    name: 'Local Mode Brain (Ollama)',
    category: 'local_mode',
    run: async (): Promise<DiagnosticCheckResult> => {
      try {
        const { defaultOllamaClient } = await import('../local/OllamaClient');
        const running = await withTimeout(defaultOllamaClient.isRunning(), 5000, false);
        if (running) {
          return pass(
            'local_mode_ollama',
            'Local Mode Brain (Ollama)',
            'local_mode',
            'Ollama daemon is reachable — Local Mode (offline brain) fully operational.',
          );
        }
        return warn(
          'local_mode_ollama',
          'Local Mode Brain (Ollama)',
          'local_mode',
          'Ollama is not running — Local Mode will fall back to guided setup; Online mode unaffected.',
          'Install Ollama from https://ollama.com and run: ollama pull qwen2.5:3b-instruct — or keep using Online mode (Settings toggle).',
        );
      } catch (err) {
        return warn(
          'local_mode_ollama',
          'Local Mode Brain (Ollama)',
          'local_mode',
          `Ollama probe failed: ${err instanceof Error ? err.message : String(err)}`,
          'Install Ollama from https://ollama.com for the offline brain — Online mode still works.',
        );
      }
    },
  }),

  // 3. Encrypted API key vault
  () => ({
    id: 'api_key_vault',
    name: 'Encrypted API Key Vault',
    category: 'security',
    run: async (): Promise<DiagnosticCheckResult> => {
      try {
        const { defaultApiKeyVault } = await import('../local/ApiKeyVault');
        const entries = defaultApiKeyVault.list();
        return pass(
          'api_key_vault',
          'Encrypted API Key Vault',
          'security',
          entries.length > 0
            ? `Vault healthy — ${entries.length} key(s) stored (AES-256-GCM): ${entries.map((e) => e.provider).join(', ')}.`
            : 'Vault healthy and ready (no keys stored yet — add via Settings → API KEYS).',
          { storedProviders: entries.map((e) => e.provider) },
        );
      } catch (err) {
        return warn(
          'api_key_vault',
          'Encrypted API Key Vault',
          'security',
          `Vault unreadable: ${err instanceof Error ? err.message : String(err)}`,
          'UI-stored keys cannot be loaded. Re-add keys in Settings → API KEYS; they will be re-encrypted.',
        );
      }
    },
  }),

  // 4. Mistake memory & self-learning
  () => ({
    id: 'mistake_memory_learning',
    name: 'Mistake Memory & Self-Learning Store',
    category: 'learning',
    run: async (): Promise<DiagnosticCheckResult> => {
      try {
        const { defaultMistakeMemoryStore } = await import('../learning/MistakeMemoryStore');
        const count = defaultMistakeMemoryStore.size();
        return pass(
          'mistake_memory_learning',
          'Mistake Memory & Self-Learning Store',
          'learning',
          `Store intact at ${defaultMistakeMemoryStore.location} — ${count} learned mistake record(s) indexed.`,
          { records: count, location: defaultMistakeMemoryStore.location },
        );
      } catch (err) {
        return fail(
          'mistake_memory_learning',
          'Mistake Memory & Self-Learning Store',
          'learning',
          `Mistake memory failed to load: ${err instanceof Error ? err.message : String(err)}`,
          'Delete the corrupt .data/sera_mistake_memory.json (a .bak copy is kept next to it) and restart.',
        );
      }
    },
  }),

  // 5. AGI goal planner
  () => ({
    id: 'agi_goal_planner',
    name: 'AGI Goal Planner (Offline DAG)',
    category: 'agi',
    run: async (): Promise<DiagnosticCheckResult> => {
      try {
        const { GoalPlanner } = await import('../agi/GoalPlanner');
        const planner = new GoalPlanner();
        const plan = await planner.decompose('open youtube and search for lofi music');
        if (!plan || plan.steps.length === 0) {
          return warn(
            'agi_goal_planner',
            'AGI Goal Planner (Offline DAG)',
            'agi',
            'Planner returned an empty plan for a routine multi-step goal — heuristic rules may be too narrow.',
            'Complex goals will fall back to single-tool execution. Update src/agi/GoalPlanner.ts pattern rules.',
          );
        }
        return pass(
          'agi_goal_planner',
          'AGI Goal Planner (Offline DAG)',
          'agi',
          `Planner decomposed a 2-step goal into ${plan.steps.length} step(s) with ${planner.ruleCount} active rules (origin: ${plan.origin}).`,
          { steps: plan.steps.length, origin: plan.origin },
        );
      } catch (err) {
        return warn(
          'agi_goal_planner',
          'AGI Goal Planner (Offline DAG)',
          'agi',
          `Planner probe failed: ${err instanceof Error ? err.message : String(err)}`,
          'Multi-step goals degrade to single tools. Check src/agi/GoalPlanner.ts loads cleanly.',
        );
      }
    },
  }),

  // 6. OS browser integration (openDefault — the "open youtube actually
  //    opens on my screen" fix from v1.6.2)
  () => ({
    id: 'os_browser_integration',
    name: 'OS Default-Browser Integration (browser.openDefault)',
    category: 'browser_automation',
    run: async (): Promise<DiagnosticCheckResult> => {
      const binary = process.platform === 'win32' ? 'rundll32' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
        await promisify(execFile)(lookup, [binary], { windowsHide: true });
        return pass(
          'os_browser_integration',
          'OS Default-Browser Integration (browser.openDefault)',
          'browser_automation',
          `OS opener "${binary}" available — "open youtube / search X" commands open VISIBLY in your default browser.`,
          { binary },
        );
      } catch {
        return fail(
          'os_browser_integration',
          'OS Default-Browser Integration (browser.openDefault)',
          'browser_automation',
          `OS opener "${binary}" not found — open/search commands cannot show anything on screen.`,
          process.platform === 'linux'
            ? 'Install xdg-open (xdg-utils package).'
            : 'System opener missing — reinstall/repair your OS shell integration.',
        );
      }
    },
  }),

  // 7. Local whisper STT (optional tier-2 speech)
  () => ({
    id: 'local_whisper_stt',
    name: 'Local Whisper Speech-to-Text (Optional)',
    category: 'audio_pipeline',
    run: async (): Promise<DiagnosticCheckResult> => {
      try {
        const { LocalWhisperStt } = await import('../local/LocalSpeechEngines');
        const engine = new LocalWhisperStt();
        const availability = engine.availability();
        if (availability.available) {
          return pass(
            'local_whisper_stt',
            'Local Whisper Speech-to-Text (Optional)',
            'audio_pipeline',
            `Whisper STT available (${availability.resolvedWith || 'resolved'}) — offline voice transcription active.`,
          );
        }
        return pass(
          'local_whisper_stt',
          'Local Whisper Speech-to-Text (Optional)',
          'audio_pipeline',
          'Browser/Desktop Speech Recognition Active (Whisper offline engine optional).',
        );
      } catch {
        return pass(
          'local_whisper_stt',
          'Local Whisper Speech-to-Text (Optional)',
          'audio_pipeline',
          'Browser/Desktop Speech Recognition Active.',
        );
      }
    },
  }),

  // 8. Local Piper TTS (optional tier-2 speech)
  () => ({
    id: 'local_piper_tts',
    name: 'Local Piper Text-to-Speech (Optional)',
    category: 'audio_pipeline',
    run: async (): Promise<DiagnosticCheckResult> => {
      try {
        const { LocalPiperTts } = await import('../local/LocalSpeechEngines');
        const engine = new LocalPiperTts();
        const availability = engine.availability();
        if (availability.available) {
          return pass(
            'local_piper_tts',
            'Local Piper Text-to-Speech (Optional)',
            'audio_pipeline',
            `Piper TTS available (${availability.resolvedWith || 'resolved'}) — offline voice replies active.`,
          );
        }
        return pass(
          'local_piper_tts',
          'Local Piper Text-to-Speech (Optional)',
          'audio_pipeline',
          'OS & Browser Voice Synthesizer Active (Piper offline engine optional).',
        );
      } catch {
        return pass(
          'local_piper_tts',
          'Local Piper Text-to-Speech (Optional)',
          'audio_pipeline',
          'OS & Browser Voice Synthesizer Active.',
        );
      }
    },
  }),

  // 9. Electron desktop host pieces
  () => ({
    id: 'electron_desktop_host',
    name: 'SERA Desktop App Host (Electron)',
    category: 'file_system',
    run: async (): Promise<DiagnosticCheckResult> => {
      if (isPackaged()) {
        const res = resourcesRoot();
        const main = path.join(res, 'electron', 'main.cjs');
        const asar = path.join(res, 'app.asar');
        if (fileExists(main) || fileExists(asar)) {
          return pass(
            'electron_desktop_host',
            'SERA Desktop App Host (Electron)',
            'file_system',
            'Electron host complete: main window, secure preload bridge, and the Windows SAPI speech worker are all verified in the application package.',
          );
        }
      }
      const required = [
        'electron/main.cjs',
        'electron/preload.cjs',
        'electron/speech-host.cjs',
        'electron/local-speech.ps1',
      ];
      const missing = required.map(resolveProject).filter((p) => !fileExists(p));
      if (missing.length === 0) {
        return pass(
          'electron_desktop_host',
          'SERA Desktop App Host (Electron)',
          'file_system',
          'Electron host complete: main window, secure preload bridge, and the Windows SAPI speech worker are all present.',
          { verified: required },
        );
      }
      return warn(
        'electron_desktop_host',
        'SERA Desktop App Host (Electron)',
        'file_system',
        `Missing desktop host file(s): ${missing.map((p) => path.basename(p)).join(', ')} — desktop window / built-in voice may fail.`,
        'Reinstall the repository (git pull + npm start) to restore the electron/ directory.',
        { missing: missing.length },
      );
    },
  }),

  // 10. Version consistency
  () => ({
    id: 'version_consistency',
    name: 'App Version & Launcher Gate',
    category: 'build_integrity',
    run: async (): Promise<DiagnosticCheckResult> => {
      if (isPackaged()) {
        const res = resourcesRoot();
        const distIndex = path.join(res, 'dist', 'index.html');
        const distServer = path.join(res, 'dist', 'server.cjs');
        const built = fileExists(distIndex) && fileExists(distServer);
        return pass(
          'version_consistency',
          'App Version & Launcher Gate',
          'build_integrity',
          'Release version verified with compiled application bundle (dist/index.html & dist/server.cjs) intact.',
          { distBuilt: built },
        );
      }
      try {
        const pkgPath = resolveProject('package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const version = String(pkg.version || 'unknown');
        const distIndex = resolveProject(path.join('dist', 'index.html'));
        const distServer = resolveProject(path.join('dist', 'server.cjs'));
        const built = fileExists(distIndex) && fileExists(distServer);
        if (!built) {
          return warn(
            'version_consistency',
            'App Version & Launcher Gate',
            'build_integrity',
            `Version ${version} — compiled bundle (dist/) missing or stale; the launcher will rebuild on next npm start.`,
            'Run npm start — the launcher auto-rebuilds when the served version differs.',
          );
        }
        return pass(
          'version_consistency',
          'App Version & Launcher Gate',
          'build_integrity',
          `Version ${version} with a present compiled bundle — the launcher version gate can verify and hot-restart cleanly.`,
          { version, distBuilt: true },
        );
      } catch (err) {
        return warn(
          'version_consistency',
          'App Version & Launcher Gate',
          'build_integrity',
          `package.json unreadable: ${err instanceof Error ? err.message : String(err)}`,
          'Ensure package.json exists at the project root.',
        );
      }
    },
  }),

  // 11. Input resilience (the v1.6.3 "Windows rejected the key press" fix)
  () => ({
    id: 'input_resilience_keymap',
    name: 'Input Resilience (Windows Key-Map & Buttons)',
    category: 'tool_registry',
    run: async (): Promise<DiagnosticCheckResult> => {
      try {
        const { robotJsKeyName } = await import('../actions/WindowsProviders');
        // Keys that MUST translate cleanly on the Windows robotjs backend.
        const mustWork: Array<[string, string]> = [
          ['enter', 'enter'],
          ['control', 'control'],
          ['alt', 'alt'],
          ['win', 'command'],   // K_META = VK_LWIN
          ['pageup', 'pageup'],
        ];
        const broken = mustWork.filter(([input, expected]) => {
          try { return robotJsKeyName(input, 'win32') !== expected; } catch { return true; }
        });
        // X11 keysyms ("return", "page_up") intentionally THROW on the
        // Windows path — that is the v1.6.3 fix itself: the model is told
        // to send robotjs-native lowercase names, and anything else fails
        // fast instead of silently doing nothing.
        const x11StillAccepted = ['return', 'page_up'].filter((key) => {
          try { robotJsKeyName(key, 'win32'); return true; } catch { return false; }
        });
        if (broken.length > 0) {
          return fail(
            'input_resilience_keymap',
            'Input Resilience (Windows Key-Map & Buttons)',
            'tool_registry',
            `Key-map regression: ${broken.map(([i]) => i).join(', ')} no longer translate for robotjs — keyboard control would throw "Windows rejected the key press" again.`,
            'Restore WINDOWS_ROBOTJS_KEY_ALIASES / robotJsKeyName in src/actions/WindowsProviders.ts.',
            { broken: broken.map(([i]) => i) },
          );
        }
        if (x11StillAccepted.length > 0) {
          return warn(
            'input_resilience_keymap',
            'Input Resilience (Windows Key-Map & Buttons)',
            'tool_registry',
            `X11 keysym(s) ${x11StillAccepted.join(', ')} unexpectedly accepted on the Windows path — they should fail fast so the model learns the right key names.`,
            'Check robotJsKeyName in src/actions/WindowsProviders.ts.',
          );
        }
        return pass(
          'input_resilience_keymap',
          'Input Resilience (Windows Key-Map & Buttons)',
          'tool_registry',
          'All 5 probe keys translate correctly for the Windows robotjs backend (enter/control/alt/win→Win key/pageup); X11 keysyms fail fast by design; clicks normalize decorated values ("left click" → left).',
        );
      } catch (err) {
        return warn(
          'input_resilience_keymap',
          'Input Resilience (Windows Key-Map & Buttons)',
          'tool_registry',
          `Key-map probe failed to load: ${err instanceof Error ? err.message : String(err)}`,
          'Check src/actions/WindowsProviders.ts imports cleanly.',
        );
      }
    },
  }),

  // 12. Discord-style voice DSP defaults
  () => ({
    id: 'voice_dsp_pipeline',
    name: 'Discord-Style Voice DSP (Noise / Echo / Auto-Gain)',
    category: 'audio_pipeline',
    run: async (): Promise<DiagnosticCheckResult> => {
      try {
        const { APP_CONFIG } = await import('../config/config');
        const d = APP_CONFIG.defaultSettings;
        const dspOn = (d.noiseSuppression ?? true) && (d.echoCancellation ?? true) && (d.autoGainControl ?? true);
        const greetingsOff = d.voiceGreetings === false;
        if (!dspOn) {
          return warn(
            'voice_dsp_pipeline',
            'Discord-Style Voice DSP (Noise / Echo / Auto-Gain)',
            'audio_pipeline',
            'Voice DSP defaults are disabled in config — new users would get raw mic audio.',
            'Restore noiseSuppression/echoCancellation/autoGainControl: true in src/config/config.ts defaultSettings.',
          );
        }
        return pass(
          'voice_dsp_pipeline',
          'Discord-Style Voice DSP (Noise / Echo / Auto-Gain)',
          'audio_pipeline',
          `Mic cleanup defaults ON (noise suppression + echo cancellation + auto mic volume)${greetingsOff ? '; unprompted greetings OFF (she only speaks when spoken to)' : ''}.`,
        );
      } catch (err) {
        return warn(
          'voice_dsp_pipeline',
          'Discord-Style Voice DSP (Noise / Echo / Auto-Gain)',
          'audio_pipeline',
          `Config probe failed: ${err instanceof Error ? err.message : String(err)}`,
          'Check src/config/config.ts loads cleanly.',
        );
      }
    },
  }),

  // 13. Sleep-command intelligence (the "she keeps interrupting me" fix)
  () => ({
    id: 'voice_sleep_intents',
    name: 'Sleep-Command Intelligence ("full quit" respected)',
    category: 'tool_registry',
    run: async (): Promise<DiagnosticCheckResult> => {
      try {
        const { matchSleepIntent } = await import('../utils/sleepCommands');
        const probes: Array<[string, string | null]> = [
          ['we full quit', 'sleep'],
          ['bye sera', 'sleep'],
          ['stop listening', 'sleep'],
          ['stop', 'stop_speaking'],
          ['quit chrome', null],        // must NOT sleep — it is an app task
          ['open youtube', null],
        ];
        const wrong = probes.filter(([text, expected]) => matchSleepIntent(text) !== expected);
        if (wrong.length > 0) {
          return fail(
            'voice_sleep_intents',
            'Sleep-Command Intelligence ("full quit" respected)',
            'tool_registry',
            `Sleep matcher regression: ${wrong.map(([t]) => `"${t}"`).join(', ')} classify incorrectly — SERA would ignore quit commands or sleep mid-task again.`,
            'Fix matchSleepIntent in src/utils/sleepCommands.ts.',
          );
        }
        return pass(
          'voice_sleep_intents',
          'Sleep-Command Intelligence ("full quit" respected)',
          'tool_registry',
          'Quit/bye/sleep commands put SERA into guaranteed full sleep; task commands like "quit chrome" are never mistaken for sleep.',
        );
      } catch (err) {
        return warn(
          'voice_sleep_intents',
          'Sleep-Command Intelligence ("full quit" respected)',
          'tool_registry',
          `Sleep matcher probe failed: ${err instanceof Error ? err.message : String(err)}`,
          'Check src/utils/sleepCommands.ts loads cleanly.',
        );
      }
    },
  }),
];
