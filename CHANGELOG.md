# Changelog

All notable changes to SERA are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
semantic-ish minor.patch numbering. Details of releases before 1.6.7 live in
the [commit history](https://github.com/beku16/sera/commits/main).

## [1.9.0] — Production-Grade Packaging + Honest Local Setup

Implements the full PHASE 1–4 plan from the v1.9.0 audit: every reported
Local-Mode bug fixed at the root, a packaged-app data contract, rotating
logs, an Ollama service manager, and Windows installer infrastructure.

### Fixed
- **BUG L1 — model visibility:** `minTier` was implemented as an exact
  membership whitelist, hiding lighter models on stronger GPUs (phi3.5 was
  unreachable on cuda-high; qwen2.5:1.5b visible on nothing but cuda-low).
  It is now a true minimum via an ordered tier rank.
- **BUG L2 — ghost "Model ready ✓":** the startup wizard ended every pull
  stream with unconditional success. Both wizard and MY PC now share one
  verified flow (`runVerifiedPull`): PREPARING → CONNECTING → DOWNLOADING
  (bytes/%) → VERIFYING → READY, where success requires Ollama's own
  `/api/tags` to list the model. Failures carry a WHAT/WHY/FIX/RETRY
  contract with the USE ONLINE MODE escape hatch.
- **BUG L3 — port death:** default port is now SERA's own **43110**
  (`PORT` still wins); on EADDRINUSE the server falls back to an ephemeral
  port instead of `process.exit(1)`. The actual port is published via the
  `SERA_LISTENING_PORT=<port>` stdout marker and `<SERA home>/sera.port`
  handshake file, and the Electron shell follows it.
- **BUG L4 — nvidia-smi spam:** the hardware audit is cached for 5 minutes;
  `?rescan=1` (the RE-SCAN HARDWARE button) forces a fresh probe.
- **BUG L5 — packaged writes:** 20+ `process.cwd()` write sites migrated to
  the new SERAPaths resolver — vault, memories, mistake store, orchestrator
  state, tmp/backups, OCR data. Nothing user-written lands under the
  (potentially read-only) install dir; a one-time migration COPIES legacy
  repo data into the per-user home without deleting anything.
- **BUG L6 — SERA.exe relaunch:** the backend is spawned with
  `ELECTRON_RUN_AS_NODE=1` inside packages (and the OCR setup script is
  resolved from resources/).
- **BUG L7 — external Node dependency:** the speech worker uses
  `SERA.exe --run-as-node` when packaged instead of a hardcoded
  `C:\Program Files\nodejs\node.exe`.
- **BUG L8 — pip assumption:** the `pip install piper-tts` auto-setup is
  gone. Piper stays a documented drop-in under `%USERPROFILE%\.sera`.
- **BUG L9 — OCR cache:** tesseract.js gets explicit `langPath`/`cachePath`
  in `%LOCALAPPDATA%\SERA\ocr`; no CWD cache, no CDN refetch.
- **BUG L10 — collateral kills:** `Stop SERA.bat` and the in-app quit now
  stop only SERA-owned processes (title-scoped window close,
  command-line-checked port kill). The old `taskkill /IM electron.exe`
  killed every Electron app on the machine.

### Added
- **Verified-live catalog** with honest fit grading: qwen3:4b, qwen3:8b and
  gemma3:4b added (registry pages checked live); llama3.3 deliberately
  excluded (ships only as a 43 GB 70B — dishonest for target GPUs). Every
  model carries provider/params/toolSupport/vision/reasoning/coding/
  cpuFallbackSpeed/compatibility metadata and an EXCELLENT FIT / GOOD /
  PARTIAL OFFLOAD / CPU FALLBACK / NOT RECOMMENDED grade with VRAM headroom.
- **Disk-space pre-check** (spec §19) before catalog pulls via statfs on
  the Ollama models dir — no more 97%-then-dead multi-GB downloads.
- **Missing-model UX** (spec §52): a vanished selected model produces an
  explicit in-chat notice with REINSTALL / CHOOSE ANOTHER / SYSTEM CHECK —
  never silent substitution.
- **Ollama service manager** (spec §11/§12): GET/POST
  `/api/local/ollama[/start]` + a START OLLAMA button — spawns `ollama
  serve` only when the CLI exists and the daemon is down, health-polls
  ≤ 30 s, and kills only the child it owns.
- **Rotating structured logs** (spec §97): `%LOCALAPPDATA%\SERA\logs\sera-
  YYYY-MM-DD.log`, 14-day rotation, API keys/tokens/passwords redacted,
  boot/pull/crash events, OPEN LOG FOLDER in MY PC + the Electron preload.
- **Crash recovery** (spec §31): the Electron supervisor retries the
  backend with backoff (≤ 3), then shows an honest window with RESTART /
  OPEN LOGS.
- **Packaging infrastructure:** `electron-builder.yml` (NSIS one-click +
  portable, asarUnpack for natives, per-user install, updates preserve all
  user data), `build/icon.ico` generator, `scripts/dist-win.mjs`
  (version → icon → build → Electron-ABI rebuild → builder).
- **Version single-sourcing:** `src/generated/appVersion.ts` written from
  package.json at build time; health endpoint, wizard and artifacts share it.

### Changed
- Dev-mode defaults follow the new port; `Start SERA.bat` / launcher and
  the diagnostics' port references updated to 43110.
- The version bump also updates the wizard's honest test count (suite now
  **650 tests**, +48 since 1.8.5).

