#!/usr/bin/env bash
# Build the isolated e2e environment from scratch (§A of the plan):
#   ~/.dsh-test/npm      separate dsh install (same version as the real one)
#   ~/.dsh-test/home     DSH_HOME with profile lpm-test (from the web template)
#   ~/.dsh-test/fixtures fake plugins (git origins + npm tarballs)
# then deploys this repo's HEAD as the manager and starts dsh web on :3091.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
T="$HOME/.dsh-test"
VERSION="${DSH_VERSION:-$(node -p "require('$(npm root -g)/@deepseek-ai/dsh/package.json').version")}"

"$REPO/test/e2e/teardown.sh" >/dev/null 2>&1 || true
mkdir -p "$T/npm" "$T/home" "$T/fixtures"

echo "== dsh $VERSION into $T/npm"
cd "$T/npm"
printf '{"name":"dsh-test-runtime","private":true,"dependencies":{"@deepseek-ai/dsh":"%s"}}\n' "$VERSION" > package.json
npm install --no-fund --no-audit --loglevel=error
npm approve-scripts @deepseek-ai/dsh-subprocess-local koffi node-pty @google/genai protobufjs >/dev/null
npm rebuild --loglevel=error >/dev/null
DSH="$T/npm/node_modules/.bin/dsh"

echo "== profile lpm-test"
# --from-default-profile creates and boots; stop it once the URL is printed.
( cd "$T" && DSH_HOME="$T/home" "$DSH" --profile lpm-test --from-default-profile web --port 3091 --no-open > "$T/dsh-web.log" 2>&1 & )
for _ in $(seq 1 60); do grep -q "dsh web:" "$T/dsh-web.log" && break; sleep 1; done
kill "$(lsof -ti tcp:3091 -sTCP:LISTEN)"; sleep 1

echo "== fixtures"
node "$REPO/test/fixtures/make.mjs" init >/dev/null
DSH_HOME="$T/home" "$DSH" plugin --profile lpm-test add dsh-jev-decide >/dev/null

echo "== manager"
DSH_HOME="$T/home" "$REPO/scripts/self-deploy.sh" lpm-test HEAD "$DSH" | tail -1
"$REPO/test/e2e/start.sh"
