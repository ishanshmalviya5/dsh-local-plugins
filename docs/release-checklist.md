# v0.2 release checklist

Status is what has actually been demonstrated, not what is intended. **Shown** = an automated test or measurement exists and passes. **Manual** = checked by hand in the isolated environment. **Not shown** = say so plainly.

## Correctness
| Criterion | Status | Evidence |
|---|---|---|
| Original npm specs restore exactly | Shown | `test/fixes.test.js` "Restore original reinstalls exactly the original spec…" (range, pin, tag, git, alias, fallbacks) |
| Registry migrations work | Shown | `test/registry.test.js` (v1→v2, idempotent, never overwrites, never downgrades); `test/upgrade.test.js` |
| Invalid registry is recoverable | Shown | `registry.test.js` (corrupt/invalid/too new); `recovery.test.js` "corrupt registry is kept aside and rebuilt" |
| Rollback is reliable | Shown | `recovery.test.js` "rollback: A → B → C…", retention, unknown commit, rebuild of a deleted snapshot |
| Update conflicts are recoverable | Shown | `git-sources.test.js` "restart during a conflict…", "abort returns to a known state", interrupted merge |
| DSH upgrades are recoverable | Shown | `manager.test.js` "boot detects a dsh upgrade…"; e2e scenario 12 (reinstall → banner → Reapply all); `recovery.test.js` missing built-in package restored |

## Deployment
| Criterion | Status | Evidence |
|---|---|---|
| Failed builds never replace the active deployment | Shown | `manager.test.js` failing build; `recovery.test.js` build fail/crash; `overrides.test.js` uninstallable dependency |
| Interrupted activation never leaves a broken stable link | Shown | `recovery.test.js` fail **and** crash at prepare / install / activate / registry / cleanup (profile), core stages, `swapLink` cases |
| Active snapshot is never garbage-collected | Shown | retention tests; sweep test ("never deletes a snapshot that is linked, or one that belongs to nothing it tracks"); cleanup test |
| Reapply is idempotent | Shown | `manager.test.js` reapplyAll; `api.test.js` idempotency; repair-twice in e2e scenario 14 |

## Security
| Criterion | Status | Evidence |
|---|---|---|
| No known path traversal | Shown | `security.test.js` tampered registry paths, invalid names, hostile tarballs (traversal, absolute, escaping symlink, fifo) |
| No shell injection | Shown | arguments are always arrays (`lib/run.js`); option-looking input rejected (`fixes.test.js`, `security.test.js`) |
| Symlink targets validated | Shown | `swapLink` tests; `security.test.js` "stable link can never point outside managed storage" |
| API authenticated | Shown | `api.test.js` auth matrix (fails closed); e2e scenario 1 (401) |
| Secrets excluded from logs | Shown | `process.test.js` redaction + child output + ops log |
| Build execution security documented | Shown | `docs/security.md`, README "Read this first" |

## UX
| Criterion | Status | Evidence |
|---|---|---|
| Every plugin has a clear state; primary action follows state | Shown (logic) + Manual (screens) | `health.test.js` state machine; browser check of the card, banners and buttons in the isolated dsh |
| Errors explain recovery | Shown | `remove.test.js` advice for every action × code; messages audit |
| Logs are accessible | Manual | Recent operations, View/Copy log, per-operation log (browser check) + `operations.jsonl` |
| DSH upgrade flow is obvious | Manual | upgrade banner + Reapply all (e2e scenario 12 asserts the banner and recovery) |

## Testing
| Criterion | Status | Evidence |
|---|---|---|
| Existing v0.1 tests pass | Shown | all 14 original tests remain (updated only where behaviour intentionally changed: restore spec, error wording, registry shape) |
| New crash/recovery tests pass | Shown | `recovery.test.js`, `health.test.js` |
| Fault-injection tests pass | Shown | `LPM_FAIL_AT` at all 17 stages as a simulated crash, the Apply-path stages also as an ordinary failure (`docs/development.md`) |
| E2E passes | Shown (isolated dsh, macOS) | 15 scenarios, run on this branch |
| Package tarball installs correctly | Shown | `npm run check:package` (installs the tarball into an empty project and loads server entry, client bundle, `undo.mjs`, the shipped migration) |

## Release
| Criterion | Status | Evidence |
|---|---|---|
| v0.1 → v0.2 migration tested | Shown (simulated) + Manual (real v0.1 data in the isolated env) | `upgrade.test.js`; the isolated env's real v0.1 registry migrated with all five plugins kept. **Not shown:** the maintainer's real `~/.dsh` (never touched) |
| Clean installation tested | Shown | package validator installs into an empty project; e2e `setup.sh` builds from scratch |
| Existing installation tested | Shown (simulated) | `upgrade.test.js` |
| README updated | Done | compatibility table, limits, links; the validator fails if the version row is missing |
| Changelog written | Done | `CHANGELOG.md` (the lint fails without a section for the current version) |
| Package contents audited | Shown | allow-list + no tests/handoff/conversation/keys/local paths/e-mails (`check:package`) |
| **CI green** | **Shown** | the CI run on pull request #2 ([run 37631766848](https://github.com/ishanshmalviya5/dsh-local-plugins/actions/runs/37631766848)): macOS + Node 26 (the required job), Ubuntu + Node 22 / 24 / 26 and the dependency audit all passed. Its first run found one real defect in the package validator (it treated the CI account name `runner` as a private word); fixed and pinned by `test/private-terms.test.js` |
| Linux, Node 22 / 24 / 26 | **Partly shown** | lint, all unit tests and package validation pass on Ubuntu in CI. An end-to-end run against a real dsh on Linux has not been done, and Node 22 / 24 are outside the declared `engines` (>= 26) |

## Definition of done — the three invariants
1. *At every crash point the user has the previous or the new valid deployment, and the system can detect and recover everything between.* — fault-injection matrix + journal recovery + `repair`.
2. *Registry, git, filesystem and the dsh install never silently disagree.* — `reconcile` (see [recovery.md](recovery.md)), adoption of v0.1 deployments, `state().issues` shown on every card.
3. *No operation silently destroys committed work or the original dsh installation.* — originals go to `.backup`, deleted repos to `.trash`, user work to stash + rescue branch before any revert, `local` is never rewritten, tamper-proof path checks.

## Remaining human steps
Done: the branch is merged and CI is green.
* Tag `v0.2.0` (the tag triggers the release-check workflow, which re-runs everything and attaches the package).
* Decide whether the Linux / Node 22–24 results justify widening the compatibility table (README, `engines`, `os`), ideally after an end-to-end run on a Linux machine.
* Read the `npm pack` file list; `npm publish` yourself if you want it on npm.
