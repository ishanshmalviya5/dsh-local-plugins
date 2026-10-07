# Troubleshooting

Every failure in the UI shows **what happened**, **whether the current setup is safe**, and **what to do next**. These are the longer answers.

## A plugin won't apply
1. Open **Recent operations**, click the failed one, read the log (or *View logs* on the red panel).
2. *Permission needed* → the plugin wants to run a build or install script. Read what it lists; **Allow this time**, or **Always allow for this plugin**.
3. *load check failed* → a file does not parse or `package.json` points at a missing file. **Work on it**, fix, commit, Apply. The previous deployment stayed live.
4. *build exited 1* / *timed out* → fix the build (or retry if it was a network blip). Nothing half-built was switched on.
5. *dependency … is missing* → a dependency could not be installed (bad range, unreachable path). Check `dependencies`, or remove the override that points at it.

## A plugin's link disappeared ("Link lost" / "Reapply required")
dsh was upgraded or reinstalled and reset its links. Click **Reapply all** in the banner (safe to repeat). If a built-in package folder vanished entirely, **Repair installation** restores it from `.backup/` first.

## An update stopped on a conflict
The card lists the files and the worktree (`~/.dsh/local-plugins/.work/<name>`). Edit the files and remove the conflict markers (or use **Fix with agent**), then **Finish update**. **Abort** throws the trial merge away; your local branch is untouched either way. Nothing is deployed until you Apply.

## An update check fails
`cannot reach the origin` / `cannot reach npm` → connection or access; nothing was changed. `the pinned tag … no longer exists` → the origin deleted it; your pinned copy is unchanged. `renamed upstream` → the origin published the package under a new name; add that package separately. `unsupported manifest` → update dsh-local-plugins.

## A broken deployment
**Deploy older commit…** (rollback) applies any earlier commit. If dsh keeps restarting after an Apply, the plugin is reverted automatically (see [recovery.md](recovery.md)). If dsh cannot start at all:

```bash
node ~/.dsh/local-plugins/.deployed/dsh-local-plugins/scripts/undo.mjs --all
```

## "The plugin registry cannot be read" / corrupt registry
Click **Repair installation**: the broken file is kept as `registry.json.corrupt-<time>` and the list is rebuilt from your repos (everything comes back *not applied*; Apply re-links). A registry written by a **newer** version is refused untouched: update dsh-local-plugins, do not edit it.

## Entries "set aside" (quarantine)
An entry that failed validation (bad kind/source, or paths outside the places this plugin manages) is kept but never used. The banner says why. Fix the file by hand or delete the entry; repos are untouched either way.

## Permission errors
The plugin needs write access to `~/.dsh/local-plugins` (it makes it private, `0700`) and, for **built-in dsh packages**, to the dsh install folder (usually the global npm `node_modules`). If dsh was installed with `sudo`, either fix the ownership of that folder or only track third-party plugins. The error always says which path and that the current deployment is unchanged.

## "I deleted a plugin by mistake"
Delete moves the repo to `~/.dsh/local-plugins/.trash/<name>-<time>/`. Move it back to `~/.dsh/local-plugins/<name>` and click **Repair installation**: it is tracked again (not applied).

## Windows
Not supported: it needs symlinks and POSIX permissions. The plugin refuses to start there with a message. Use macOS, Linux or WSL.

## Disk space
**Disk usage** shows repos, snapshots, worktrees, backups and the trash. **Clean up old snapshots…** previews and removes only snapshots beyond the retention limit (`settings.keepSnapshots` in the registry, default 3, or `LPM_KEEP_SNAPSHOTS`); the live one and the rollback target are never removed.

## Still stuck
`~/.dsh/local-plugins/logs/operations.jsonl` has one redacted line per operation (id, plugin, status, duration, error code). Include it and the failing operation's log from *Recent operations* (both are redacted). If you also share `registry.json`, first check that no git URL in it has credentials embedded: the file keeps the address exactly as you entered it, because it is needed to fetch.
