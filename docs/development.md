# Development

```bash
npm install            # one dev dependency: esbuild (client bundle only); the plugin has no runtime dependencies
npm run build          # client/index.jsx -> client/client.js   (commit the result; lint fails if it is stale)
npm run lint           # built-in checks, no packages: everything parses, hygiene, bundle current, manifest consistent
npm test               # unit + integration tests (node:test, temp dirs, no dsh, no network)
npm run check:package  # pack the tarball, inspect it, install it into an empty project and use it
npm run check          # lint + test + check:package
npm run test:e2e       # scenarios against an isolated live dsh (see below)
npm run bench          # performance numbers (docs/performance.md)
```

Requirements: Node >= 26, `git` and `npm` on `PATH`, macOS or Linux. Tested by the maintainer: macOS (arm64), Node 26.8. CI also runs Linux and Node 22/24 as *experimental* (see the compatibility table in the README).

## Tests

| Layer | Where | What |
|---|---|---|
| unit / integration | `test/*.test.js` | registry schema + migrations, state machine, journal + recovery, fault injection at every stage, crash loop, rollback/retention, git/npm sources (fake `npm`, local bare repos), overrides, security (tampered registry, hostile tarballs, traversal, permissions), API contract (mock requests), process runner, v0.1 upgrade |
| end to end | `test/e2e/api-scenarios.mjs` | 15 scenarios over HTTP against a real, isolated dsh on `:3091` (`DSH_HOME=~/.dsh-test/home`) — never your real one |
| performance | `test/bench.mjs` | see [performance.md](performance.md) |

### Fault injection
`LPM_FAIL_AT=<stage>` makes that step throw (cleanup runs); `LPM_FAIL_AT=<stage>:crash` simulates the process dying there (no cleanup, no registry save). Stages: `prepare install build snapshot prepared activate activated linking core-backup linked registry cleanup restoring restored snapshots moving moved`. `test/recovery.test.js` (with `remove.test.js` for delete) fires **every** one of them as a simulated crash (and the Apply-path stages also as an ordinary failure), and asserts the invariant: the live plugin is the old or the new deployment, never a broken one; the dsh package folder always exists; `repair` leaves no journal entry or temp file; and the system is usable afterwards.

### Other test switches
`LPM_NPM_FIXTURES=<dir>` (tarballs stand in for npm), `LPM_NPM_OFFLINE=1` (a package without fixtures is "not on npm"), `LPM_HEALTH_MS` (crash-loop window), `LPM_KEEP_SNAPSHOTS`.

### The isolated live environment
```bash
test/e2e/setup.sh    # once: installs a separate dsh into ~/.dsh-test, builds the profile and fixtures, deploys HEAD, starts :3091
test/e2e/reset.sh    # clean state again, without reinstalling dsh
test/e2e/start.sh    # (re)start it and print the token URL
test/e2e/teardown.sh # remove ~/.dsh-test
npm run test:e2e
```

## Releasing
1. `npm run check` is green; `npm run test:e2e` is green against the isolated dsh.
2. `CHANGELOG.md` has a section for the new version; `package.json` and the README compatibility table agree.
3. `npm pack` and read the file list (the validator does this), install the tarball somewhere clean.
4. Tag `vX.Y.Z`. The release workflow re-runs the checks and attaches the tarball; publishing is a deliberate manual step.

See [release-checklist.md](release-checklist.md) for the acceptance criteria and where each is demonstrated.

## Conventions
* Never run a command through a shell; pass argument arrays (`lib/run.js`).
* Every filesystem mutation of the live install goes through the journal (`lib/txn.js`) and has a fault point.
* Every user-facing failure goes through `lib/messages.js` (what happened / is it safe / what next).
* No secret may reach a log, an error or the UI: use `lib/redact.js`.
* The registry file is untrusted input.
