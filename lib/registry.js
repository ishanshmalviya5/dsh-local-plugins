// $DSH_HOME/local-plugins/registry.json — the manager's only state file.
//
// {
//   version: 2,
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
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Bump when the shape changes, and add a MIGRATIONS[<old version>] step. */
export const CURRENT_VERSION = 2;

export class RegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = 500;
  }
}

const DEFAULT_SETTINGS = { keepSnapshots: 3 };

const EMPTY = () => ({ version: CURRENT_VERSION, dshVersion: null, restartNeeded: false, upgrade: null, settings: { ...DEFAULT_SETTINGS }, plugins: {}, quarantine: {} });

/**
 * One step per version: MIGRATIONS[n] turns a version-n registry into version n+1.
 * Steps only add missing fields (never overwrite), so running one twice is harmless.
 */
const MIGRATIONS = {
  1(reg) {
    const plugins = {};
    for (const [name, p] of Object.entries(reg.plugins ?? {})) {
      plugins[name] = isObject(p)
        ? { disabled: false, deployHistory: typeof p.deployedSha === 'string' ? [p.deployedSha] : [], ...p }
        : p; // malformed entries are quarantined by validation, not here
    }
    return { ...reg, version: 2, settings: { ...DEFAULT_SETTINGS, ...(isObject(reg.settings) ? reg.settings : {}) }, plugins };
  },
};

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Bring a parsed registry up to CURRENT_VERSION (in memory). Never downgrades. */
export function migrateRegistry(reg) {
  let v = reg.version;
  if (!Number.isInteger(v) || v < 1) throw new RegistryError('REGISTRY_INVALID', `registry has no usable "version" (${JSON.stringify(v)})`);
  if (v > CURRENT_VERSION) {
    throw new RegistryError('REGISTRY_TOO_NEW', `registry is version ${v} but this dsh-local-plugins only understands up to ${CURRENT_VERSION}. It was written by a newer release; update dsh-local-plugins instead of editing the file (nothing was changed).`);
  }
  let out = reg;
  while (v < CURRENT_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) throw new RegistryError('REGISTRY_INVALID', `no migration from registry version ${v}`);
    out = step(out);
    v = out.version;
  }
  return out;
}

const isStr = (v) => typeof v === 'string' && v.length > 0;

/** Problems with one plugin entry (empty list = valid). Unknown fields are allowed and preserved. */
export function validatePlugin(name, p) {
  const bad = [];
  if (!isObject(p)) return ['entry is not an object'];
  if (p.name !== name) bad.push(`name "${p.name}" does not match its key "${name}"`);
  if (p.kind !== 'profile' && p.kind !== 'core') bad.push(`kind must be "profile" or "core", got ${JSON.stringify(p.kind)}`);
  if (!isObject(p.source)) bad.push('source is missing');
  else if (p.source.type === 'git') { if (!isStr(p.source.url)) bad.push('git source needs a url'); }
  else if (p.source.type === 'npm') { if (!isStr(p.source.name)) bad.push('npm source needs a name'); }
  else bad.push(`source.type must be "git" or "npm", got ${JSON.stringify(p.source.type)}`);
  if (p.kind === 'core' && !(isObject(p.core) && isStr(p.core.path) && isStr(p.core.nodeModules))) bad.push('core plugins need core.path and core.nodeModules');
  if (p.depOverrides !== undefined && !isObject(p.depOverrides)) bad.push('depOverrides must be an object');
  if (p.deployHistory !== undefined && !Array.isArray(p.deployHistory)) bad.push('deployHistory must be a list');
  return bad;
}

/**
 * Read the registry. A missing file is an empty registry. Malformed JSON, an
 * unusable version or a registry from the future throws a RegistryError (with
 * recovery advice) and changes nothing on disk. One malformed plugin entry
 * never takes the rest down: it moves to `quarantine` (kept, not deleted).
 */
export function loadRegistry(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return EMPTY();
    throw new RegistryError('REGISTRY_UNREADABLE', `cannot read ${file}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RegistryError('REGISTRY_CORRUPT', `${file} is not valid JSON (${err.message}). Your plugin repos are untouched. Use "Repair installation" to rebuild the registry from them; the broken file is kept as a .corrupt copy.`);
  }
  if (!isObject(parsed)) throw new RegistryError('REGISTRY_INVALID', `${file} must contain a JSON object`);
  const reg = { ...EMPTY(), ...migrateRegistry(parsed) };
  if (!isObject(reg.plugins)) throw new RegistryError('REGISTRY_INVALID', `"plugins" in ${file} must be an object`);
  if (!isObject(reg.quarantine)) reg.quarantine = {};
  for (const [name, p] of Object.entries(reg.plugins)) {
    const problems = validatePlugin(name, p);
    if (problems.length) {
      reg.quarantine[name] = { entry: p, problems, at: Date.now() };
      delete reg.plugins[name];
    }
  }
  return reg;
}

/** On-disk version of the registry file, or null (missing / unreadable). */
export function registryFileVersion(file) {
  try { const v = JSON.parse(readFileSync(file, 'utf8')).version; return Number.isInteger(v) ? v : null; } catch { return null; }
}

/** Keep a copy of the pre-migration file next to it, once. */
export function backupBeforeMigration(file) {
  const v = registryFileVersion(file);
  if (v === null || v >= CURRENT_VERSION) return null;
  const bak = `${file}.v${v}.bak`;
  if (!existsSync(bak)) copyFileSync(file, bak);
  return bak;
}

/** Atomic, durable write (0600): temp file + fsync + rename, so a crash never leaves half a registry. */
export function saveRegistry(file, reg) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify({ ...reg, version: CURRENT_VERSION }, null, 2)}\n`, { mode: 0o600 });
  const fd = openSync(tmp, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
}

/** Load, mutate via `fn`, save; returns fn's result. */
export function updateRegistry(file, fn) {
  const reg = loadRegistry(file);
  const result = fn(reg);
  saveRegistry(file, reg);
  return result;
}
