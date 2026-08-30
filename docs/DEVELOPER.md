# SERA — Developer Guide

Dev loop, architecture map, the v1.9.0 data contract, and packaging.

## Dev loop

```bash
npm install            # also: playwright install chromium (postinstall)
npm run dev            # tsx server.ts + Vite middleware → http://localhost:43110
npm run desktop:dev    # the Electron shell around the dev server
npm test               # vitest run (650 tests)
npm run lint           # tsc --noEmit
npm run build          # version gen → vite build + esbuild → dist/
npm start              # production server via scripts/launcher.mjs
```

- The backend now defaults to port **43110** (`PORT` env still wins) and
  falls back to an ephemeral port on EADDRINUSE — the actual port is
  printed as `SERA_LISTENING_PORT=<port>` and written to
  `<SERA home>/sera.port`.
- `SERA_USE_EXISTING_SERVER=true npm run desktop:dev` points the Electron
  shell at an already-running backend instead of spawning its own.

## Architecture map

```
server.ts (bundled → dist/server.cjs, --packages=external)
 ├─ Express API        /api/local/*, /api/keys/*, /api/diagnostics/*, …
 ├─ WebSockets         /api/live (Gemini Live | local agent, by ?mode=)
 │                     /api/screen-vision (browser screen frames)
 ├─ security.ts        loopback-only guard for HTTP + WS (Host/Origin/token)
 ├─ listenWithFallback port resilience (BUG L3)
 └─ logging.ts         rotating structured logs + secret redaction
electron/main.cjs       shell: spawns backend (ELECTRON_RUN_AS_NODE), speech
                       worker, port handshake, crash recovery window
src/local/              OllamaClient, LocalAgentEngine, ModelRecommender,
                       modelCatalogData, modelPullClient (verified pulls),
                       HardwareInspector (cached, ?rescan=1), ollamaManager,
                       SERAPaths, diskSpace, ApiKeyVault, speech engines
src/components/         React UI (wizard, MY PC, chat, dock, settings)
src/diagnostics/       61-check doctor + AutoRepairEngine (package-aware)
src/{agi,orchestration,tools,actions,vision,memory,learning}/  the agent stack
```

## The SERAPaths data contract (v1.9.0)

`src/local/SERAPaths.ts` is the ONE resolver for every directory:

| Kind | Packaged | Dev |
|---|---|---|
| resources (read-only) | `process.resourcesPath` | repo root |
| user data (vault, memories, state) | `%APPDATA%\SERA` | same (env-overridable) |
| local data (logs, ocr, tmp) | `%LOCALAPPDATA%\SERA` | same |
| engines (whisper, piper) | `%USERPROFILE%\.sera` | same |

Env overrides for tests/CI: `SERA_RESOURCES_PATH`, `SERA_USER_DATA`,
`SERA_LOCAL_DATA`, `SERA_HOME`. `SERA_PACKAGED=1|0` overrides the
package-detection heuristic. `migrateLegacyData()` copies repo-era
`.data/sera_memories.json` + vault files into the new home exactly once —
never deletes.

**Rule: never write relative to `process.cwd()` in new code.** Use
SERAPaths. The CI grep for `process.cwd()` in write paths is the guard.

## Honest-pull contract (v1.9.0)

All installs go through `src/local/modelPullClient.ts`
(`runVerifiedPull`): PREPARING → CONNECTING → DOWNLOADING(bytes/%) →
VERIFYING → READY. Success requires Ollama's `/api/tags` to list the model;
failures carry `{what, why, fix, retryable}`. The wizard and MY PC share
this one flow. The server pre-checks disk space (`src/local/diskSpace.ts`,
statfs on the Ollama models dir) before any catalog pull.

## Ollama manager (spec §11/§12)

`src/local/ollamaManager.ts` + `/api/local/ollama[/start]`: State A READY /
B INSTALLED-STARTING (spawns `ollama serve` only when CLI found & daemon
down; owns + later kills only that child) / C NOT INSTALLED. The MY PC tab
surfaces START OLLAMA and honest state text.

## Building the Windows installer

On a **Windows** machine with Node ≥ 22, VS Build Tools (C++) and Python
(for node-gyp):

```bash
npm run dist:win       # version → icon → build → electron-ABI rebuild → NSIS + portable
```

Notes:

- `robotjs` must rebuild against Electron's ABI (audit BUG L12). If the
  rebuild fails, the dist STOPS — a packaged app cannot recover at runtime.
  SERA degrades gracefully to the koffi SendInput fallback in dev/source
  builds, but we do not ship silently-broken natives.
- `asarUnpack` (electron-builder.yml) lists every native/binary module —
  add yours there or it will fail only at runtime inside the package.
- Portable data caveat is documented in docs/INSTALL-WINDOWS.md.

## Testing conventions

- One `<topic>.test.ts` per subsystem under `src/__tests__/`.
- Network-touching code takes an injectable client/fetch (see
  modelPullVerification, ollamaManager tests) — the suite never needs
  Ollama or the internet.
- Port/socket tests must give the server a request handler and close every
  server they open (a handler-less http.Server never answers — the
  portFallback suite documents the trap).
