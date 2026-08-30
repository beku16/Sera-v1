# Security Policy

## Supported versions

Only the latest commit on `main` is supported. Please update before reporting
a vulnerability.

## Reporting a vulnerability

**Do not open a public issue for security problems.** Use GitHub's
"Report a vulnerability" (Security tab → Advisories) or contact the
maintainer directly. You will get a response within a few days.

## Design notes — what is trusted where

- **API keys** are stored AES-256-GCM encrypted (`sera_api_vault.enc` /
  `sera_api_vault.key`, gitignored, per-machine) and are never returned in
  plain text by any API — only masked previews.
- **The server binds to localhost.** Everything on `http://localhost:3000`
  runs on your machine; nothing is designed to be exposed to a network. Do
  not port-forward it.
- **Electron renderer is sandboxed**: `contextIsolation: true`,
  `nodeIntegration: false`, a strict Content-Security-Policy, top-level
  navigation lock, and external links forced into the user's browser.
- **CDP remote debugging** (port 9222) is only enabled when explicitly
  requested (`SERA_DEV=true` or `SERA_ENABLE_EMBEDDED_BROWSER=true`) because
  an open CDP endpoint is local RCE. It is bound to 127.0.0.1 only.
- **Computer-control tools** (keyboard, mouse, applications) are gated by a
  capability/authorization system; desktop mode auto-grants the trusted set
  only for sessions the local user launched.
- **Local Mode** (Ollama) performs inference on your machine — prompts never
  leave the device. Online Mode sends audio to the configured cloud provider.

## Known acceptable risks

- The Playwright-managed browser can drive real websites under tool control.
  Only instruct SERA with sites and actions you trust.
- Tool outputs and web content are model inputs; SERA verifies actions where
  possible but you remain responsible for irreversible operations performed
  through your machine.
