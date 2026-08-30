#!/usr/bin/env bash
# P5 packaged-mode smoke test (runnable on Linux against the PRODUCTION bundle)
# Verifies: port default + handshake marker + EADDRINUSE fallback, health,
# catalog fit grading, ollama manager states, log-folder endpoint + boot log,
# SERAPaths writable-data isolation.
set -u
cd /home/z/my-project/sera-main

export SERA_USER_DATA="$(mktemp -d)/userdata"
export SERA_LOCAL_DATA="$(mktemp -d)/localdata"
export SERA_HOME="$(mktemp -d)/serahome"
export PORT=43110

echo "-- boot dist/server.cjs (production bundle) --"
NODE_ENV=production node dist/server.cjs > /tmp/sera-smoke.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

for i in $(seq 1 60); do
  if grep -q "SERA_LISTENING_PORT=" /tmp/sera-smoke.log 2>/dev/null; then break; fi
  sleep 0.5
done

PORT_LINE=$(grep -o 'SERA_LISTENING_PORT=[0-9]*' /tmp/sera-smoke.log | head -1)
PORT_ACTUAL=${PORT_LINE##*=}
echo "stdout marker: $PORT_LINE"
if [ -z "$PORT_ACTUAL" ]; then echo "FAIL: no port marker"; tail -30 /tmp/sera-smoke.log; exit 1; fi

HANDSHAKE_FILE="$SERA_HOME/sera.port"
if [ "$(cat "$HANDSHAKE_FILE" 2>/dev/null)" = "$PORT_ACTUAL" ]; then
  echo "handshake file OK ($HANDSHAKE_FILE -> $PORT_ACTUAL)"
else
  echo "FAIL: handshake file mismatch: $(cat "$HANDSHAKE_FILE" 2>/dev/null)"; exit 1
fi

echo "-- /api/health --"
HEALTH=$(curl -s -m 5 "http://127.0.0.1:$PORT_ACTUAL/api/health")
echo "$HEALTH" | head -c 300; echo
echo "$HEALTH" | grep -q '"version":"1.9.0"' && echo "version 1.9.0 OK" || { echo "FAIL: version"; exit 1; }

echo "-- /api/local/catalog (fit grading) --"
CATALOG=$(curl -s -m 30 "http://127.0.0.1:$PORT_ACTUAL/api/local/catalog")
echo "$CATALOG" > /tmp/sera-catalog.json
ANALYSIS=$(python3 - /tmp/sera-catalog.json <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print("tier:", d.get("tier"), "| recommended:", d.get("recommended"), "| entries:", len(d.get("catalog",[])))
for m in d.get("catalog",[]):
    fit=m.get("fit",{})
    print("  %-42s %-14s headroom=%sMB" % (m["id"], fit.get("category","?"), fit.get("headroomMB")))
ids=[m["id"] for m in d.get("catalog",[])]
assert "qwen3:4b" in ids and "gemma3:4b" in ids and "qwen3:8b" in ids, "new catalog entries missing"
assert all("fit" in m for m in d["catalog"]), "fit grading missing"
print("catalog grading OK")
PY
)
if [ $? -ne 0 ]; then echo "FAIL: catalog"; echo "$CATALOG" | head -c 400; exit 1; fi
echo "$ANALYSIS"

echo "-- /api/local/ollama (manager state on this machine) --"
OLLAMA=$(curl -s -m 15 "http://127.0.0.1:$PORT_ACTUAL/api/local/ollama")
echo "$OLLAMA" > /tmp/sera-ollama.json
python3 - /tmp/sera-ollama.json <<'PY' || exit 1
import json,sys
d=json.load(open(sys.argv[1]))
print("state:", d.get("state"), "| owned:", d.get("ownedBySera"))
assert d.get("state") in ("ready","starting","not-installed","start-failed"), "bad state"
print("ollama manager OK")
PY

echo "-- /api/diagnostics/log-folder + structured boot log --"
LOGDIR_JSON=$(curl -s -m 5 "http://127.0.0.1:$PORT_ACTUAL/api/diagnostics/log-folder")
echo "$LOGDIR_JSON"
LOGFILE_DIR=$(echo "$LOGDIR_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["dir"])')
TODAY_LOG="$LOGFILE_DIR/sera-$(date +%F).log"
if [ -f "$TODAY_LOG" ] && grep -q '"scope":"boot"' "$TODAY_LOG"; then
  echo "boot log line OK: $TODAY_LOG"
else
  echo "FAIL: no boot log"; ls -la "$LOGFILE_DIR" 2>/dev/null; exit 1
fi

echo "-- EADDRINUSE fallback: boot a second server on the same port --"
PORT=43110 SERA_USER_DATA="$SERA_USER_DATA" SERA_LOCAL_DATA="$SERA_LOCAL_DATA" SERA_HOME="$SERA_HOME" \
  node dist/server.cjs > /tmp/sera-smoke2.log 2>&1 &
SECOND_PID=$!
for i in $(seq 1 60); do
  if grep -q "SERA_LISTENING_PORT=" /tmp/sera-smoke2.log 2>/dev/null; then break; fi
  sleep 0.5
done
PORT2_LINE=$(grep -o 'SERA_LISTENING_PORT=[0-9]*' /tmp/sera-smoke2.log | head -1)
PORT2=${PORT2_LINE##*=}
kill $SECOND_PID 2>/dev/null
if [ -n "$PORT2" ] && [ "$PORT2" != "$PORT_ACTUAL" ]; then
  echo "fallback OK: second server on $PORT2 (first holds $PORT_ACTUAL)"
else
  echo "FAIL: fallback port ($PORT2)"; tail -5 /tmp/sera-smoke2.log; exit 1
fi

echo "-- writable-data isolation --"
if [ -e "sera_memories.json" ] && [ ! -e "$SERA_USER_DATA/sera_memories.json" ]; then
  echo "FAIL: memory written to CWD"; exit 1
fi
[ -d "$SERA_USER_DATA" ] && echo "userData OK: $SERA_USER_DATA"
[ -d "$SERA_LOCAL_DATA/logs" ] && echo "logs OK: $SERA_LOCAL_DATA/logs"

echo
echo "ALL SMOKE CHECKS PASSED (Linux; Windows-specific runtime NOT TESTED ON WINDOWS per spec 76)"
