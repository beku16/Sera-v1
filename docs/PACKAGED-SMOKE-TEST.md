# Packaged Build Smoke Test (Windows)

Run this checklist against every `release/` artifact produced by
`npm run dist:win` BEFORE publishing or sharing the build. It verifies the
v1.9.0 packaging contracts (SERAPaths, port handshake, honest Local Mode)
in about 10 minutes, with no developer tooling required.

## Artifacts under `release\`

| File | What it is |
| --- | --- |
| `SERA Setup 1.9.0.exe` | NSIS one-click installer (per-user, no admin) |
| `SERA Portable 1.9.0.exe` | Single-file portable build (no install) |

If either file is missing, the build stopped early — re-run
`npm run dist:win` and read the console output for the failed step.

## A. Installer checks (SERA Setup)

1. **Install** — double-click the Setup exe. It must finish without an
   UAC/admin prompt (per-user install). Start Menu shortcut "SERA" and a
   desktop shortcut must appear.
2. **Launch** — start SERA from the Start Menu. The app window should
   open within ~15 s on first run (OCR data self-heal may add time).
3. **Backend handshake** — while SERA runs, open
   `%APPDATA%\SERA\sera.port` in Notepad: it must exist and contain the
   port number. Then open `http://127.0.0.1:<port>/api/health` in a
   browser — it must answer JSON with `"version":"1.9.0"`. The file is
   removed again when SERA quits.
4. **Window title + icon** — taskbar and window must show the SERA icon
   (not the default Electron icon).
5. **Settings round-trip** — open Settings, paste any API key, save,
   restart SERA, reopen Settings: the key must still be there (vault lives
   under `%APPDATA%\SERA`, never in the install dir).
6. **Logs** — Settings → My PC → Troubleshooting → OPEN LOG FOLDER must
   open `%APPDATA%\SERA\logs` with a non-empty boot log.
7. **Local Mode honesty** — with Ollama NOT installed, the setup wizard
   must show the install card with the ollama.com link and Online Mode
   alternative — never a fake "ready" state. With Ollama installed but
   not running, the START OLLAMA button must appear.
8. **Uninstall** — uninstall via Windows Settings. The app must be
   removed cleanly. User data under `%APPDATA%\SERA` is INTENTIONALLY
   preserved (documented behavior; delete manually for a full reset).

## B. Portable checks (SERA Portable)

1. Copy `SERA Portable 1.9.0.exe` to a folder WITHOUT any SERA data
   (or a fresh user profile) and run it. It must boot, create
   `%APPDATA%\SERA`, and pass checks A2–A7 above.
2. Close it — the process must exit fully (check Task Manager for
   stray `SERA.exe`; owned child processes such as a SERA-started
   `ollama.exe` must be terminated too).

## C. Input-control spot check (10 seconds)

Open the chat, ask SERA to "open calculator".
- Calculator launches and comes to the foreground → pass.
- If the build console showed the robotjs rebuild warning, typing/mouse
  must STILL work (koffi SendInput fallback) — verify with a
  "type hello in notepad" style command.

## D. What a failure means

| Symptom | Likely cause |
| --- | --- |
| Window opens, then crash screen | backend bundle missing — check `resources\dist` exists in the install dir |
| Health check dead, no sera.port | port fallback failed — see `%APPDATA%\SERA\logs\boot.log` |
| Default Electron icon | icon.ico missing at build time (build resources) |
| "Model ready" with no Ollama | honest-pull regression — do not ship; file a bug |
