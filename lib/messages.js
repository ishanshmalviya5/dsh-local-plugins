// What to tell the user when an operation fails. Every failure answers three questions:
//   1. what happened        -> the error message itself
//   2. is the current setup safe -> `safe`
//   3. what can I do next   -> `next`
// Keyed by the action the user clicked, refined by the error code.
const SAFE = {
  apply: 'The previous deployment (if there was one) is still active; nothing half-built was switched on.',
  rollback: 'The current deployment is still active.',
  update: 'Your local branch and the live plugin are unchanged.',
  finish: 'Nothing was merged into your local branch and the live plugin is unchanged.',
  abort: 'Your local branch is unchanged.',
  restore: 'dsh may still be using your local version. Check the plugin card before doing anything else.',
  commit: 'Nothing was committed.',
  setDep: 'Nothing was committed and package.json is unchanged.',
  migrate: 'Nothing was added and the installed plugin is untouched.',
  add: 'Nothing was added.',
  check: 'No plugin or update information was changed.',
  repair: 'Repair never deletes anything it cannot rebuild; your repos, backups and the live plugins are untouched.',
  reapplyAll: 'Each plugin is listed below with its own result; plugins that did not fail were handled safely.',
  trust: 'Script permissions are unchanged.',
  delete: 'Your repo was not moved and nothing was deleted.',
  cleanup: 'Nothing that is live, or needed for rollback, was removed.',
  startup: 'dsh keeps running as before.',
};

const NEXT_BY_CODE = {
  NEEDS_PERMISSION: 'Review what wants to run on your computer, then allow it once or always for this plugin.',
  COMMAND_TIMEOUT: 'The step took too long and was stopped (with everything it started). Retry, or open the log to see where it stalled.',
  COMMAND_FAILED: 'Open the log to see the failing step, fix it with "Work on it", commit the fix, and Apply again.',
  BUSY: 'Wait for the running operation to finish, then try again.',
  PACKAGE_RENAMED: 'The origin published this package under a new name. Add the new package separately; this one stays as it is.',
  INCOMPATIBLE_MANIFEST: 'Update dsh-local-plugins to a version that understands this plugin, or stay on the current release.',
  NPM_UNREACHABLE: 'Check your internet connection (and any proxy), then retry.',
  NPM_PACKAGE_NOT_FOUND: 'Check the package name; if it was removed or renamed on npm, keep using your local copy.',
  NPM_VERSION_NOT_FOUND: 'Pick a version or tag that exists on npm.',
  ORIGIN_UNREACHABLE: 'Check your connection and the repository address (and access rights), then retry.',
  GIT_REF_NOT_FOUND: 'Use a tag, branch or commit that exists in that repository.',
  UNSAFE_ARCHIVE: 'Do not install this package: its archive tried to write outside its own folder.',
  INVALID_STATE_CONFLICT: 'Finish or abort the update first.',
  INVALID_STATE_DISABLED: 'Use "Work on it", fix the plugin, commit, and then Apply.',
  INVALID_STATE_BROKEN: 'Run "Repair installation" first.',
  NOT_UNLINKED: 'Click "Unlink (restore original)" first, so dsh has its own plugin back, then delete.',
  CONFIRMATION_MISMATCH: 'Type the plugin name exactly as shown.',
  REGISTRY_CORRUPT: 'Run "Repair installation": it keeps the broken file and rebuilds the list from your repos.',
  REGISTRY_TOO_NEW: 'Update dsh-local-plugins; do not edit the registry file by hand.',
};

const NEXT_BY_ACTION = {
  apply: 'Open the log, fix the problem with "Work on it", commit, and Apply again — or retry if it was a temporary problem.',
  update: 'Open the log, then retry. If the origin is unreachable, nothing needs fixing on your side.',
  finish: 'Resolve the files that still have conflict markers, then finish again.',
  restore: 'Open the log, then retry; if the plugin card looks wrong, run "Repair installation".',
  repair: 'Open the log to see what could not be fixed safely.',
};

/** @returns {{ safe: string, next: string }} */
export function adviceFor({ action, code }) {
  const key = ['finish update', 'finish'].includes(action) ? 'finish' : action === 'reapply all' ? 'reapplyAll' : action === 'restore original' ? 'restore' : action === 'startup recovery' ? 'startup' : action;
  return {
    safe: SAFE[key] ?? 'Nothing that is live was changed.',
    next: NEXT_BY_CODE[code] ?? NEXT_BY_ACTION[key] ?? 'Open the log for details, then retry.',
  };
}

/** A one-line title for a failed operation, in the user's words. */
export function failureTitle(action) {
  const names = { apply: 'Apply', rollback: 'Rollback', update: 'Update', finish: 'Finish update', abort: 'Abort update', restore: 'Unlink', commit: 'Commit', setDep: 'Dependency override', migrate: 'Migrate', add: 'Add', check: 'Update check', repair: 'Repair', reapplyAll: 'Reapply all', trust: 'Script permission', delete: 'Delete', cleanup: 'Clean up', 'startup recovery': 'Startup recovery' };
  const key = ['finish update'].includes(action) ? 'finish' : action === 'reapply all' ? 'reapplyAll' : action === 'restore original' ? 'restore' : action;
  return `${names[key] ?? action} failed`;
}
