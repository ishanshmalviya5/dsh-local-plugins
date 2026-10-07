# dsh-local-plugins

Keep the dsh plugins you have edited — third-party plugins **and** built-in `@deepseek-ai/*` packages — as ordinary git repos, run them in dsh **only as exact commits**, and update them from their origin without losing your changes.

> **dsh only ever runs a commit.** Never your working tree, never a half-merged update. A deployment is built in its own folder first and switched on by one atomic rename; if anything fails, the previous deployment is still the live one.

## Read this first

* **Some plugins run scripts on your computer, with your full access.** Install and build scripts are **off by default**. If a plugin needs them (a git plugin's `build`, or a library's `postinstall`), the plugin stops and asks: *Allow this time* or *Always allow for this plugin* (bound to the npm publisher account / git origin you approved). See [docs/security.md](docs/security.md).
* **Overriding a built-in dsh package writes inside your dsh install.** The original folder is moved to a backup and replaced by a link to your version; *Unlink* puts it back, and if dsh crashes after an Apply it is put back automatically. This needs write access to the global dsh install.
* **Restart dsh web** to load a change. The *Restart dsh web* button relaunches it with its original command line; open chats reconnect.

## What you get

* **Two branches per plugin:** `upstream` is the pristine original, `local` is your edits. An update is an ordinary git merge — done in a separate worktree, so conflicts never touch the live plugin.
* **Safe deploys:** build aside → verify (dependencies present, entry files exist, every JS file parses) → atomic switch. A failed build, install or check changes nothing. Roll back to any kept deployment in one click.
* **Crash safety:** every Apply is journaled; whatever a dead process left behind is finished or rolled back at the next start. If a freshly applied plugin makes dsh restart within 60 seconds, it is reverted, your work is saved to a git stash + rescue branch, and a popup explains it. [How recovery works](docs/recovery.md)
* **Plain states** (Applied, Changes pending, Update available, Conflict, Link lost, Reapply required, Broken, Disabled) and a primary action that follows the state. [State machine](docs/state-machine.md)
* **dsh upgrades handled:** after an upgrade resets links, plugins show *Reapply required*, never "active"; *Reapply all* is safe to repeat.
* **Origins:** npm (`name`, `name@1.2.3`, `name@tag`) and git (newest release tag, or pin `url#tag`, `#branch`, `#commit`).
* **Repair installation**, **Recent operations** (logs, durations, retry), **Disk usage** and a safe **Clean up**, **Unlink** (restore the original) and **Delete local plugin** (repo moves to a recoverable trash).
* **Agent buttons** (*Work on it*, *Fix with agent*) open a dsh session in the repo or the conflicted worktree with a prefilled, unsent prompt that treats repository text as data and forbids touching the live install.

## Install

```bash
dsh plugin --profile web add github:ishanshmalviya5/dsh-local-plugins
```

Restart dsh web. Settings → **Local Plugins** appears, plus a sidebar badge when something needs attention. After a dsh upgrade, open it and click **Reapply all**.

## Using it

1. **+ Add → Migrate** an installed plugin (your hand edits are captured as a commit) — or add from an npm name / git address.
2. Edit in the repo (`~/.dsh/local-plugins/<name>`, branch `local`), or click **Work on it** to let an agent do it.
3. **Commit.** (Apply also commits anything left uncommitted first.)
4. **Apply** — builds, checks and switches on the commit. Restart dsh web.
5. **Update** when the origin has a new release; resolve conflicts in the worktree; **Finish update**; Apply.
6. **Deploy older commit…** to roll back. **Unlink (restore original)** gives dsh its own plugin back; your repo stays tracked.

If dsh will not start, from a terminal: `node ~/.dsh/local-plugins/.deployed/dsh-local-plugins/scripts/undo.mjs --all`.

## Compatibility

| dsh-local-plugins | dsh | Node | macOS | Linux | Windows |
|---|---|---|---|---|---|
| 0.2.0 | 0.2.0-rc.2 | >= 26 | **tested** (arm64, Node 26.8) | CI only; **not verified by the maintainer** | refused with a clear message |

* Needs `git` and `npm` on `PATH`. No runtime dependencies, no `rsync`.
* `@deepseek-ai/cordis` is a peer dependency provided by dsh; this version was checked against the one shipped with dsh 0.2.0-rc.2.
* CI (`.github/workflows/ci.yml`) runs macOS + Node 26 as the required job, and Linux with Node 22/24/26 as *experimental* jobs. Nothing is claimed for a platform until its job is green.
* Upgrading from 0.1: automatic and lossless — the registry is migrated (the old file is kept as `registry.json.v1.bak`) and live deployments are adopted. See [CHANGELOG.md](CHANGELOG.md).

## Documentation

[Architecture](docs/architecture.md) · [State machine](docs/state-machine.md) · [Recovery](docs/recovery.md) · [Security](docs/security.md) · [HTTP API](docs/api.md) · [Troubleshooting](docs/troubleshooting.md) · [Performance](docs/performance.md) · [Development](docs/development.md) · [Release checklist](docs/release-checklist.md)

## Known limitations

* A plugin that crashes dsh *before* this manager loads cannot be reverted automatically — use `scripts/undo.mjs`.
* The load check proves files parse and entry files exist; it does not run the plugin.
* Updates for core packages follow the version bundled with your dsh install, not newer npm releases.
* Linux and Node versions other than 26 are untested by the maintainer; Windows is unsupported.
* The operation queue refuses a second action while one runs (`BUSY`) rather than queueing it.

## Development

`npm run check` (lint + tests + package validation), `npm run test:e2e` (isolated live dsh), `npm run bench`. See [docs/development.md](docs/development.md).

## License

MIT — see [LICENSE](LICENSE).
