// Platform support and filesystem error explanations.
//
// Supported: macOS and Linux (symlinks + POSIX permissions). Windows is refused up front
// with a clear message instead of failing halfway through an Apply.
export function assertSupportedPlatform(platform = process.platform) {
  if (platform === 'win32') {
    throw Object.assign(new Error('dsh-local-plugins does not support Windows: it relies on symlinks and POSIX file permissions. Use macOS or Linux (or WSL). Nothing was changed.'), { code: 'UNSUPPORTED_PLATFORM', status: 501 });
  }
  return true;
}

/**
 * Turn a raw permission failure into something a person can act on; anything else is returned unchanged.
 * @param {Error & {code?:string}} err
 * @param {string} what  e.g. "switching the live deployment"
 * @param {string} path  the file or folder involved
 */
export function explainFsError(err, what, path) {
  if (err && ['EPERM', 'EACCES', 'EROFS'].includes(err.code)) {
    const readOnly = err.code === 'EROFS';
    return Object.assign(new Error(`${readOnly ? 'The folder is read-only' : 'Permission denied'} while ${what} (${path}). dsh-local-plugins needs to write to its own folder (\`$DSH_HOME/local-plugins\`) and, for built-in dsh packages, to the dsh install folder. ${err.code === 'EPERM' && process.platform === 'win32' ? 'Windows needs Developer Mode to create symlinks. ' : ''}Nothing was changed; the current deployment is still active.`), { code: 'PERMISSION_DENIED', status: 500, cause: err });
  }
  return err;
}
