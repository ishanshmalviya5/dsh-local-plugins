# Performance

Measured with `npm run bench` (`test/bench.mjs`) on an Apple M5, macOS, Node 26.8, local disk, fake plugins from npm fixtures (no network). Your numbers will differ; the shape should not.

`node test/bench.mjs 20 3000 300` = 20 tracked plugins, plus one plugin with 3000 files and 300 commits.

| Operation | Time |
|---|---|
| add 20 plugins, one by one | ~1.1 s |
| apply 20 plugins, one by one | ~2.6 s |
| `state()` with 20 plugins (what the screens poll) | ~110 ms |
| `state()` with the 3000-file / 300-commit plugin tracked | ~125 ms |
| startup / repair with 20 plugins | ~250 ms |
| check for updates, 20 npm plugins (offline fixtures) | ~90 ms |
| disk usage, 20 plugins | ~70 ms |
| **apply** a 3000-file, 300-commit plugin | **~0.46 s** |
| apply again (nothing new → no-op) | ~25 ms |
| apply a new commit of the large plugin | ~0.44 s |
| rollback to an already-built snapshot | ~35 ms |

## What changed in v0.2 and why

| Operation | Before | After | Why |
|---|---|---|---|
| apply, 3000-file plugin | 17.1 s | 0.46 s | the "every file parses" check ran one `node --check` per file; it now parses all files in one process (`vm.SourceTextModule` / `vm.Script`, nothing executes) and falls back to per-file if that flag ever disappears |
| `state()`, 20 plugins | 669 ms | 114 ms | per-plugin git inspection ran one after another; now side by side |

## Design notes
* Git is only asked what is needed: one `inspectGit` per plugin per poll (`status`, `diff --name-only`, `ls-files`, `rev-list --count`). No fetch, no clone, no history walk.
* A snapshot is a git worktree: creating one checks out the tree once; no copy of history. Rollback to a kept snapshot is a link swap.
* The update check fetches only when you ask (and 5 s after start, in the background, outside the operation queue).
* Operation logs keep the newest 4000 lines in memory per operation; child output is capped at 8 MB per stream (newest kept); `operations.jsonl` rotates at 2 MB.
* Disk usage is measured on demand (`du -sk`, symlinks not followed), never on every poll.

## Not measured
Very large `node_modules` installs (dominated by npm, not by this plugin), networks slower than loopback, and Linux. Re-run `npm run bench` to see your machine.
