#!/usr/bin/env bash
# Deploy a commit of this repo as the running dsh-local-plugins (commit-only rule):
#   $DSH_HOME/local-plugins/.deployed/dsh-local-plugins@<sha12>  (detached worktree)
#   $DSH_HOME/local-plugins/.deployed/dsh-local-plugins -> that snapshot (atomic swap)
# First run also links the profile to the stable path.
# Usage: DSH_HOME=~/.dsh scripts/self-deploy.sh <profile> [ref] [dsh-bin]
set -euo pipefail
PROFILE="${1:?profile}"; REF="${2:-HEAD}"; DSH_BIN="${3:-dsh}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
DEPLOYED="$HOME_DIR/local-plugins/.deployed"
SHA="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")"
SNAP="$DEPLOYED/dsh-local-plugins@${SHA:0:12}"
STABLE="$DEPLOYED/dsh-local-plugins"

if [ -n "$(git -C "$REPO" status --porcelain)" ]; then echo "note: uncommitted changes are NOT deployed (commit-only rule)"; fi
mkdir -p "$DEPLOYED"
git -C "$REPO" worktree prune
if [ ! -d "$SNAP" ]; then git -C "$REPO" worktree add -q --detach "$SNAP" "$SHA"; fi
ln -s "$SNAP" "$STABLE.tmp.$$" && node -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$STABLE.tmp.$$" "$STABLE"
echo "live -> $(basename "$SNAP")"

PJ="$HOME_DIR/profiles/$PROFILE/package.json"
if ! grep -q "\"dsh-local-plugins\": \"link:$STABLE\"" "$PJ"; then
  DSH_HOME="$HOME_DIR" "$DSH_BIN" plugin --profile "$PROFILE" add "link:$STABLE"
fi
NM="$HOME_DIR/profiles/$PROFILE/node_modules/dsh-local-plugins"
if [ "$(readlink "$NM" || true)" != "$STABLE" ]; then rm -rf "$NM"; ln -s "$STABLE" "$NM"; fi
echo "profile $PROFILE -> $STABLE (restart dsh web to load)"
