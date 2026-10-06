#!/usr/bin/env bash
# Stop the isolated test dsh web (:3091) and delete ~/.dsh-test entirely.
set -euo pipefail
pids="$(lsof -ti tcp:3091 -sTCP:LISTEN || true)"
[ -n "$pids" ] && kill $pids || true
rm -rf "$HOME/.dsh-test"
git -C "$(cd "$(dirname "$0")/../.." && pwd)" worktree prune
echo "test environment removed"
