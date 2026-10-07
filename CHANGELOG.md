# Changelog

## 0.2.1 — 2026-10-07

### Fixed
- `LICENSE` now contains the standard MIT text. The file shipped in 0.1.0 and 0.2.0 had a garbled warranty paragraph and was missing the standard limitation-of-liability clause, so GitHub could not recognise the license. The license itself (MIT, `package.json`) is unchanged.

### Added
- `screenshots.json`, so plugin storefronts can show the documentation screenshots.

## 0.2.0 — 2026-10-07

Hardening release. The architecture is unchanged: dsh only runs a commit, deployments are built aside and switched on atomically, `upstream` / `local` branches, a registry file. Everything below is about making it survive crashes, bad input and upgrades.

### Fixed
- **Restore original** reinstalls the exact original spec (`^1.4.2`, `~1.4`, `1.4.2`, a tag, a git or file spec), not `@latest`.
- A snapshot whose dependency failed to install (npm "succeeds" for a dangling `file:` link) is no longer activated.
- A release tag deleted in the origin no longer counts as "the newest release".
- Startup cleanup could remove the manager's own deployment; it now only touches unfinished snapshots of tracked plugins that nothing links to.
- Upgrading from v0.1 no longer shows every applied plugin as broken (live deployments made without a "finished" marker are adopted when provably intact).

### Added
- **Crash safety.** Every Apply/Restore/Delete is journaled; startup recovery finishes or rolls back whatever a dead process left, and sweeps stale temp files. Fault injection (`LPM_FAIL_AT=<stage>[:crash]`) is built in for tests.
- **Crash-loop protection.** If a freshly applied plugin makes dsh restart within 60 s, it is reverted: your work is saved (git stash + `lpm-rescue/*` branch), a built-in package gets its original back, a third-party plugin gets the newest upstream release that passes the load check, and if that crashes too the plugin is disabled. A popup explains what happened; "Work on it" opens an agent with the details.
- **Load check before going live**: entry files exist and every JS file parses (one process, parse only, nothing executes).
- **Script permission.** Install and build scripts are off by default; you are asked, once or always (bound to the npm publisher account / git origin).
- **Plugin states** (Not applied, Applied, Changes pending, Update available, Conflict, Link lost, Reapply required, Broken, Disabled), a transition table, and refusal of illegal actions with a reason.
- **Registry v2**: schema validation, versioned migrations (the v1 file is kept as `registry.json.v1.bak`), quarantine of bad entries, rebuild from the repos when the file is corrupt.
- **Repair installation**: reconciles registry ↔ filesystem ↔ git ↔ dsh install, repairs what is safe, reports the rest; adopts repos found on disk.
- **Git pins** (`url#tag`, `#branch`, `#commit`), **npm pins** (`name@1.2.3`, `name@tag`), readable errors for every origin failure, manifest and rename checks.
- **Delete local plugin** (repo moves to a recoverable `.trash`), **Unlink**, **disk usage**, **cleanup** with preview, **operation history**, configurable snapshot retention (`LPM_KEEP_SNAPSHOTS`), rollback target always kept.
- **API v2**: one error shape `{ code, message, details }`, JSON-only, fail-closed auth, idempotent Apply/Restore, documented in `docs/api.md`.
- Agent sessions ("Work on it", "Fix with agent") start in **Creator mode** (the `cordis` preset), falling back to Standard if a dsh has no such preset. Every agent prompt carries the same rules: work through git only, never touch `.deployed/`, the stable link, `.backup/` or the dsh install, never bypass the plugin manager, never discard changes you did not make, which commands are safe.
- Retention is a setting in the Disk usage panel; leftover trial-merge folders are reported and removed by Clean up; "Copy repo/worktree path" buttons; the operation log records the commit and snapshot each Apply produced.
- `scripts/undo.mjs`: put the originals back from a terminal when dsh cannot start.
- Docs: a use-case-first README with screenshots, plus architecture, state machine, recovery, security, API, development, troubleshooting, performance and a release checklist.
- `CONTRIBUTING.md`, `AGENTS.md` and a pull-request template (with an AI-assistance disclosure) for human and AI-agent contributors; CI on macOS (Node 26, required) and Ubuntu (Node 22 / 24 / 26, experimental).

### Changed
- **Breaking (internal API):** API errors are `{ ok: false, error: { code, message, details } }` (was a string).
- Errors say what happened, whether the current setup is safe, and what to do next.
- `rsync` is no longer required. Windows is refused with a clear message.
- Child processes run in their own process group; timeouts stop the whole tree (SIGTERM, then SIGKILL); output is capped at 8 MB per stream; secrets are redacted from every log line, error and URL.
- Registry paths are treated as untrusted; archives with escaping paths or symlinks are refused; managed folders are `0700`, files `0600`.
- Package no longer ships test scripts; `engines` is Node >= 26, `os` is macOS and Linux.

### Performance (measured, Apple M5, Node 26)
- Apply of a 3000-file plugin: 17.1 s → 0.46 s. `state()` with 20 plugins: 669 ms → 114 ms.

## 0.1.0
First version: migrate installed plugins into git repos, commit-only atomic deploys, updates from npm releases / git release tags with conflict handling, core package overrides, dependency overrides, agent sessions.
