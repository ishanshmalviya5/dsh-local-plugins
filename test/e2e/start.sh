#!/usr/bin/env bash
# (Re)start the isolated test dsh web on :3091 (DSH_HOME=~/.dsh-test/home,
# profile lpm-test, npm fixtures enabled). Prints the token URL.
set -euo pipefail
T="$HOME/.dsh-test"
PORT=3091
pids="$(lsof -ti tcp:$PORT -sTCP:LISTEN || true)"
if [ -n "$pids" ]; then kill $pids; for _ in $(seq 1 50); do lsof -ti tcp:$PORT -sTCP:LISTEN >/dev/null || break; sleep 0.2; done; fi
: > "$T/dsh-web.log"
( cd "$T" && DSH_HOME="$T/home" LPM_NPM_FIXTURES="$T/fixtures/npm" nohup "$T/npm/node_modules/.bin/dsh" --profile lpm-test --port $PORT --no-open >> "$T/dsh-web.log" 2>&1 & )
for _ in $(seq 1 60); do grep -q "dsh web:" "$T/dsh-web.log" && break; sleep 1; done
grep "dsh web:" "$T/dsh-web.log" | tail -1
