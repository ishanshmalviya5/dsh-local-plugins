# Recovery

The invariant: **at every point where the process can die, you have the previous valid deployment or the new valid one, and the next start can detect and fix everything in between.**

## The journal

Every mutation that touches the live install writes `.txn/<id>.json` first, advances `phase` after each durable step, and deletes it only after the registry has been saved.
A journal entry found at start means a process died. `Repair installation` (and every start) reads it:

| Operation | Phases | If the process died after… | Recovery |
|---|---|---|---|
| **apply** | `begin → snapshot → prepared → activated → linking → (core-backup) → linked` | *begin…prepared* | nothing live changed; the unfinished snapshot is swept (it is rebuilt on the next Apply) |
| | | *activated, linking* | the stable link points at a finished snapshot; dsh still uses the old link or none; run Apply again |
| | | *core-backup* | the original package was moved to `.backup/` and nothing replaced it → **it is moved back** (dsh never stays without the package); your work is rescued first |
| | | *linked* (registry not saved) | the registry is brought up to date from the facts (link + finished snapshot) |
| **restore** | `begin → restoring → restored` | *restoring* | a core package folder that was unlinked but not yet restored is moved back from `.backup/`; a profile plugin that is still linked stays active |
| **delete** | `begin → snapshots → moving → moved` | *moving* | nothing moved; the plugin is intact |
| | | *moved* | the repo is in `.trash/`; the plugin is removed from the list and you are told where the repo is |

Also swept on every start: temp links/files of dead processes (`*.tmp-<pid>-…`), abandoned `.adding-*` downloads, unfinished snapshots of tracked plugins that nothing links to. **Never** deleted: repos, backups, stashes, branches, anything a stable link points at, anything belonging to something this plugin does not track.

## Crash loop (a freshly applied plugin makes dsh restart)

After an Apply the plugin is on *probation*. The first start afterwards runs a 60 s health timer (`LPM_HEALTH_MS`); surviving it ends probation. A second start inside that window without a clean shutdown means the new code crashed dsh:

1. your work is saved: uncommitted edits → `git stash` (`lpm rescue …`), committed work → branch `lpm-rescue/<time>`. `local` is never rewritten.
2. built-in package → the original comes back from `.backup/`. Third-party plugin → the newest upstream release that passes the load check goes live.
3. if that crashes too → the plugin is taken out of dsh (`dsh plugin remove`) and marked **DISABLED**.
4. a popup says what happened; **Work on it** opens an agent session with the stash/branch names and the rules.

This only works if the manager itself loads. If dsh cannot start at all, use the terminal:

```bash
node ~/.dsh/local-plugins/.deployed/dsh-local-plugins/scripts/undo.mjs --list
node ~/.dsh/local-plugins/.deployed/dsh-local-plugins/scripts/undo.mjs --all     # restore every original
```

## Repair installation

Safe to run any time, safe to repeat. It: tightens folder permissions, adopts repos found on disk but not listed, sweeps stale artifacts, finishes/rolls back journal entries, adopts live deployments made by v0.1 (provably the registry's commit and passing the load check), then reconciles:

| Finding | Fixed automatically? |
|---|---|
| registry says deployed `X`, live snapshot is `Y` | yes — the registry follows the facts |
| stable link missing/dangling but the finished snapshot exists | yes — re-pointed |
| stable link is a real directory/file | no — reported, never replaced |
| live snapshot has no "finished" marker and is not provably intact | no — reported |
| core package folder missing | yes if the backup exists (restored), otherwise reported |
| repo missing | no — restore it from a backup or the trash |
| backups/snapshots belonging to nothing tracked | reported only |

A **corrupt registry** is copied to `registry.json.corrupt-<time>` and rebuilt from the repos (everything comes back *not applied*; Apply re-links). A registry from a **newer** version is refused untouched.

## Rollback

*Deploy older commit…* applies any commit of `local`. The previous deployment is always kept; older ones are kept up to `settings.keepSnapshots` (default 3, `LPM_KEEP_SNAPSHOTS` overrides) and rebuilt from git if missing. A failed rollback leaves the current deployment live; repeating one is a no-op.
