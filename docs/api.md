# HTTP API (v2)

All requests are `POST /local-plugins-api/<action>` with a JSON object body and `Content-Type: application/json`.
Responses are JSON. This is the contract the bundled web client uses; `apiVersion` in `state` is **2**.

```jsonc
// success
{ "ok": true,  "value": { … } }
// every error, from every route
{ "ok": false, "error": { "code": "BUSY", "message": "human readable, says what is safe and what to do", "details": { … } } }
```

## Authentication and request rules

| Rule | Behaviour |
|---|---|
| Authentication | Every request goes through dsh's own `connection.requestRejection(req)` (cookie/token + Host/Origin fence). `401 UNAUTHORIZED` / `403 FORBIDDEN` on refusal. |
| Fail closed | If dsh's check is not available, **nothing is served**: `503 UNAVAILABLE`. |
| Method | `POST` only (`405 METHOD_NOT_ALLOWED`). Unknown action: `404 NOT_FOUND`. |
| Content type | Must be `application/json` (`415 UNSUPPORTED_MEDIA_TYPE`) — a cross-site `<form>` cannot send it. |
| Body | A JSON object, at most 1 MB (`400 INVALID_INPUT`, `413 BODY_TOO_LARGE`). |

## Two kinds of action

**Direct** actions answer immediately with their `value`.

**Background** actions start an operation and answer `{ "opId": <n> }`. Only one runs at a time; a second request while one runs gets `409 BUSY` (nothing was started; `details.running` says what is running). Poll `op` (or `state`) for progress. Operations are kept (last 20) and stay queryable after failure.

## Direct actions

| Action | Body | `value` |
|---|---|---|
| `state` | — | `{ apiVersion, bootId, env, restartNeeded, upgrade, op, lastOp, plugins[], quarantine, settings, notices[], issues[], registryError? }`. Each plugin carries `status { id, label, primary, allowed[], invalid[] }` and `git { local, upstream, deployed, uncommitted, notApplied, … }`. A damaged registry is reported as `registryError` instead of an HTTP error. |
| `installed` | — | `{ profile[], core[] }` — plugins that could be migrated. |
| `commits` | `{ name }` | `{ commits[] }` newest first (for "deploy older commit"). |
| `agentDraft` | `{ name, mode?: "work"\|"conflict"\|"crash" }` | `{ path, text }` — a prefilled, unsent agent prompt. |
| `op` | `{ id }` | the operation (`status`, `log`, `error`, `errorCode`, `needsTrust`, `request`, `durationMs`). |
| `history` | — | `{ operations[] }` newest first (no logs inline; `op` returns one with its log) |
| `diskUsage` | — | `{ plugins{ name: { repo, snapshots, snapshotCount, worktrees, backups, total } }, trash, total }` (measured on demand) |
| `cleanupPreview` | — | `{ executed:false, snapshots[ { kind: snapshot\|worktree, name, bytes, plugin? } ], bytes }` — what `cleanup` would remove |
| `setSettings` | `{ keepSnapshots }` | `{ keepSnapshots }` (1–20; `state.effectiveSettings` shows the value in force and whether `LPM_KEEP_SNAPSHOTS` overrides it) |
| `dismissNotice` | `{ id }` | `{ dismissed }` |
| `restart` | — | `{ restarting, port }`; `409 BUSY` while an operation runs. |

## Background actions

| Action | Body | Notes |
|---|---|---|
| `migrate` | `{ name, origin?: "auto"\|"npm"\|"git" }` | Track an installed plugin (captures hand edits). |
| `add` | `{ input }` | npm: `name`, `name@1.2.3`, `name@tag`. Git: URL, `github:u/r`, `git@host:u/r`, each optionally `#tag`, `#branch` or `#commit` (pinned). |
| `check` | `{ names? }` | Look for updates; read-only. |
| `update` | `{ name, allowScripts?, alwaysAllow? }` | Merge the origin into `local` in a separate worktree. Result `merged`, `conflict` or `up-to-date`. |
| `finish` / `abort` | `{ name, … }` | Complete or discard a conflicted update. |
| `apply` | `{ name, ref?, allowScripts?, alwaysAllow? }` | Deploy a commit (default: `local`). Repeating it is a no-op (`value.noop`). |
| `restore` | `{ name }` | Reinstall the original (its exact original spec). Repeating it is a no-op. |
| `commit` | `{ name, message? }` | Commit the working tree on `local`. |
| `setDep` | `{ name, dep, range }` | `range: null` removes the override. |
| `trust` | `{ name, trust }` | Grant/revoke "always allow scripts". |
| `delete` | `{ name, confirmName }` | Stop tracking a plugin: its repo moves to `.trash/`. Needs the exact name typed back; refused while applied (`NOT_UNLINKED`) or mid-update. |
| `cleanup` | `{ execute? }` | Remove snapshots beyond retention and leftover trial-merge folders (preview with `cleanupPreview`). Never the live one or the rollback target. |
| `repair` | — | Recover interrupted operations, sweep stale files, reconcile registry ↔ disk ↔ git. Safe to repeat. |
| `reapplyAll` | — | After a dsh upgrade: check, merge clean updates, re-link. |

## Plugin states and what is allowed

`TRACKED`, `APPLIED`, `CHANGES_PENDING`, `UPDATE_AVAILABLE`, `CONFLICT`, `LINK_LOST`, `REAPPLY_REQUIRED`, `BROKEN`, `DISABLED`.
An action that is not legal in the current state is refused with `409 INVALID_STATE_<STATE>` and `details { state, action, allowed[] }` — the transition table is documented in `lib/status.js`.

## Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHORIZED`, `FORBIDDEN`, `UNAVAILABLE` | 401 / 403 / 503 | authentication |
| `NOT_FOUND`, `METHOD_NOT_ALLOWED`, `UNSUPPORTED_MEDIA_TYPE`, `BODY_TOO_LARGE`, `INVALID_INPUT` | 404 / 405 / 415 / 413 / 400 | malformed request |
| `BUSY` | 409 | another operation is running (`details.running`) |
| `INVALID_STATE_*` | 409 | not legal in this state |
| `NEEDS_PERMISSION` | 409 | scripts need your approval (`details.needsTrust[]`); retry with `allowScripts` or `alwaysAllow` |
| `PACKAGE_RENAMED`, `INCOMPATIBLE_MANIFEST`, `BAD_PACKAGE` | 409 / 409 / 400 | the package itself is unusable (nothing changed) |
| `GIT_REF_NOT_FOUND`, `GIT_TAG_DELETED`, `GIT_BRANCH_DELETED`, `ORIGIN_UNREACHABLE` | 400 / — | git origin problems (recorded on the plugin's `update.error`) |
| `NPM_PACKAGE_NOT_FOUND`, `NPM_VERSION_NOT_FOUND`, `NPM_UNREACHABLE`, `NPM_ACCESS_DENIED`, `NPM_BAD_METADATA`, `NPM_LOOKUP_FAILED` | 502 | npm problems |
| `UNSAFE_ARCHIVE` | 400 | a package tarball tried to escape its folder |
| `REGISTRY_CORRUPT`, `REGISTRY_INVALID`, `REGISTRY_TOO_NEW`, `REGISTRY_UNREADABLE` | 500 | registry problems (see `state.registryError`) |
| `COMMAND_FAILED`, `COMMAND_TIMEOUT`, `INTERNAL_ERROR` | 500 | a command failed / timed out / unexpected |

Messages follow one rule: say **what happened**, whether **the current deployment is safe**, and **what to do next**.
