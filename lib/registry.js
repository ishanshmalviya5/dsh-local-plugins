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
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

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
  backupBeforeMigration(file); // an older-format file is never overwritten without a copy (no code path can skip this)
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

/**
 * Rebuild a registry from the plugin repos on disk (the repos are the real data).
 * The unreadable file is copied to registry.json.corrupt-<time> first and never deleted.
 * Applied-state is NOT guessed: everything comes back "not applied" with the origin
 * recovered from the repo, so the next Apply re-links it safely.
 */
export async function rebuildRegistry(env, log) {
  const file = env.registryFile;
  let kept = null;
  if (existsSync(file)) { kept = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`; copyFileSync(file, kept); }
  const reg = EMPTY();
  const found = [];
  const gitq = (dir, ...args) => { try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  let dirs = [];
  try { dirs = readdirSync(env.root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')); } catch { /* no root */ }
  for (const d of dirs) {
    const dir = join(env.root, d.name);
    if (!existsSync(join(dir, '.git')) || !gitq(dir, 'rev-parse', '--verify', '--quiet', 'local') || !gitq(dir, 'rev-parse', '--verify', '--quiet', 'upstream')) continue;
    let pkg;
    try { pkg = JSON.parse(gitq(dir, 'show', 'local:package.json')); } catch { log?.(`${d.name}: no readable package.json on the local branch; skipped`); continue; }
    const name = pkg.name;
    if (!name) continue;
    const origin = gitq(dir, 'remote', 'get-url', 'origin');
    const core = name.startsWith('@deepseek-ai/') && !(env.profilePackageJson().dependencies ?? {})[name] ? env.coreLocation?.(name) : null;
    const subject = gitq(dir, 'log', '-1', '--format=%s', 'upstream') ?? '';
    const npmVer = /^npm .+@(\S+)$/.exec(subject)?.[1];
    reg.plugins[name] = {
      name, kind: core ? 'core' : 'profile',
      source: origin ? { type: 'git', url: origin, branch: gitq(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')?.replace(/^origin\//, '') ?? 'main' } : { type: 'npm', name },
      upstreamVersion: npmVer ?? gitq(dir, 'rev-parse', 'upstream'),
      originalSpec: 'latest',
      ...(core ? { core: { path: core.path, nodeModules: core.nodeModules } } : {}),
      applied: false, deployedSha: null, linkLost: false, disabled: false, deployHistory: [], trustScripts: false, depOverrides: {}, update: null, pending: null, lastError: null,
    };
    found.push(name);
  }
  return { reg, kept, found };
}