### Verified
- `tsc --noEmit` clean, `vitest run` **650 passed / 19 skipped / 0 failed**,
  production build succeeds (dist/server.cjs 819 KB).
- Production-bundle smoke test (`scripts/smoke-prod.sh`, Linux): port
  marker + handshake file, EADDRINUSE fallback observed live (43110 →
  45669), graded catalog, honest cpu-only grading on a GPU-less host,
  ollama manager state, boot log written, writable-data isolation.
- Windows installer output, NSIS runtime, nvidia-smi parsing and SAPI
  speech are **NOT TESTED ON WINDOWS** (no Windows builder in this
  environment — spec §76); `npm run dist:win` + the packaged smoke
  checklist must run on a Windows machine before publishing.

## [1.8.5] — The Launcher Stops Crying "Version Mismatch" About a Healthy Server

### Fixed
- **Re-opening SERA while it runs no longer reports a false "OLD SERA
  server, version mismatch".** The double-click launcher's already-running
  check compared the live server's version against `APP_VERSION`, which had
  been hardcoded to `1.6.10` since that era — so with any newer build
  running (anything from the last several releases), running
  `Start SERA.bat` again — the documented way to re-open a missing window —
  wrongly concluded the server was stale, told you to
  `taskkill /F /IM node.exe`, and refused to open the desktop window. The
  launcher now syncs `APP_VERSION` from `package.json` at startup (with the
  hardcoded value kept only as a fallback if Node cannot read it), so the
  mismatch detector does what it was always meant to do: flag *actually*
  old servers after a folder update, and happily re-open the window
  otherwise. The console banners now also report the true version
  ("SERA v1.8.5 is already running / is live") instead of a frozen 1.6.10.
- Note: because the setup wizard re-shows once per new app version
  (the v1.8.4 fix), updating to 1.8.5 will show the mode-selection screen
  one more time. That is the intended behavior — it confirms the update
  landed.

## [1.8.4] — The Mode Screen Is Back, Model Installs Explain Themselves, Dock Resizes

### Fixed
- **The startup mode-selection screen shows again.** Electron's userData —
  which backs localStorage — is keyed by the app's *name*, not its install
  folder, so a "fresh" SERA install inherited `startupComplete=true` from the
  previous install and the offline/online chooser (with all its setup
  instructions) never appeared. The wizard now re-shows exactly once per new
  app version: completing it stamps `startupCompletedVersion`, and any build
  with a newer version shows it one more time.
- **Re-opening the wizard is finally possible**: Settings → MY PC → LOCAL
  ENGINE STATUS has a "SETUP WIZARD" button (the `reopenLauncher` handler
  existed since v1.6 but was wired to nothing — once you finished the wizard,
  its instructions were unreachable forever).
