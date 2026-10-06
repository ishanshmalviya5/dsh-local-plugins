# dsh-local-plugins

A dsh plugin that keeps edited dsh plugins — both profile (third-party) plugins and core `@deepseek-ai/*` packages — as local git repos, deploys only committed snapshots through an atomic symlink swap, and updates from their origin (npm releases or git release tags) in a separate worktree with conflict handling.

> **Warning — core package apply writes inside the global dsh install.** It moves the original package folder to `.backup/<pkg>@<ver>` and replaces it with a symlink to the deployed snapshot. This requires write access to the global npm install of dsh. After a dsh upgrade, use **Reapply all** to restore links.

> **Warning — "Restart dsh web" relaunches the dsh process** with its original command line. Open chats will reconnect after the restart completes.

## What it does

- Keeps each plugin as a local git repo (`$DSH_HOME/local-plugins/<name>`; scoped names become `@scope__pkg`).
- `upstream` branch = pristine original; `local` branch = your edits.
- **Commit-only deploy:** uncommitted edits are auto-committed first; Apply deploys the chosen commit from `local` (or an older rollback commit) through a detached worktree `.deployed/<name>@<sha>`; only if the build succeeds is `.deployed/<name>` swapped atomically.
- Keeps the 3 most recent snapshots (`KEEP_SNAPSHOTS = 3`); older ones are pruned.
- Updates: checked 5 s after startup and by the "Check now" button. Merges run in a separate worktree (`.work/<name>`) so the live plugin never sees a half-merged tree. Conflicts list the files and offer **Finish update**, **Abort**, or **Fix with agent**.
- Agent buttons ("Work on it", "Fix with agent") create a dsh session in the repo or worktree with the `standard` agent preset and a prefilled, unsent draft.
- Dependency overrides (e.g. pin a transitive dep to `latest`) are committed on `local` and take effect on Apply.

## Requirements

- `git`, `npm`, `rsync` on `PATH`.
- Write access to the global dsh install (only for core `@deepseek-ai/*` package overrides).
- Tested on: macOS with dsh 0.2.0-rc.2 and Node 26.
- Linux is plausible but **untested**. Windows is **not supported** (symlink + rsync dependency).

## Install

```bash
dsh plugin --profile web add github:ishanshmalviya5/dsh-local-plugins
```

Then restart dsh web (either through the app or via the "Restart dsh web" button in Settings → Local Plugins).

After a dsh upgrade, open Settings → Local Plugins and click **Reapply all**.

## Usage walkthrough

1. **Migrate an installed plugin** (or **New from origin** with an npm name / git URL).
2. Edit in the repo (`~/.dsh/local-plugins/<name>`): the `local` branch holds your edits.
3. **Commit** your changes.
4. **Apply** to deploy the commit atomically.
5. **Restart dsh web** to load the deployed snapshot (required after Apply/Restore).
6. **Update**: click "Check now" or wait for the automatic check; merge conflicts are resolved in the worktree; click **Finish update** (only when no conflict markers remain), then **Apply**.
7. **Rollback**: "Deploy older commit…" picks one of the 3 kept snapshots.
8. **Restore original**: the repo stays tracked — **Apply** switches back to your edited version.

The commit-only rule: the working tree is never deployed directly; only committed snapshots reach `.deployed/`.

## Tests

```bash
npm test        # 14 unit tests (node:test, temp dirs, no dsh needed)
```

End-to-end (isolated dsh copy at `~/.dsh-test`, port 3091):

```bash
test/e2e/setup.sh
node test/e2e/api-scenarios.mjs   # 13 end-to-end scenarios
```

## Development

`npm install && npm run build` rebuilds `client/client.js` (committed bundle; required for git installs).

`scripts/self-deploy.sh` is a maintainer tool for running the manager itself commit-only; it is not the normal install method.

## License

MIT — see [LICENSE](LICENSE).
