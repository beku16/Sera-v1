# SERA — Local-First Real-Time Voice AI Assistant

[![CI](https://github.com/beku16/sera/actions/workflows/ci.yml/badge.svg)](https://github.com/beku16/sera/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)](#quick-start)

SERA is a personal, real-time voice-to-voice AI assistant that runs on your
machine by default: a local Ollama model for a brain, your microphone and
speakers for a voice, and a 36-tool computer-control suite for hands. When you
want more capability, a one-click switch moves the conversation to Gemini Live
online mode. Local first, online optional, always your choice.

## What's new

The screen-intelligence stack, built release by release:

| Release | What landed |
|---|---|
| **v1.9.0** | **Production-grade packaging + honest local setup.** Model catalog verified live against the Ollama registry (qwen3, gemma3 added; per-model EXCELLENT FIT / PARTIAL OFFLOAD / CPU FALLBACK grading); every model pull is now VERIFIED with Ollama before claiming success; SERA owns port **43110** with automatic fallback (no more EADDRINUSE crashes); all user data (memories, vault, state, logs) moved to `%APPDATA%\SERA` / `%LOCALAPPDATA%\SERA` so installed apps never write to Program Files; rotating secret-redacted logs with an OPEN LOG FOLDER button; a START OLLAMA one-click service manager; crash recovery with RESTART / OPEN LOGS; Electron packaging config (NSIS installer + portable) — see `npm run dist:win`. |
| **v1.8.3** | **Share Screen fixed in the desktop app** — a native screen/window picker for the Electron shell (live thumbnails, app icons, Esc to cancel); previously every in-app share failed with "This browser cannot capture the screen". |
| **v1.8.2** | Repository polish: CI hardened (real-browser tests skip cleanly in browserless environments, Node matrix moved to supported LTS lines), engines claim aligned to `>=22`, stale one-off scripts removed, and this documentation sweep. |
| **v1.8.1** | **Adjustable OCR interval** — the share dock's `OCR EVERY [−] 8s [+]` stepper (2s–60s) re-tunes how often SERA re-reads your screen **live mid-share**, server-clamped and persisted across sessions. |
| **v1.8.0** | **Screen OCR + Screen Memory** — Tesseract ground-truth text rides next to each frame (exact URLs, identifiers, error strings); text-only vision for offline Local Mode; a bounded screen digest log answers "what was on my screen earlier?" during and after the share, and share-end summaries persist into long-term memory across restarts. |
| **v1.7.0** | **Real browser screen sharing + Screen Vision** — share your entire screen, a window, or a tab through the browser's native picker; a glassmorphism dock with live preview, pause/resume/switch/stop; frames stream to Gemini over a dedicated reconnect-proof WebSocket while anything changes. |
| **v1.6.x** | The foundation: free-first multi-model orchestration, the 61-check system doctor with auto-repair, honest wake-word status, rate limiting + auth hardening, and the double-click launcher. |

Every release ships with its full verification story in
[CHANGELOG.md](CHANGELOG.md) — the suite now stands at **650 tests**, and CI
runs lint + tests + a production build on every push and pull request
([status badge](https://github.com/beku16/sera/actions/workflows/ci.yml)).

## Install on Windows (no terminal needed)

**Option A — installer / portable (recommended once published):** run
`SERA Setup.exe` (one-click, per-user, no admin) or `SERA Portable.exe`
(single file, data sits next to the exe in `SERAData\`). Builds are produced
with `npm run dist:win` — see [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md)
for where your data lives, how updates preserve it, and how to uninstall.

**Option B — from source, double-click:** grab the ZIP, unzip, and
double-click `Start SERA.bat`. It self-installs (Node, dependencies, build)
and opens the desktop window. [Full walkthrough →](docs/INSTALL-WINDOWS.md)

**For developers:** [docs/DEVELOPER.md](docs/DEVELOPER.md) covers the dev
loop, architecture map, the SERAPaths data contract, and how to build the
Windows installer.

## Features

- **100% offline Local Mode** — an Ollama model on your GPU/CPU handles
  reasoning; speech runs through local engines (whisper.cpp / Piper) with
  browser and system speech as fallbacks. No cloud, no cost.
- **Online Mode with Gemini Live** — real-time bidirectional audio with instant
  barge-in. Falls back across Gemini model revisions automatically.
- **Double-click launcher** — `Start SERA.bat` (Windows) and
  `scripts/start-sera.sh` (macOS/Linux) install, build, start, and open the
  desktop window. No terminal knowledge required.
- **36-tool computer-control agent** — open apps, type, click, read the screen
  via OCR, capture screenshots and windows, drive a managed browser, manage
  the clipboard, send WhatsApp messages, and run system diagnostics.
- **Live screen share** — "see my screen" starts a Discord-style live feed:
  SERA receives the screen continuously (~1 frame per second, only while it
  changes) and reacts to what happens as it happens. A red LIVE badge with a
  STOP button is always visible while sharing is on.
- **Browser screen sharing + Screen Vision** — click **Share Screen**
  (bottom-left) and pick your entire screen, an application window, or a
  browser tab from the browser's own picker (in the SERA desktop app, a
  native SERA picker lists your screens and application windows). A floating
  glass dock shows a
  live preview, a pulsing SHARING indicator, and full controls (pause,
  resume, switch source, stop). With Screen Vision on, SERA sees your
  screen through Gemini in real time — ask "what's on my screen?", "what
  website am I on?", "explain this code", "summarize this page", "analyze
  my YouTube analytics" by voice or text. Frames only leave your machine
  while sharing, static screens cost nothing, and the share survives
  session reconnects.
- **Screen OCR (ultra-precise reading)** — every few seconds the server
  also runs Tesseract OCR on the shared frame and hands the model the
  exact visible text next to the image, so URLs, code identifiers, error
  messages, and numbers are read precisely, not guessed. In Local Mode
  this doubles as text-only vision: SERA can read your screen's text even
  with Ollama, which cannot see images. The re-scan cadence is yours to
  choose: the share dock's `OCR EVERY [−] 8s [+]` stepper (2s–60s) changes
  it live mid-share and remembers the preference for next time.
- **Screen Memory ("remember what was on my screen")** — every distinct
  screen state is distilled into a bounded per-user digest log, so
  "what was on my screen earlier?" and "remember the page I was showing
  you?" work during and after the share. When a share ends, a summary is
  persisted into SERA's long-term memory (with the same secret filter
  that refuses to store anything password-shaped), so screen context
  survives restarts.
- **Multi-model orchestration** — every request is classified (task type,
  privacy, required capabilities) and routed to the best available brain:
  local Ollama first, then documented free-tier APIs, then paid APIs only if
  you explicitly unlock them. Paid routing is off by default.
- **Mistake learning** — tool failures are recorded and turned into pre-flight
  fixes, so repeated tasks get more reliable over time.
- **Persistent memory** — hybrid semantic recall (keywords + embeddings)
  survives restarts.
- **61-check diagnostics** — a built-in doctor that probes every subsystem,
  explains why something is broken, and auto-repairs what it safely can.
- **Wake word** — hands-free "Hey Sera" with an always-honest status chip that
  says exactly why the listener is off when it is off.

## Requirements

- **Node.js 22 or newer** (LTS recommended) — <https://nodejs.org/en/download>
- **Windows 10/11** for the full experience (primary platform). macOS and
  Linux work for local development and Local Mode; some desktop-shell and
  speech-bridge features are Windows-specific.
- **Ollama** for Local Mode — <https://ollama.com/download>
- A **Gemini API key** only if you want Online Mode — <https://aistudio.google.com/apikey>
- For Local Mode with 7B-class models: ~8 GB RAM, or any CUDA GPU. The
  launcher audits your hardware and recommends a model that fits.

## Quick start

**Windows**

1. Install Node.js 22+ if you do not have it.
2. Double-click `Start SERA.bat`.
3. On first launch, pick **Local Mode** (guided Ollama setup) or **Online
   Mode** (paste a Gemini API key).

If Windows blocks the launcher (Smart App Control has no "Run anyway"
button), see [Troubleshooting](#troubleshooting) for the SAC-proof path:
open a terminal in the SERA folder and run `npm start`.

**macOS / Linux**

```bash
bash scripts/start-sera.sh
```

**Any platform, from a terminal**

```bash
npm start    # runs scripts/launcher.mjs — the same flow as the .bat file
```

When SERA is running you get two windows: the minimized **SERA Server**
console (the AI brain — closing it stops SERA) and the **SERA desktop
window** (the assistant, powered by the bundled Electron shell). If SERA ever
opens in a browser tab instead, click the **Install SERA** icon in the
address bar to get a real desktop app window.

### What the launcher does

| Step | What happens | When |
|---|---|---|
| 0 | Removes Windows download-block flags from the folder (Silent when clean) | every launch |
| 1 | Checks Node.js; opens the installer page if missing | every launch |
| 2 | Detects an already-running server and verifies its version, so a stale server can never serve the old app | every launch |
| 3 | Installs dependencies (includes the automation browser) | first run only |
| 4 | Builds the production bundle | first run only |
| 5 | Starts the SERA server in its own window | every launch |
| 6 | Waits for the health check, then opens the SERA desktop window; on Windows it also creates a `Start SERA` desktop icon (opt out with `SERA_NO_SHORTCUT=1`) | every launch |
| 7 | Repairs a missing Electron shell, or falls back to a standalone Edge/Chrome app window — never a plain browser tab | only if needed |

## Local Mode (fully offline)

1. Install **Ollama** from <https://ollama.com/download> (the Windows
   installer runs it as a background service).
2. Launch SERA. Detection covers PATH, the default Windows install
   locations, and a live probe of the local daemon.
3. The startup launcher audits your hardware (GPU / VRAM / CUDA / RAM),
   recommends the best-fitting model (for example
   `qwen2.5:7b-instruct-q4_K_M` for a 6 GB VRAM laptop), and installs it
   with a live progress bar.
4. Press the mic or type. SERA now listens, thinks, and speaks without an
   internet connection.

If something in Local Mode is missing, SERA says exactly what (for example:
install Ollama, start it, pull a model) instead of failing silently. The
recommendation and installed-model management stay available any time under
**Settings → MY PC**.

## Online Mode

Add a Gemini API key either way — both are encrypted at rest (AES-256-GCM):

- In the app: **Settings → API Keys** (paste, then instant-test), or
- In `.env`: copy `.env.example` to `.env` and set `GEMINI_API_KEY`.

Flip the **Local ⇄ Online** toggle in the header at any time, even
mid-conversation; the session hot-restarts on the new engine.

| | Local Mode (default) | Online Mode |
|---|---|---|
| Brain | Ollama on your GPU/CPU | Gemini Live |
| Voice | whisper.cpp / browser / system speech + Piper TTS | Real-time bidirectional audio |
| Cost | Free | API usage |
| Privacy | On-device | Cloud APIs |
| Tools | Full 36-tool suite | Full 36-tool suite |

## Configuration

All configuration is optional; sensible defaults apply.

- **API keys** — runtime and encrypted: Settings → API Keys. Or set
  environment variables: `GEMINI_API_KEY`, `OPENAI_API_KEY`,
  `DEEPSEEK_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`. Env vars take
  priority over the vault.
- **Server** — `PORT` (default 3000), `SERA_BIND_HOST` (default `127.0.0.1`;
  keep it localhost-only), `APP_URL`.
- **Local Mode** — `OLLAMA_BASE_URL`, `SERA_LOCAL_MODEL`,
  `SERA_HOME` (persistent engine home, default `~/.sera`),
  `SERA_MEMORY_FILE` (memory store location).
- **Speech engines** — `SERA_WHISPER_BIN`, `SERA_WHISPER_MODEL`,
  `SERA_PIPER_BIN`, `SERA_PIPER_VOICE` (auto-detected if on PATH).
- **Networks with DNS hijacking or proxies** — `HTTPS_PROXY` / `NO_PROXY`;
  see `.env.example` for the full annotated list.

Server-side memories persist in `.data/sera_memories.json` across restarts;
the file is gitignored because it is personal data.

## Usage examples

Things you can say or type once SERA is running:

| You say | What happens |
|---|---|
| "Hey Sera" (or "Sera" / "wake up") | Wakes the assistant hands-free; the status chip shows listener state |
| "Open YouTube" | Opens your real default browser visibly (Local Mode runs it as an offline quick-command) |
| "See my screen" | Starts live screen share — SERA watches continuously and reacts as things change |
| *(click)* Share Screen → pick Screen / Window / Tab | Browser screen share starts; with Screen Vision on, SERA sees the picked surface in real time |
| "What is on my screen?" / "What website am I on?" / "Explain this code" / "Summarize this page" / "Analyze my YouTube analytics" | SERA answers from the live screen frames while you're sharing |
| "Type 5+5 into Calculator" | Opens and focuses the app, types, then verifies the result on screen via OCR |
| "Read this page" / "summarize this site" | Drives the managed browser and extracts the content |
| "Copy this to the clipboard" | Clipboard writes run only when your own words ask for them |
| "Full quit" / "bye sera" / "stop listening" | FULLY silent — session, mic meter, and wake listener all off until you click or type |

Keyboard and touch: while SERA speaks, speaking (or tapping) interrupts
instantly (barge-in).

## Architecture

```
electron/          # Desktop shell (sandboxed renderer, CSP, CDP hardening,
                   #   native screen picker for Share Screen)
src/
├── audio/         # Capture, zero-gap playback, resampling, VAD, wake word
├── gemini/        # LiveSession — Online Mode WebSocket bridge
├── local/         # Ollama client, hardware inspector, model recommender,
│                  #   AES-256-GCM key vault, local agent engine (tool loop)
├── agi/           # GoalPlanner → ExecutionGraph → PerceptionEngine
├── learning/      # Mistake memory + ErrorReflectionEngine (pre-flight fixes)
├── memory/        # Hybrid semantic recall (keywords + embeddings)
├── tools/         # 36-tool registry, validation, permission tiers
├── actions/       # Keyboard / mouse / app / window / screen executors
├── vision/        # OCR, screen understanding, live screen-share feed,
│                  #   browser screen-share capture + vision channel client
├── server/        # Server-side screen intelligence + hardening:
│                  #   screenVision (frame registry + Gemini injection),
│                  #   screenOcr (Tesseract engine + distillation),
│                  #   screenMemory (bounded digest log), security, rateLimit
├── speakers/      # Speaker recognition + conversation routing
├── diagnostics/   # 61-check system doctor + AutoRepairEngine
└── components/    # React UI (launcher, chat, orb, share dock, settings)
server.ts          # Express + WebSocket host — provider routing, REST API
Start SERA.bat     # Double-click launcher (Windows)
scripts/           # start-sera.sh, setup-ocr.mjs, launcher.mjs
```

The screen-intelligence pipeline in one picture:

```
Browser getDisplayMedia (screen / window / tab picker)
        → perceptual dedup + JPEG compression (only changed frames, ≤160 KB)
        → /api/screen-vision WebSocket (reconnect-proof, frame queue)
        → ScreenVisionRegistry ring buffer
             ├─ frames injected into the live Gemini session (Screen Vision)
             ├─ Tesseract OCR every N seconds (user-tuned, server-clamped)
             │     → distilled text rides next to the frame (exact strings)
             │     → Local Mode: text-only vision for image-blind Ollama
             └─ ScreenMemory digest log (Jaccard-deduped)
                   → "what was on my screen earlier?" — during AND after
                   → share-end summary persisted to long-term memory
```

Multi-model routing in one picture:

```
request → TaskClassifier (task type · privacy · required capabilities)
        → ModelRouter    (scores every enabled provider: capability match,
                          latency, reliability, context fit, FREE-FIRST
                          tier bonus, cost penalty)
        → best brain executes
        → on failure: classify (rate limit? bad key? timeout? model gone?)
                      → next provider automatically → telemetry recorded
```

Privacy-aware routing: requests that look like passwords, keys, or personal
data are classified private and go to local models only unless you explicitly
mark a cloud provider trusted for private content. Paid providers are
hard-locked off until you flip *Allow paid providers* in Settings → Models;
budget caps in `CostController` stop spending automatically even then.
Settings → Models also explains every routing decision, and the REST API
exposes `POST /api/orchestrator/route` (decision + rationale, no execution),
`POST /api/orchestrator/chat` (routed generation with fallback), and
`GET /api/orchestrator/audit` (hardware-based model recommendations).

## Development

```bash
git clone https://github.com/beku16/sera.git
cd sera
npm install          # installs dependencies; also downloads Playwright Chromium
npm run dev          # dev server with hot reload at http://localhost:3000
```

| Command | What it does |
|---|---|
| `npm run dev` | Express + WebSocket server with TSX hot execution |
| `npm run lint` | TypeScript strict check (`tsc --noEmit`) — must be clean |
| `npm test` | Full Vitest suite (unit + integration) |
| `npm run build` | Vite frontend bundle + esbuild server bundle → `dist/` |
| `npm start` | Launcher: build if needed, start the production server, open the desktop window |
| `npm run serve` | Run the already-built `dist/server.cjs` directly |
| `npm run desktop:dev` | Electron desktop shell in dev mode |
| `npm run setup:ocr` | Manually download the Tesseract `eng` OCR model (normally auto-installed on first boot) |

Continuous integration runs the same gate (`lint`, `test`, `build`) on Node
22 and 24 for every push and pull request — see
[.github/workflows/ci.yml](.github/workflows/ci.yml).

## Troubleshooting

Open the shield icon in the header → **Run full scan**. The 61-check deep
scan covers every subsystem: API key vault, network reachability (a 5-stage
ladder that works around VPN/DNS hijacks), audio pipeline, browser
automation, native modules, Local Mode brain, orchestrator, speech engines,
the Electron desktop host, and every shipped feature. Each failure comes
with concrete fix steps, and the auto-repair engine applies what it can.

Common fixes:

| Symptom | Fix |
|---|---|
| **Windows blocks `Start SERA.bat`** (Smart App Control) | Use the SAC-proof path below |
| **SERA opens in a Chrome tab instead of the desktop window** | The Electron shell was not downloaded during install. Run `Start SERA.bat` once more with internet — it repairs the shell (1–3 min). If that fails it opens a standalone Edge/Chrome app window (`--app` mode). You can also click **Install SERA** in the address bar |
| **`git pull` says local changes would be overwritten** | npm rewrote the lockfile on your machine. One-time fix: `git stash` then `git pull`. The launcher restores the lockfile automatically after installs since v1.6.1 |
| **"Open YouTube" / "search X" does nothing on screen** | Fixed in v1.6.2: websites open visibly in your real default browser. Local Mode also runs offline quick-commands. Update: `git stash` + `git pull`, then `npm start` |
| **SERA reconnects every ~7-8 minutes** | Google closes Live sessions at a hard ~7-10 min limit. Reconnects are silent since v1.6.4 and resume the same conversation since v1.6.5 |
| **"See my screen" → silence, then stuck on connecting** | Fixed across v1.6.9 and v1.6.10: oversized images no longer reach the wire (everything is JPEG-encoded at a hard cap), and "see my screen" is now a real live feed. Update and rebuild |
| **"Open YouTube" opens TWO tabs** | Fixed in v1.6.9 |
| **`sera-clip-probe-…` strings in Win+V clipboard history** | Fixed for good in v1.6.9: diagnostics are 100% read-only on every path. Remove the old entries once; they stay gone |
| **Wake word works in Chrome but not in the desktop app** | v1.6.9 added SAPI → browser speech fallback and an honest status chip. If the chip says ENGINE ERROR, hover it — Windows speech voices are missing: Settings → Time & Language → Speech → Add voices |
| **`npm run setup:ocr` / `pip install piper-tts` after every update?** | Not since v1.6.9: the server auto-installs both in the background on first boot (`[AUTO-SETUP]` log lines) into `~/.sera`, which survives updates |
| **SERA keeps interrupting / won't stay quiet** | Say **"full quit"**, **"bye sera"**, **"go to sleep"**, or **"stop listening"** — full sleep until you click WAKE UP or type. Voice greetings are off by default (Settings → PERSONA) |
| **Chat area won't scroll / tools flood the chat** | Fixed in v1.6.5: conversations only in the stream; tool executions live in the compact **TOOL ACTIVITY** pill (or FULL HISTORY → TOOLS) |
| **No answer in Online Mode** | Run the diagnostics scan; if it reports DNS issues, enable DNS-over-HTTPS in Windows for 1.1.1.1/8.8.8.8, then `ipconfig /flushdns` |
| **"Ollama not detected"** | Install/launch Ollama, then **Check again** in the launcher. Detection covers PATH, default install locations, and a live daemon probe |
| **Model download stalls** | Check disk space and retry; the progress bar streams real status from Ollama |
| **"This browser cannot capture the screen"** when clicking Share Screen | You are in a browser without display-capture support (mobile browsers, some in-app webviews). Use the SERA desktop app — whose native picker arrived in v1.8.3 — or desktop Chrome/Edge/Firefox on `localhost` |
| **Port 3000 busy** | Set `PORT=3001` before launching, or stop the old "SERA Server" window |
| **"installed" but no model exists** | Fixed in v1.6.7: "installed" only appears after Ollama itself confirms the model; errors show verbatim with real MB counters |
| **Hear yourself while setting up the mic** | v1.6.7: Settings → MIC & SPEAKERS → **LET ME HEAR (LIVE)** — real-time monitoring. Use headphones to avoid feedback |
| **Wake word off and you don't know why** | The bottom-left chip always tells the truth: `WAKE · "HEY SERA"` or the exact reason (OFF IN SETTINGS / FULL SLEEP / SESSION LIVE / MIC BLOCKED / NO INTERNET / MIC BUSY / ENGINE ERROR). Hover for the fix |
| **Local Mode mic doesn't work** | v1.6.6: Local Mode streams your mic into the offline whisper engine (PCM capture + VAD → server transcription). Check Settings → MY PC → Local engine status, and mic permissions under Settings → AUDIO |
| **Random clipboard content after SERA starts** | Fixed in v1.6.6: keyboard presses and clipboard writes execute only when your own words ask for them; hallucinated shortcuts are blocked and logged |
| **SERA never hears you (desktop app)** | Windows Settings → Privacy & security → Microphone: allow microphone access for desktop apps. Confirm the default recording device. The SAPI worker self-restarts up to 4 times; the console prints the exact error |
| **Screen capture fails on Node 24** | robotjs buffer allocation can fail on Node 24; SERA falls back to a PowerShell capture automatically. Re-run diagnostics and read the combined error if both paths fail |
| **Diagnostics flags `APP_URL` placeholder** | Set `APP_URL=http://localhost:3000` in `.env` |

### Windows blocked the launcher

Two different Windows guards, two different fixes:

- **SmartScreen / Mark-of-the-Web** ("Windows protected your PC" with a
  *Run anyway* button): `Start SERA.bat` strips the block flag from the
  folder on every launch. The only prompt left is the one-time dialog on the
  very first double-click (**More info → Run anyway**).
- **Smart App Control** (blocks with **no** "Run anyway" button): SAC vetoes
  any unsigned script from an unknown source — by design, and no launcher
  trick can bypass it. Do not disable SAC. Use the SAC-proof path:

  1. Open the SERA folder in Explorer.
  2. Click the address bar, type `cmd`, press **Enter**.
  3. Type `npm start` and press **Enter**.

  `npm start` runs the full launcher (`scripts/launcher.mjs`) through npm and
  node — both signed programs — so SAC never objects. After the first
  success, the launcher drops a **Start SERA** desktop icon that runs the
  same path, so double-clicking works from then on. (Opt out with
  `SERA_NO_SHORTCUT=1` before `npm start`.)

Disabling SAC is possible but permanent (re-enabling requires a Windows
reset) — and unnecessary with the shortcut above.

## Security

- API keys are AES-256-GCM encrypted on disk, masked in the UI, never sent
  to the browser.
- The server binds to `127.0.0.1` by design — do not port-forward it.
- The Electron renderer is sandboxed with a strict CSP; CDP debugging is off
  unless explicitly enabled.
- Computer-control tools are capability-gated and auto-granted only in
  desktop sessions you launched.

See [SECURITY.md](SECURITY.md) for the full trust model and how to report
vulnerabilities.

## Contributing

Pull requests are welcome — read [CONTRIBUTING.md](CONTRIBUTING.md) first.
`npm run lint` and `npm test` must pass, and behavior changes need
regression tests. CI enforces the same gate on Node 22 and 24.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE).
