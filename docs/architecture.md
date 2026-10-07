# Architecture

`dsh-local-plugins` keeps plugins you have edited as ordinary git repos and puts them in front of dsh **only as exact commits**, switched on atomically.
Three rules never change:

1. **dsh only runs a commit.** Never a working tree, never a half-merged tree.
2. **Build aside, switch last.** A deployment is built in its own folder; only a finished one is made live, by one atomic rename.
3. **Nothing is destroyed.** Originals are backed up, deleted repos go to a trash folder, user work is stashed before any revert.

```
 you / agent              Local Plugins (this plugin)                         dsh
 ───────────              ───────────────────────────                         ───

 edit + commit  ──►  ~/.dsh/local-plugins/<name>/   (git repo)
                      ├─ branch upstream = pristine original (npm release / git tag)
                      └─ branch local    = your edits

 Apply ─────────────►  1. journal begins (.txn/)
                       2. snapshot: detached worktree of ONE commit
                          .deployed/<name>@<sha12>/
                       3. install deps (scripts off unless allowed) + build
                       4. verify: deps present, entry files exist, every JS file parses
                       5. mark finished  (.lpm-ready)
                       6. swap  .deployed/<name>  ->  <name>@<sha12>   (atomic rename)
                       7. link dsh to the stable link  ─────────────────────►  profile dependency
                                                                               "link:<stable>"
                          core package:  <dsh>/node_modules/@deepseek-ai/x    or the package folder
                          is moved to .backup/ and replaced by a symlink ───► symlink to the stable link
                       8. registry saved, journal closed, restart requested
```

## Where things live (`$DSH_HOME/local-plugins`, default `~/.dsh/local-plugins`)

| Path | What | Safe to delete? |
|---|---|---|
| `registry.json` (`.v1.bak`, `.corrupt-*`) | the manager's only state file, `0600` | no — but `Repair installation` can rebuild it from the repos |
| `<name>/` (`@scope__pkg/`) | the plugin's git repo (`upstream`, `local`) | **no** — this is your work |
| `.deployed/<name>@<sha12>/` | immutable snapshots (git worktrees); `.deployed/<name>` is the stable link | yes (rebuilt on demand); the live one and the rollback target are protected |
| `.work/<name>/` | trial-merge worktree during an update/conflict | only via Abort |
| `.backup/<pkg>@<ver>/` | the original of a built-in dsh package | **no** while the package is overridden |
| `.nested/` | private `node_modules` of a core package | no while overridden |
| `.txn/` | journal of operations in flight | no — recovery reads it |
| `.trash/<name>-<time>/` | repos removed with *Delete local plugin* | yes, when you are sure |
| `logs/operations.jsonl` | one redacted line per finished operation (rotates at 2 MB) | yes |

## Modules (`lib/`)

| Module | Role |
|---|---|
| `index.js` | plugin entry: platform check, startup recovery (in the single-flight queue), health timer, route registration |
| `routes.js` | the HTTP API: auth, validation, one error shape ([api.md](api.md)) |
| `actions.js` | everything the UI can ask for; orchestrates the modules below |
| `ops.js` | single-flight operation queue, logs, history, failure advice |
| `status.js` | the plugin state machine ([state-machine.md](state-machine.md)) |
| `registry.js` | schema, migrations, quarantine, rebuild, durable writes |
| `txn.js` | operation journal + fault injection |
| `recovery.js` | startup recovery, sweeps, reconciliation, rescue of user work, v0.1 adoption |
| `health.js` | crash-loop protection: probation, revert, disable |
| `deploy.js` | snapshots, load check, atomic link swap, retention |
| `link.js` | wiring dsh to a deployment (profile dependency / core package symlink) |
| `repo.js`, `git.js`, `gitstate.js` | git repos, git wrappers, the single interpretation of a repo's state |
| `sources.js` | npm and git origins, version comparison, input validation, tarball safety |
| `run.js`, `redact.js` | child processes (process groups, timeouts, capped output), secret redaction |
| `messages.js`, `platform.js` | failure advice, platform and permission messages |
| `restart.js`, `env.js`, `syntax-check.mjs` | restarting dsh web, environment discovery, one-process parse check |

## Updates

`Check now` fetches the origin (git: `--prune-tags`; npm: the version matching your spec). *Update* merges the new `upstream` into `local` in `.work/` (never in the live tree):

- clean merge → built and checked there (source-built plugins) → fast-forwards `local`. **Nothing is deployed** — Apply does that.
- conflict → stays pending (worktree + files listed); *Finish update* refuses while conflict markers remain; *Abort* throws the trial away.
- renamed package, unsupported manifest, unreachable origin → refused before anything changes.

Origins: npm (`name`, `name@1.2.3`, `name@tag`), git (newest stable release tag; `url#tag`, `#branch`, `#commit` pin it; a pinned tag/commit never moves, a pinned branch follows only itself).

## dsh upgrades

A new dsh install resets symlinks inside it. At every start the manager compares the dsh version and checks every applied plugin's link; affected plugins become **Link lost** / **Reapply required** and the registry never claims they are active. *Reapply all* checks origins, merges clean updates and re-links; one failing plugin never blocks the others, and it is safe to run repeatedly.