- **Model installs explain themselves instead of "fetch failed".** Clicking
  INSTALL with Ollama not installed/running used to hit
  `127.0.0.1:11434/api/pull` and surface the raw Node error —
  *"Pull failed – NOT installed: fetch failed"* — with zero guidance.
  `POST /api/local/pull` now pre-checks the daemon and streams an honest
  error (install link, how to start it, the Online-Mode escape hatch), and
  `OllamaClient.pullModel` translates connection-level failures the same way
  as a defense in depth for the case where the daemon dies mid-flight.
- **Local-mode failures are no longer invisible.** The assistant hook has
  produced a detailed `errorMessage` since v1.6 (e.g. "I cannot reach the
  Ollama engine… fix in 2 minutes…"), but MicControl accepted it as a prop
  and never rendered it — you typed, nothing answered, and no error appeared
  anywhere. The message now renders both under the voice deck and as a strip
  directly above the chat input (where you are looking when nothing answers).

### Changed
- **Screen-share dock: bigger by default, resizable, remembered.** The dock
  was a fixed 228px wide with a 112px preview — the shared screen was
  unreadably tiny. It is now 340px by default with a 16:9 preview that grows
  with the dock, and a drag grip at the bottom edge resizes it between
  260–640px; the chosen width persists across restarts. Micro-labels gained
  ~1px for readability.

## [1.8.3] — Share Screen Works in the Desktop App (Native Picker)

### Fixed
- **Share Screen now works inside the SERA desktop window** — for the first
  time. Since Electron 22 the built-in Chromium screen picker is gone: unless
  the app registers `session.setDisplayMediaRequestHandler`, EVERY
  `navigator.mediaDevices.getDisplayMedia()` call from the renderer rejects
  with `NotSupportedError`, which the share dock surfaced as *"This browser
  cannot capture the screen. Use Chrome, Edge, or Firefox on desktop."* The
  desktop shell never registered the handler (v1.7.0–v1.8.2), so browser
  sharing worked in Chrome during development but never in the Electron
  window users actually run.
- The fix ships a **native source picker** (`electron/screen-picker.html` +
  `picker-preload.cjs`): entire screens first, then application windows,
  with live thumbnails and app icons; clicking a surface starts the share,
  Esc / Cancel / closing the window denies it cleanly (the dock shows
  "selection cancelled" instead of a mystery error). Ghost windows of
  background processes (empty thumbnails — the ones the native Chromium
  picker hides too) are filtered out, a machine with a single capturable
  surface skips the picker entirely, and a second request while the picker
  is open is denied instead of stacking modals.
- **macOS 15+ gets the OS system picker** for free via `useSystemPicker` —
  the handler is not even invoked there.
- **Hardened by construction**: the picker runs in a sandboxed,
  context-isolated window on its own session partition (no inheritance of
  the main session's CSP/permission/storage), its only capability is a
  three-call IPC bridge, all dynamic strings render via `textContent`, and
  the handler denies — never hangs — when `desktopCapturer` fails.
- Verified two ways beyond the usual gates: an 11-check picker-UI smoke in
  real headless Chromium (sections, thumbnails, icons, selection, retry
  after failure, Esc/Cancel, empty/missing-bridge states) and an 18-check
  main-process smoke driving the real `electron/main.cjs` against a stubbed
  Electron module (grant/deny paths, ghost filtering, overlap protection,
  picker teardown, crash safety).

## [1.8.2] — Repository Polish & Hardened CI

### CI (first fully-green pipeline)
- **All three CI jobs green on every push/PR**: `Lint & Test` on Node 22 and
  Node 24, plus a `Production bundle` build check. The badge on the README
  now reflects reality (it had promised CI that was never committed).
- **Real-browser tests skip cleanly in browserless environments**: the three
  `browser.test.ts` integration tests that launch real Playwright Chromium
  now probe with an actual headless launch (and close) at module scope and
  skip themselves when unavailable. This is deliberately NOT an
  `executablePath()` existence check — GitHub-hosted runners ship a full
  Chromium in the Playwright cache but lack the separate headless-shell
  build that `launch({ headless: true })` uses, so an existence probe
  passed while the tests still failed. On any machine with a plain
  `npm install` (postinstall downloads both builds) the tests still run.
- **One automatic retry for the vitest step**: a forks worker very rarely
  dies on a hosted runner ("Worker exited unexpectedly", no stack —
  transient and environmental; the identical suite passes on the adjacent
  commit, taking a random 4-test file with it). Attempt 1 is
  `continue-on-error`; a retry step runs only when it failed, and its
  result decides the job. Deterministic failures fail both attempts and
  stay red — nothing is masked.
- **Node matrix moved to supported LTS lines (22, 24)**: the Node 20 leg
  could never work — jsdom 30 (the vitest environment) declares
  `engines: ^22.22.2 || ^24.15.0 || >=26`; its undici 8 dependency calls
  `worker_threads.markAsUncloneable`, an API Node 20 never shipped, so all
  55 test workers died at import and zero tests ran. Node 20 has been EOL
  since April 2026.

### Changed
- `package.json` `engines` bumped from `>=20` to `>=22` — the previous
  claim was untestable and dishonest; CI now enforces what we actually
  support. README (badge, requirements, quick start, contributing) and
  CONTRIBUTING.md aligned to match.

### Removed
- `scripts/local-smoke-v166.cjs` — a one-off v1.6.6-era local-mode smoke
  test referenced by nothing (no npm script, no docs). Its verification
  duties live in the vitest suite (`localSpeechPipeline.test.ts`,
  `serverShutdown.test.ts`, ...).

### Documentation
- README gained a **What's new** section summarizing the whole
  screen-intelligence arc (v1.6.x foundation → v1.7.0 browser sharing +
  Screen Vision → v1.8.0 Screen OCR + Screen Memory → v1.8.1 adjustable
  OCR interval → v1.8.2 polish), a **screen-intelligence pipeline
  diagram**, and the `src/server/` layer in the architecture tree (the
  screenVision / screenOcr / screenMemory modules were previously
  invisible in the map).
- Stale "Node 20 and 22" CI references fixed in README and
  CONTRIBUTING.md.

## [1.8.1] — Adjustable OCR Interval

### User-Controlled OCR Re-Scan Cadence
- **`OCR EVERY [−] 8s [+]` stepper in the share dock**: how often SERA
  re-reads the visible text on the shared screen is no longer a fixed ~8s —
  the user picks a cadence from 2s (freshest reading + screen memory, more
  CPU) to 60s (lightest), and the change applies **live mid-share** with no
  restart of the share. The preference persists in localStorage
  (`sera_screen_ocr_interval_v1`) and rides the next `start`, so the
  following shares begin at the chosen cadence.
- **Wire protocol** (`/api/screen-vision`): `start` accepts an optional
  `ocrIntervalMs`, and a new `ocr_interval` message changes it at runtime;
  every `screen_channel_state` now echoes the server-confirmed
  `ocrIntervalMs` so the UI never lies about the effective cadence. Old
  clients (no field) and old servers (unknown message ignored) remain
  fully compatible — both ends are optional.
- **Server-side clamping (never trust the client)**: intervals are clamped
  to 2s–120s on every message (`clampOcrIntervalMs`); junk values are
  ignored and keep the current cadence. Lowering the interval takes effect
  naturally on the next accepted frame (the gate compares against the new,
  smaller interval), and a socket blip + re-register without the field
  keeps the live interval (like the frame ring survives reconnects).
- **Trusted server config stays unclamped**: the constructor-level
  `ocrIntervalMs` default is operator/test configuration and is NOT
  clamped (tests OCR every frame with 0).
- **Verified end-to-end on the built server**: a live-socket smoke test
  renders a text page, shares it, and proves the 2s cadence OCRs for real,
  a live raise to 15s gates subsequent frames, clamping (100→2000,
  1e9→120000) holds, and junk values are ignored. 14 new unit tests pin
  the registry/transport rules (599 total, all green).

## [1.8.0] — Screen OCR + Screen Memory

### Ultra-Precise Reading (OCR)
- **Tesseract OCR on live share frames** (`src/server/screenOcr.ts`): every
  ~8s the newest shared frame is also run through Tesseract; the distilled
  visible text is injected **next to the image** into the Gemini session,
  so SERA reads exact strings — URLs, code identifiers, error messages,
  analytics numbers — instead of squinting at pixels. Vision models
  misread small text; OCR ground truth does not.
- **Text-only vision in LOCAL MODE**: Ollama cannot see images, but the
  local-mode hint now carries the fresh OCR text, so "read the visible
  text" / "what does this error say" honestly WORKS offline. The dock
  shows `LOCAL · TEXT VISION (OCR Nc)` when it is active.
- **Honest OCR telemetry**: the dock telemetry line shows `OCR Nc`
  (characters of visible text the server last read) — no fake indicators.
- **Non-blocking by construction**: OCR is interval-gated and
  single-flight per channel; a slow or crashed engine never delays,
  blocks, or kills frame forwarding. The Tesseract worker is terminated
  on graceful shutdown (no hanging event loop).
- **Text distillation**: raw OCR output is cleaned (whitespace collapsed,
  junk/duplicate lines dropped, head+tail capped at 4,000 chars) and
  near-identical screens are detected with word-set Jaccard similarity.

### Screen Memory ("remember what was on my screen")
- **Per-user screen digest log** (`src/server/screenMemory.ts`): every
  DISTINCT screen state (per OCR) is distilled into a bounded, age-pruned
  log (40 entries / 2h, per user) — so "what was on my screen earlier?",
  "remember the page I was showing you?" works **during AND after the
  share**, even though the model only ever saw the newest two frames.
- **Memory persistence across restarts**: when a share ends (stop,
  disconnect, or crash), a session summary — time range, source, and the
  last visible content digest — is committed into the same persistent
  MemoryManager as the user's facts, keyed to their authorization ID.
  Like all memories it goes through the secret filter: nothing
  password/token/card-shaped is ever stored.
- **Throttled, honest injection**: the digest is quoted at most once per
  20s, only for questions that actually reference PAST screens (recall
  cue + screen noun), never for ordinary chatter.

## [1.7.0] — Browser screen sharing + Screen Vision

### Screen Sharing (real, browser-native)
- **"Share Screen" button** (bottom-left dock): calls
  `navigator.mediaDevices.getDisplayMedia()` — the browser's own picker lets
  the user share their **entire screen, an application window, or a browser
  tab**. Nothing is shared until the user explicitly picks a surface.
- **Live preview + honest indicator**: a floating glassmorphism dock shows a
  live preview of the shared surface, a pulsing `SCREEN SHARING ACTIVE`
  indicator, the surface type (Entire Screen / App Window / Browser Tab),
  and frame telemetry (sent / skipped / KB per frame).
- **Full controls**: Start Sharing, Pause Sharing (feed pauses, preview
  keeps running), Resume Sharing, Switch Source (pick a different
  screen/window/tab mid-share), and Stop — plus the browser's own stop bar
  and Chrome's native surface-switcher, both wired to the same clean
  teardown path.
- **Graceful failure handling**: permission denied, picker cancelled, no
  monitor selected, unsupported browser, and insecure context each surface
  a typed, actionable message instead of a dead button.
- **Privacy by design**: with Screen Vision OFF, frames never leave the
  device (preview only). Static screens send zero frames (perceptual
  change detection on a 32-cell luma grid — the same trick as the v1.6.10
  server feed).

### Screen Vision (Gemini sees the screen)
- **New `/api/screen-vision` WebSocket channel** (same security guard as
  `/api/live`): the share is decoupled from the voice session so it
  **survives Gemini session rollovers** — frames buffer server-side
  (bounded ring) and are injected into every fresh session the moment it
  becomes ready, *before* any queued question. "What is on my screen?" is
  always answered from the CURRENT screen.
- **Continuous vision**: frames stream into the Gemini Live session through
  the `realtimeInput` media channel every ~2.5s (only when the screen
  changes). SERA can answer "what is on my screen?", "what website am I
  on?", "do you see any errors?", "explain this code", "summarize this
  page", "read the visible text", "how is this thumbnail?", "analyze my
  YouTube analytics" — by voice or text.
- **Context between frames**: frames accumulate in the live session's
  context (sliding-window compressed), so follow-ups like "what changed?"
  work. A question-time refresh re-injects the newest frame when the last
  one the model saw is >30s old (static screen / long monologue).
- **One-shot "look now" with vision OFF**: asking a screen question while
  continuous vision is off attaches exactly ONE fresh frame, ordered before
  the question text on the same socket.
- **Honesty guarantees**: the model is told (context-only, never speech)
  when sharing starts, pauses, switches, or stops — it can never claim to
  see a screen it can't. Paused shares answer "sharing's paused" instead
  of guessing. Local mode admits screen vision needs Online Mode instead
  of inventing screen contents.
- **Hardened transport**: 1MB wire cap, per-frame byte ceiling (220KB),
  flood guard (min 400ms between frames), 8-channel cap (multi-tab), 10s
  reconnect grace before a dropped channel is treated as dead, client-side
  backoff reconnect with newest-wins frame queueing, and app-level
  heartbeats. `/api/health` reports screen-vision channel telemetry.
- 64 new tests (`screenVision`, `browserScreenShare`, `screenVisionChannel`)
  covering the registry rules, capture pipeline contract, and channel
  protocol — 554 total passing.

## [1.6.11] — Backend hardening: security, reliability, memory

### Security (new `src/server/` modules)
- **Request guard for HTTP *and* WebSocket** (`src/server/security.ts`): one
  policy now protects both transports. Loopback-only `Host` header checks
  kill DNS-rebinding attacks; `Origin` validation kills cross-site WebSocket
  hijacking and CSRF — previously ANY webpage open in the user's browser
  could connect to `ws://127.0.0.1:3000/api/live` and drive the 36-tool
  computer-control surface (browsers do not apply CORS to WebSocket
  handshakes). Same-origin browser traffic and the Electron shell are
  unaffected; `Origin: null`, public hostnames and forged Hosts are rejected
  with 403.
- **Optional shared-secret token** (`SERA_AUTH_TOKEN`): when set, every `/api`
  request and WS upgrade must present `Authorization: Bearer <token>` or
  `?token=` — defends against other local processes, which can spoof Host
  and omit Origin. Empty by default (normal browser/Electron UX unchanged).
- **Rate limiting** (`src/server/rateLimit.ts`): generous per-minute budgets
  on the expensive endpoints (deep scans, model pulls, agent chats, repairs,
  desktop launches) so a runaway client retry loop gets 429s instead of
  spawning dozens of child processes. `SERA_RATE_LIMIT_PER_MIN=60` default,
  0 disables.
- Baseline security headers (`X-Content-Type-Options`, `Referrer-Policy`,
  `X-Frame-Options`) and `x-powered-by` disabled.
- Unknown `/api/*` routes now return a JSON 404 instead of the SPA HTML shell
  with a bogus 200.

### Reliability (Live session loop)
- **Orphaned screen-capture timer** (both modes): the underlying 100ms
  capture timer kept capturing the screen at ~10fps forever after a client
  disconnected — only the frame *feed* was stopped, never the controller.
  Every close path now calls `stopSharing()`.
- **Gemini session errors now recover**: `onerror` used to leave
  `isSessionActive = true` with the client streaming audio into a dead
  session. It now deactivates the session, stops the share feed, notifies
  the client, and closes the socket so the frontend reconnects.
- **Tool-call serialization**: the Gemini SDK does not serialize
  `onmessage` callbacks — two tool-call batches arriving back-to-back
  interleaved their awaited executions (racing keyboard/clipboard writes).
  All messages now flow through a per-session promise chain (the same
  pattern as the local mode's `turnChain`).
- **Every tool call always answers Gemini**: a throwing
  `validateArgs`/`capabilityForArgs` used to abort the whole batch, leaving
  the session hanging for functionResponses it would never receive. Tool
  calls are individually guarded (in `ToolManager` *and* the server loop) and
  always produce a structured failure.
- **Queued text is no longer lost**: the client message listener is attached
  *before* `ai.live.connect()` (text typed during the connect window was
  silently dropped), the pending queue is bounded at 50, and it is cleared
  on close.
- **Graceful shutdown** (`src/server/shutdown.ts`): SIGINT/SIGTERM now run a
  LIFO, time-boxed cleanup — HTTP server, WS clients, managed browser,
  screen sharing, health monitor — instead of dying mid-flight. A second
  Ctrl+C force-exits.
- `POST /api/desktop/launch` spawns the *matching* script (it always spawned
  `desktop:dev`, even in production) and reports spawn failures instead of
  crashing on an unhandled child 'error' event.
- WS connection handler wrapped: a malformed upgrade URL can no longer
  produce an unhandled rejection with a half-initialized socket.
- Missing WS socket error handler on the online path added.
- Model fallback list deduplicated (log and connect loop shared one copy).
- Fallback execution ids made session-unique (cross-message `callIndex`
  collisions returned wrong cached ToolManager results).

### Memory leaks fixed
- `ToolManager` executions map: settled results (including ~500KB base64
  screenshots) were retained forever up to 1,000 entries — evicted 60s after
  settle (dedupe window preserved).
- `LocalAgentEngine` histories: one entry per WS session, never pruned — now
  capped at 32 sessions with LRU eviction; trimmed history no longer starts
  with an orphaned `tool` message.
- `ComputerAuthorizationManager` sessions map: unbounded per authorization
  id — capped at 512.
- whisper.cpp `-otxt` sidecar files: one temp file leaked per voice
  utterance — now deleted with the wav.

### Correctness fixes
- **Paid providers were permanently unusable**: enabling one (plus the
  global "Allow paid providers" switch) still hit
  `"paid provider not explicitly authorized"` forever because
  `userAuthorized` was never set or persisted. Enabling a paid provider is
  now the explicit authorization; disabling revokes it.
- **Router latency tiers**: the `> 10000ms` penalty was dead code (the
  `> 4000ms` branch matched first) — a 12-second provider scored the same
  as a 5-second one. Tiers reordered slowest-first.
- **Startup model audit**: `primaryLocalModel` fallback was a no-op
  (`cond ? a : a`) — now honestly falls back to the fastest *installed*
  local model when the recommendation is missing.
- **Ollama adapter telemetry**: reported total duration as TTFT — now the
  honest wall-clock round-trip.
- **Ollama pull**: a stalled stream hung the HTTP response forever (90s
  inactivity abort added), and a stream ending without `success` still
  reported `success: true` (ghost install) — now an honest failure.
- **Memory store corruption**: non-atomic writes could truncate the JSON on
  crash (next boot silently reset all memories to `[]`); persistence is now
  tmp+rename atomic and serialized.
- **Health monitor sweeps**: concurrent `/api/diagnostics/health` calls each
  ran a full scan in parallel (the documented in-flight guard never
  existed) — callers now share one sweep. The deep-scan flag no longer
  races between overlapping scans.
- `DELETE /api/keys/:unknown` returns 404 instead of 200 `{deleted:false}`.
- `/api/agi/mistakes` counts lessons via `lessonCount()` instead of
  materializing the entire mistake memory with `MAX_SAFE_INTEGER`.
- `/api/health` reports uptime, memory footprint, live WS client count and
  auth posture.

### CI
- Added `.github/workflows/ci.yml` (the README badge promised CI that did
  not exist): lint + full test suite on Node 20/22 and a production bundle
  build check.

### Changed
- `@types/three` actually removed from `dependencies` (the 1.6.10 changelog
  claimed the move but both entries remained).

## [1.6.10]

### Added
- Discord-style live screen share: `screen.startSharing` now starts a real
  frame feed — the server captures the screen about once per second, JPEG-encodes
  each frame at a hard 160 KB cap, skips frames identical to the last one
  (an idle screen costs nothing), and pushes changed frames into the Gemini
  session through the realtime-input media channel. A red LIVE badge with a
  STOP button shows in the UI while sharing is on.
- System-instruction guidance for live vision: SERA treats incoming frames as
  the user's current screen, narrates naturally, and stops sharing on request.
- Perceptual frame signatures for change detection
  (`frameSignature` / `signatureDiff`).

### Fixed
- Session killer, with evidence from field logs: 482–700 KB PNG screenshots
  passed the old threshold unchanged and Google killed the session 3–10 s
  after each one. Every image reaching the Live wire is now JPEG-encoded
  (~60–150 KB) with a PNG fallback and a metadata-only last resort; the
  session always survives.
- The live screen-share feed always dies with its session on every close
  path — no orphaned capture timers across reconnects.
- Flaky wake-greeting test: the deterministic greeting pool contained an
  entry that the test regex could not match (one-in-six failure rate).

### Changed
- Removed unused dependencies `motion` and `autoprefixer` and moved
  `@types/three` to devDependencies.

## [1.6.9]

### Fixed
- "See my screen" no longer kills the session: screenshots were inlined into
  the Gemini Live socket at full resolution and Google tore the session down
  ~15–20 s later. Images are now capped for the wire.
- Stuck "connecting" state: reconnect scheduling now fires directly on
  unexpected disconnect (1 s / 2 s / 4 s backoff, three attempts, honest
  give-up) instead of depending on a same-value state transition.
- Two-tab bug: the OS default-browser open and the in-app `window.open` both
  fired for the same URL; only one open happens per request now.
- Clipboard probes are gone for good: diagnostics are 100% read-only on every
  path, including full scans; the write-probe code was deleted and tests
  assert no clipboard writes occur.
- Desktop wake word: the Electron SAPI speech bridge falls back to the browser
  speech engine automatically, the speech worker inherits a full Windows
  environment, and the wake chip surfaces the real failure reason.
- Model pull "This operation was aborted": timeouts no longer abort slow
  Ollama manifest pulls (`timeoutMs: 0` means no timer).
- Phantom "ACTIVE" model badge: only models confirmed by Ollama show as active.

### Added
- Persistent engine home (`~/.sera`): the server auto-installs the OCR model
  and Piper TTS in the background on first boot — no more manual
  `npm run setup:ocr` / `pip install piper-tts` after updates.

## [1.6.8]

### Fixed
- Wake word on Windows: the PowerShell speech bridge was repaired
  (`ReadOnlyCollection<RecognizerInfo>` + `.Count`).
- Silent resume: unexpected disconnects keep the session glow and reconnect
  without announcements; three failed attempts surface an honest error.
- Server window lifecycle: the "SERA Server" console now closes itself when
  the server exits normally (power button / `Stop SERA.bat`), and only stays
  open with a visible error when the server crashed.

### Changed
- Calmer console logging.

## [1.6.7]

### Added
- Honest model installs in Settings → MY PC: "installed" only appears after
  Ollama itself confirms the model; errors show verbatim with real MB
  progress counters.
- Choose-your-own model catalog with per-model install progress.
- LET ME HEAR (LIVE): Discord-style real-time mic monitoring in
  Settings → MIC & SPEAKERS.
- Wake-status chip: an always-honest label for the wake listener
  (listening, or exactly why it is off), with self-healing restarts.

## [1.6.0] – [1.6.6]

Selected highlights (see the commit history for the full list):

- Local Mode voice: microphone streaming into the offline whisper engine
  (client PCM capture + VAD → server transcription), desktop SAPI bridge
  fallback (1.6.5/1.6.6).
- Desktop-control safety guard: keyboard presses and clipboard writes
  execute only when the user's own words ask for them; hallucinated
  shortcuts are blocked and logged (1.6.6).
- Visible website opens in the real default browser plus offline
  quick-commands in Local Mode, e.g. "open youtube" (1.6.2).
- Silent reconnects (1.6.4) that resume the same conversation via session
  resumption handles (1.6.5).
- Chat/tools separation: tool executions moved out of the chat stream into
  the compact TOOL ACTIVITY view (1.6.5).
- Launcher hardening: Smart App Control-proof `npm start` path, automatic
  Mark-of-the-Web unblocking, Electron shell auto-repair, desktop shortcut
  creation, lockfile self-heal after installs.
- A-to-Z diagnostics rebuild (1.6.1 era) with multi-stage network
  reachability, DNS-hijack resilience, and HTTPS_PROXY support.

[1.6.10]: https://github.com/beku16/sera/releases/tag/v1.6.10
[1.6.9]: https://github.com/beku16/sera/compare/v1.6.9...v1.6.10
[1.6.8]: https://github.com/beku16/sera/compare/v1.6.8...v1.6.9
[1.6.7]: https://github.com/beku16/sera/compare/v1.6.7...v1.6.8
[1.6.0–1.6.6]: https://github.com/beku16/sera/commits/main
