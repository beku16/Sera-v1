# Contributing to SERA

Thanks for improving SERA. This project is a local-first, real-time voice AI
assistant with a full computer-control tool suite. This guide explains how to
set up a dev environment and what a pull request needs to pass.

## Development setup

1. Install **Node.js 20+** (LTS recommended).
2. Clone your fork of this repository.
3. `npm install` — installs all dependencies. The postinstall step also
   downloads Playwright's Chromium for the managed-browser feature.
4. Copy `.env.example` to `.env` for optional server configuration. Every
   value is optional; API keys can also be added at runtime in
   **Settings → API Keys** (stored AES-256-GCM encrypted).

Windows is the primary development and testing platform. `npm run lint`,
`npm test`, and `npm run build` all run cross-platform, and CI enforces them
on Linux with Node 22 and 24.

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the Express + WebSocket server with hot TSX execution (UI at `http://localhost:3000`) |
| `npm run build` | Production build: Vite frontend bundle + esbuild server bundle (`dist/server.cjs`) |
| `npm start` | Launcher: build if needed, start the production server, open the desktop window |
| `npm test` | Run the full Vitest suite |
| `npm run lint` | TypeScript strict check (`tsc --noEmit`) |
| `npm run serve` | Run the already-built `dist/server.cjs` directly |

`npm run setup:ocr` exists for manual OCR setup, but the server auto-installs
the OCR model (and Piper) in the background on first boot, so you normally
never need it.

## Before you open a pull request

- `npm run lint` passes with 0 errors.
- `npm test` passes with 0 failures. Add or update tests for any behavior
  you change — regression tests are the backbone of this repo.
- If you changed the UI, describe what visually changed (screenshots help).
- Keep commits focused; one logical change per commit.
- Use the pull request template; it mirrors this checklist.

For bugs, use the bug report issue template and include the output of the
built-in diagnostics panel (header → shield icon → full scan) — it usually
pinpoints the failing subsystem precisely.

## Architecture quick map

- `server.ts` — Express + WebSocket host, provider routing, REST API.
- `src/local/` — Local Mode: Ollama client, hardware inspector, model
  recommender, encrypted API-key vault, local speech engines.
- `src/gemini/LiveSession.ts` — Online Mode: Gemini Live bridge.
- `src/vision/` — OCR, screen understanding, and the live screen-share feed
  (`liveScreenShare.ts` — frame capture, JPEG wire encoding, change detection).
- `src/audio/` — capture, playback, resampling, VAD, wake word.
- `src/tools/` — 36-tool registry + safe execution (`ToolManager`).
- `src/diagnostics/` — 61-check system diagnostics + auto-repair engine.
- `src/agi/`, `src/learning/`, `src/memory/` — planning, mistake learning,
  semantic memory.

## Code style

- TypeScript strict mode; avoid `any` unless justified in a comment.
- Prefer honest failures: surface *why* something failed in user-readable
  messages instead of swallowing errors.
- Comments explain *why*, not *what*.
- Add regression tests next to the fix — `src/__tests__/` mirrors the source
  layout.

## Reporting bugs and security issues

- Bugs: open an issue with the bug report template.
- Security vulnerabilities: **do not open a public issue** — follow
  [SECURITY.md](SECURITY.md).
