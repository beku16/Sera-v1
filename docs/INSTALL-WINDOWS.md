# SERA — Windows Installation & Data Guide

Two ways to run SERA on Windows. Neither requires a terminal.

## Option A — Installer / Portable (v1.9.0+)

| Artifact | What it is |
|---|---|
| `SERA Setup.exe` | One-click installer (per-user, **no admin required**). Adds a Start Menu shortcut and an optional desktop shortcut. Uninstall via Windows *Apps & features*. |
| `SERA Portable.exe` | Single-file build. No installation, no registry entries. Run it from anywhere — a USB stick works. |

**First launch** walks you through the same startup wizard as the source
build: a live hardware audit, a recommended offline model matched to your
GPU, a one-click verified download, and the Local (offline) vs Online mode
choice. Nothing about your machine leaves it in Local Mode.

### Where your data lives (and why that matters)

Nothing you create is stored inside the app folder, so **updates and
uninstalls can never delete your data**:

| Data | Location |
|---|---|
| Memories, API-key vault (AES-256-GCM), orchestrator state | `%APPDATA%\SERA\` |
| Logs, OCR cache, downloads, tmp | `%LOCALAPPDATA%\SERA\` |
| Optional speech engines (whisper.cpp models, Piper voices) | `%USERPROFILE%\.sera\` |
| Ollama models | Ollama's own location (`%USERPROFILE%\.ollama\models`) |

**Portable caveat:** the portable build keeps the same per-user locations
above (it is not USB-roaming). If you need everything-on-a-stick, use the
source build (Option B) with `SERA_HOME` set next to the folder.

### Updating

Run the new `SERA Setup.exe` over the existing installation — the installer
replaces only program files under the install folder; everything in the
table above is untouched.

### Uninstalling / resetting

- **Uninstall the app:** Windows *Apps & features* → SERA → uninstall.
  This removes program files only.
- **Reset all SERA data (explicit choice, never automatic):** delete
  `%APPDATA%\SERA` and `%LOCALAPPDATA%\SERA`. This erases memories and
  saved API keys.
- **Remove optional engines:** delete `%USERPROFILE%\.sera`.
- **Remove downloaded models:** `ollama rm <model>` in a terminal.

## Option B — From source (double-click)

1. Download and unzip the repository ZIP.
2. Double-click **`Start SERA.bat`**.
3. The launcher handles everything: it installs Node.js and dependencies if
   missing, unblocks Windows-marked files, builds, starts the local server
   on port **43110** (falls back automatically if busy), and opens the
   desktop window (or an Edge/Chrome app-window fallback).

`Stop SERA.bat` stops only SERA's own processes — it never touches other
Electron apps or unrelated servers on the machine.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Model download says "Not enough disk space" | Free space on the drive holding `%USERPROFILE%\.ollama\models`, or `ollama rm` unused models, or pick a smaller model from the catalog. |
| "Ollama is not running" | Settings → MY PC → **START OLLAMA** (v1.9.0 one-click), or open Ollama from the Start Menu, or use Online Mode — it needs no local setup. |
| Recommended model seems gone | MY PC shows honest per-model badges (EXCELLENT FIT / PARTIAL OFFLOAD / CPU FALLBACK). Pick any installed model under MODELS ON THIS PC. |
| "It just died" / support asks for logs | Settings → MY PC → **OPEN LOG FOLDER** (`%LOCALAPPDATA%\SERA\logs`, rotating 14 days, secrets auto-redacted). |
| Selected model vanished after an update | SERA tells you in-chat with REINSTALL / CHOOSE ANOTHER / SYSTEM CHECK options — it never silently swaps models. |
| Port 43110 busy | Nothing to do — SERA falls back to a free port automatically and the window follows it. |

## Security notes

- The backend binds to `127.0.0.1` only, validates Host/Origin on every
  HTTP + WebSocket request (DNS-rebinding and cross-site-WS defense), and
  can require a shared token via `SERA_AUTH_TOKEN`.
- API keys are encrypted at rest (AES-256-GCM, per-machine key file) and
  redacted from every log line.
