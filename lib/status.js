// Plugin state machine. One place decides what state a plugin is in, what the UI should
// put first, and which actions are legal; the API rejects the rest instead of improvising.
//
//   TRACKED            repo exists, nothing deployed
//   APPLIED            a commit is live and nothing is waiting
//   CHANGES_PENDING    applied, but newer/uncommitted work has not been applied
//   UPDATE_AVAILABLE   the origin has a newer release to merge
//   CONFLICT           an update stopped on merge conflicts (nothing was activated)
//   LINK_LOST          registry says applied but dsh no longer uses it
//   REAPPLY_REQUIRED   dsh was upgraded underneath us; links must be re-created
//   BROKEN             registry, filesystem and git disagree (see issues); repair first
//   DISABLED           it crashed dsh and was taken out; fix it, then Apply
//
// Transitions (event -> next state):
//   TRACKED --apply--> APPLIED                APPLIED --commit--> CHANGES_PENDING
//   CHANGES_PENDING --apply--> APPLIED        APPLIED/TRACKED --check--> UPDATE_AVAILABLE
//   UPDATE_AVAILABLE --update (clean)--> CHANGES_PENDING / TRACKED
//   UPDATE_AVAILABLE --update (conflict)--> CONFLICT --finish--> CHANGES_PENDING | --abort--> UPDATE_AVAILABLE
//   APPLIED --dsh upgrade--> REAPPLY_REQUIRED --reapply--> APPLIED
//   APPLIED --link vanished--> LINK_LOST --reapply--> APPLIED
//   APPLIED --crash within 60 s of apply--> TRACKED (fallback release live: APPLIED) or DISABLED
//   DISABLED --new commit + apply--> APPLIED
//   any --repair--> consistent state; any --restore--> TRACKED
export const STATUS = {
  TRACKED: 'TRACKED', APPLIED: 'APPLIED', CHANGES_PENDING: 'CHANGES_PENDING', UPDATE_AVAILABLE: 'UPDATE_AVAILABLE',
  CONFLICT: 'CONFLICT', LINK_LOST: 'LINK_LOST', REAPPLY_REQUIRED: 'REAPPLY_REQUIRED', BROKEN: 'BROKEN', DISABLED: 'DISABLED',
};

const ALL = ['apply', 'update', 'finish', 'abort', 'restore', 'commit', 'setDep', 'trust', 'rollback', 'repair', 'work', 'reapply'];
const ALLOWED = {
  TRACKED: ['apply', 'update', 'commit', 'setDep', 'trust', 'repair', 'work'],
  APPLIED: ['apply', 'update', 'restore', 'commit', 'setDep', 'trust', 'rollback', 'repair', 'work'],
  CHANGES_PENDING: ['apply', 'update', 'restore', 'commit', 'setDep', 'trust', 'rollback', 'repair', 'work'],
  UPDATE_AVAILABLE: ['apply', 'update', 'restore', 'commit', 'setDep', 'trust', 'rollback', 'repair', 'work'],
  CONFLICT: ['finish', 'abort', 'trust', 'repair', 'work'],
  LINK_LOST: ['apply', 'update', 'restore', 'commit', 'setDep', 'trust', 'rollback', 'repair', 'work', 'reapply'],
  REAPPLY_REQUIRED: ['apply', 'update', 'restore', 'commit', 'setDep', 'trust', 'rollback', 'repair', 'work', 'reapply'],
  BROKEN: ['restore', 'repair', 'work', 'rollback', 'trust'],
  DISABLED: ['apply', 'restore', 'commit', 'setDep', 'trust', 'repair', 'work'],
};

const LABEL = {
  TRACKED: 'Not applied', APPLIED: 'Applied', CHANGES_PENDING: 'Changes pending', UPDATE_AVAILABLE: 'Update available',
  CONFLICT: 'Conflict', LINK_LOST: 'Link lost', REAPPLY_REQUIRED: 'Reapply required', BROKEN: 'Broken', DISABLED: 'Disabled',
};
const PRIMARY = {
  TRACKED: 'apply', APPLIED: 'rollback', CHANGES_PENDING: 'apply', UPDATE_AVAILABLE: 'update', CONFLICT: 'finish',
  LINK_LOST: 'reapply', REAPPLY_REQUIRED: 'reapply', BROKEN: 'repair', DISABLED: 'work',
};

/**
 * @param p        registry entry
 * @param ctx      { stats?, upgrade?, issues?: [{plugin, severity}] }
 */
export function deriveStatus(p, { stats = null, upgrade = null, issues = [] } = {}) {
  let id;
  if (p.disabled) id = STATUS.DISABLED;
  else if (p.pending) id = STATUS.CONFLICT;
  else if (issues.some((i) => i.plugin === p.name && i.severity === 'error')) id = STATUS.BROKEN;
  else if (p.applied && p.linkLost) id = upgrade ? STATUS.REAPPLY_REQUIRED : STATUS.LINK_LOST;
  else if (p.update?.available) id = STATUS.UPDATE_AVAILABLE;
  else if (p.applied && ((stats?.notApplied ?? 0) > 0 || (stats?.uncommitted ?? 0) > 0)) id = STATUS.CHANGES_PENDING;
  else if (p.applied) id = STATUS.APPLIED;
  else id = STATUS.TRACKED;
  return { id, label: LABEL[id], primary: PRIMARY[id], allowed: ALLOWED[id], invalid: ALL.filter((a) => !ALLOWED[id].includes(a)) };
}

const ADVICE = {
  CONFLICT: 'An update is stopped on merge conflicts. Finish it (after resolving the files) or abort it first.',
  BROKEN: 'This plugin has inconsistencies. Run "Repair installation" first.',
  DISABLED: 'This plugin crashed dsh and was taken out. Use "Work on it" to fix it, commit the fix, then Apply.',
};

/**
 * Refuse an action that is not legal in the plugin's current state, using only what the
 * registry knows (no git calls). Throws an error with `code` and `status` 409.
 */
export function assertAllowed(p, action, { issues = [] } = {}) {
  const s = deriveStatus(p, { issues });
  if (ALLOWED[s.id].includes(action)) return s;
  const err = new Error(`${action} is not possible while ${p.name} is ${s.label.toLowerCase()}. ${ADVICE[s.id] ?? ''}`.trim());
  err.status = 409;
  err.code = `INVALID_STATE_${s.id}`;
  err.details = { state: s.id, action, allowed: ALLOWED[s.id] };
  throw err;
}
