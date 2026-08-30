#!/usr/bin/env bash
# SERA launcher for macOS / Linux — same flow as "Start SERA.bat" on Windows.
# Usage: bash scripts/start-sera.sh   (or make it executable and double-click)
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"
APP_VERSION="1.6.10"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}[ok]${NC} $1"; }
step() { echo -e "  ${CYAN}[..]${NC} $1"; }
fail() { echo -e "  ${RED}[X]${NC} $1"; }

# 0. Self-unblock (macOS): ZIPs saved by browsers carry the
#    com.apple.quarantine flag, which makes Gatekeeper block every binary
#    one by one ("cannot be opened because the developer cannot be
#    verified"). Strip it from the whole folder except node_modules
#    (npm-downloaded files are never quarantined). No-op on Linux.
if [ "$(uname -s)" = "Darwin" ] && command -v xattr >/dev/null 2>&1; then
  find . -maxdepth 1 -not -name '.' -not -name 'node_modules' \
    -exec xattr -dr com.apple.quarantine {} + >/dev/null 2>&1 || true
fi

# Locate the Electron desktop shell binary (platform-specific).
find_electron() {
  case "$(uname -s)" in
    Darwin) [ -x "$ROOT_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ] && \
              echo "$ROOT_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ;;
    *)      [ -x "$ROOT_DIR/node_modules/electron/dist/electron" ] && \
              echo "$ROOT_DIR/node_modules/electron/dist/electron" ;;
  esac
}

# Launch the SERA desktop window; returns 1 when the shell is not installed.
launch_desktop() {
  local ELECTRON_BIN
  ELECTRON_BIN="$(find_electron)"
  if [ -n "$ELECTRON_BIN" ]; then
    step "Opening the SERA desktop window..."
    SERA_USE_EXISTING_SERVER=true PORT="$PORT" "$ELECTRON_BIN" "$ROOT_DIR/electron/main.cjs" >/dev/null 2>&1 &
    return 0
  fi
  return 1
}

open_browser() {
  xdg-open "http://localhost:${PORT}" >/dev/null 2>&1 || open "http://localhost:${PORT}" >/dev/null 2>&1 || true
}

# Standalone app window (--app mode): no tabs, no address bar - looks and
# behaves like a desktop app. Tried before ever falling back to a plain tab.
open_app_window() {
  for B in microsoft-edge microsoft-edge-stable google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$B" >/dev/null 2>&1; then
      step "Opening SERA in a standalone desktop window via ${B}..."
      "$B" --app="http://localhost:${PORT}" --window-size=1440,960 >/dev/null 2>&1 &
      return 0
    fi
  done
  if [ "$(uname -s)" = "Darwin" ]; then
    for APP in "/Applications/Google Chrome.app" "/Applications/Microsoft Edge.app" "/Applications/Chromium.app"; do
      if [ -d "$APP" ]; then
        step "Opening SERA in a standalone desktop window via $(basename "$APP")..."
        open -na "$APP" --args --app="http://localhost:${PORT}" --window-size=1440,960
        return 0
      fi
    done
  fi
  return 1
}

# UI of last resort: app window first, plain browser tab only if no Chromium
# browser exists at all.
fallback_ui() {
  open_app_window || open_browser
}

echo ""
echo "  ============================================================"
echo "    S E R A   -   Local-First Voice AI Assistant"
echo "  ============================================================"
echo ""

# 1. Node.js runtime
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is not installed. Install the LTS version from https://nodejs.org and retry."
  exit 1
fi
ok "Node.js $(node --version) found."

# 2. Already running? Verify it is THIS version, then open the desktop window.
if curl --fail --silent --max-time 2 "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
  RUNNING_VERSION="$(node -e "fetch('http://localhost:${PORT}/api/health').then(r=>r.json()).then(h=>{console.log(h.version||'')}).catch(()=>{})" 2>/dev/null || true)"
  if [ "$RUNNING_VERSION" != "$APP_VERSION" ]; then
    fail "An OLD SERA server (v${RUNNING_VERSION:-unknown}) is still running on port ${PORT}."
    echo "      You updated the folder but the old server is still serving the old app."
    echo "      Fix: kill it with 'pkill -f dist/server.cjs', wait 5s, then run again."
    exit 1
  fi
  ok "SERA v${APP_VERSION} is already running on port ${PORT} — opening the desktop window."
  if ! launch_desktop; then
    ( sleep 1; fallback_ui ) &
  fi
  exit 0
fi

# 3. Dependencies
if [ ! -d node_modules ]; then
  step "First run detected — installing dependencies (one-time, 5-10 minutes)…"
  npm install
fi
ok "Dependencies installed."

# 4. Production build
if [ ! -f dist/server.cjs ]; then
  step "Building SERA…"
  npm run build || echo -e "  ${YELLOW}[i]${NC} Build failed — falling back to development mode."
fi

# 5. Start the server in the background
step "Starting the SERA server on port ${PORT}…"
if [ -f dist/server.cjs ]; then
  NODE_ENV=production PORT="$PORT" nohup node dist/server.cjs > /tmp/sera-server.log 2>&1 &
else
  PORT="$PORT" nohup npx tsx server.ts > /tmp/sera-server.log 2>&1 &
fi
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

# 6. Wait for the API, then open the desktop window (browser as fallback)
step "Waiting for SERA to come online…"
for _ in $(seq 1 90); do
  if curl --fail --silent --max-time 2 "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
    ok "SERA v${APP_VERSION} is live on http://localhost:${PORT}"
    if launch_desktop; then
      sleep 4
      if ! pgrep -f "electron/main.cjs" >/dev/null 2>&1 && ! pgrep -f "Electron.app" >/dev/null 2>&1; then
        step "Desktop window did not appear — opening a standalone app window instead."
        fallback_ui
      fi
    else
      fallback_ui
    fi
    echo ""
    echo "  SERA is running as a DESKTOP APP (server PID ${SERVER_PID}, log: /tmp/sera-server.log)."
    echo "  Look for the SERA window. Press Ctrl+C here to stop everything."
    echo ""
    wait "$SERVER_PID"
    exit 0
  fi
  sleep 1
done

fail "The server did not come up after 90 seconds. Check /tmp/sera-server.log"
exit 1
