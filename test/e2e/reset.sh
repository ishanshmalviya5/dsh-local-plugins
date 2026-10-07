#!/usr/bin/env bash
# Reset the isolated e2e environment to a clean state WITHOUT reinstalling dsh
# (setup.sh does the full from-scratch build). Never touches the real ~/.dsh.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
T="$HOME/.dsh-test"
DSH="$T/npm/node_modules/.bin/dsh"
[ -x "$DSH" ] || { echo "no $DSH — run test/e2e/setup.sh once first"; exit 1; }

pids="$(lsof -ti tcp:3091 -sTCP:LISTEN || true)"
if [ -n "$pids" ]; then kill $pids; sleep 2; fi
rm -rf "$T/home" "$T/fixtures" "$T/dsh-web.log"
mkdir -p "$T/home" "$T/fixtures"

echo "== profile lpm-test"
( cd "$T" && DSH_HOME="$T/home" "$DSH" --profile lpm-test --from-default-profile web --port 3091 --no-open > "$T/dsh-web.log" 2>&1 & )
for _ in $(seq 1 60); do grep -q "dsh web:" "$T/dsh-web.log" && break; sleep 1; done
kill "$(lsof -ti tcp:3091 -sTCP:LISTEN)"; sleep 1

echo "== fixtures"
node "$REPO/test/fixtures/make.mjs" init >/dev/null
DSH_HOME="$T/home" "$DSH" plugin --profile lpm-test add dsh-jev-decide >/dev/null

echo "== manager"
DSH_HOME="$T/home" "$REPO/scripts/self-deploy.sh" lpm-test HEAD "$DSH" | tail -1
"$REPO/test/e2e/start.sh"
