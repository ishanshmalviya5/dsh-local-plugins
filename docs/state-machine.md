# Plugin state machine

One function (`deriveStatus` in `lib/status.js`) decides a plugin's state; the API refuses actions that are not legal in it (`409 INVALID_STATE_<STATE>` with `details { state, action, allowed[] }`).

| State | Meaning | Primary action | Allowed actions | UI |
|---|---|---|---|---|
| **TRACKED** ("Not applied") | repo exists, nothing deployed | Apply | apply, update, commit, setDep, trust, repair, work, **delete** | grey tag |
| **APPLIED** | a commit is live, nothing waiting | Deploy older commit… (rollback) | apply, update, restore, commit, setDep, trust, rollback, repair, work | green tag |
| **CHANGES_PENDING** | applied, but newer or uncommitted work is not | Apply | same as APPLIED | amber tag, "n newer commit(s) not applied" |
| **UPDATE_AVAILABLE** | the origin has a newer release | Update | same as APPLIED | amber tag + Update button |
| **CONFLICT** | an update stopped on merge conflicts; nothing was activated | Finish update | finish, abort, trust, repair, work | red tag + conflict banner (files, worktree path, Fix with agent) |
| **LINK_LOST** | registry says applied, dsh no longer uses it | Reapply | apply, update, restore, commit, setDep, trust, rollback, repair, work, reapply | amber tag |
| **REAPPLY_REQUIRED** | dsh was upgraded underneath us | Reapply all | as LINK_LOST | amber tag + upgrade banner |
| **BROKEN** | registry, disk and git disagree (see issues) | Repair installation | restore, repair, work, rollback, trust, **delete** | red tag + issue list |
| **DISABLED** | it crashed dsh and was taken out | Work on it | apply (only after a new commit), restore, commit, setDep, trust, repair, work, delete | red tag + explanation; only "Work on it" is offered until something new is committed |

Priority when several apply: DISABLED > CONFLICT > BROKEN > LINK_LOST/REAPPLY_REQUIRED > UPDATE_AVAILABLE > CHANGES_PENDING > APPLIED > TRACKED.

## Transitions

```
TRACKED ──apply──► APPLIED ──commit──► CHANGES_PENDING ──apply──► APPLIED
APPLIED/TRACKED ──check──► UPDATE_AVAILABLE ──update (clean)──► CHANGES_PENDING | TRACKED
UPDATE_AVAILABLE ──update (conflict)──► CONFLICT ──finish──► CHANGES_PENDING
                                                  └─abort───► UPDATE_AVAILABLE
APPLIED ──dsh upgrade──► REAPPLY_REQUIRED ──reapply──► APPLIED
APPLIED ──link vanished──► LINK_LOST ──reapply──► APPLIED
APPLIED ──dsh restarts < 60 s after Apply──► (built-in: TRACKED, original back)
                                            (third party: APPLIED on the previous upstream release, else DISABLED)
DISABLED ──new commit + apply──► APPLIED
any ──restore (Unlink)──► TRACKED          any ──repair──► the state the facts support
TRACKED/DISABLED/BROKEN ──delete (typed name)──► gone (repo in .trash)
```

## Rules that are not states

* Only one mutation runs at a time (`409 BUSY` otherwise; nothing half-starts).
* Repeating **Apply** of what is live, **Restore** of what is already original, **Commit** with nothing to commit, **Update** when current, and **Repair** are reported no-ops.
* An action that needs permission to run scripts fails with `NEEDS_PERMISSION` *before* anything is switched on.
