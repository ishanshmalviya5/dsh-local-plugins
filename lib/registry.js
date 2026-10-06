// $DSH_HOME/local-plugins/registry.json — the manager's only state file.
//
// {
//   version: 1,
//   dshVersion: "0.2.0-rc.2",          // dsh version at the last (re)apply
//   restartNeeded: false,
//   upgrade: { from, to } | null,      // set at boot when dsh changed underneath us
//   plugins: {
//     "<name>": {
//       name, kind: "profile" | "core",
//       source: { type: "git", url, branch } | { type: "npm", name },
//       originalSpec,                  // profile only: dependency spec to restore
//       core: { path, nodeModules },   // core only: where dsh resolves the package
//       upstreamVersion,               // npm version (or git sha) on the `upstream` branch
//       applied, deployedSha, linkLost,
//       depOverrides: { "<dep>": "<range>" },
//       update: { available, target, checkedAt, error } | null,
//       pending: { worktree, branch, conflicts: [] } | null,
//       lastError
//     }
//   }
// }
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const EMPTY = () => ({ version: 1, dshVersion: null, restartNeeded: false, upgrade: null, plugins: {} });

export function loadRegistry(file) {
  try {
    return { ...EMPTY(), ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch (err) {
    if (err.code === 'ENOENT') return EMPTY();
    throw err;
  }
}

/** Atomic write: temp file + rename, so a crash never leaves half a registry. */
export function saveRegistry(file, reg) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Load, mutate via `fn`, save; returns fn's result. */
export function updateRegistry(file, fn) {
  const reg = loadRegistry(file);
  const result = fn(reg);
  saveRegistry(file, reg);
  return result;
}
