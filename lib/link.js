// Wiring dsh to a plugin's stable link (and back to the original).
//
// profile plugin: the profile's package.json dependency becomes
//   "link:<root>/.deployed/<safe>"   via `dsh plugin --profile <p> add …`
// core package:   the package dir inside the dsh install is moved to
//   <root>/.backup/<safe>@<version> and replaced by a symlink to the stable link.
import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { run } from './run.js';
import { readJson, safeName } from './env.js';
import { npmExtract, npmVersion } from './sources.js';
import { phase } from './txn.js';
import { explainFsError } from './platform.js';

/** `dsh plugin --profile <profile> <args…>` through the same dsh install that booted us. */
export function dshPlugin(env, args, log) {
  const file = env.dsh ? process.execPath : 'dsh';
  const pre = env.dsh ? [env.dsh.bin] : [];
  return run(file, [...pre, 'plugin', '--profile', env.profile, ...args], { cwd: env.profileDir, log, timeoutMs: 10 * 60_000 });
}

function isSymlinkTo(path, target) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
    return resolve(dirname(path), readlinkSync(path)) === resolve(target);
  } catch { return false; }
}

// ---------- profile plugins ----------

export function profileSpec(env, name) {
  try { return env.profilePackageJson().dependencies?.[name] ?? null; } catch { return null; }
}

export function profileLinked(env, plugin) {
  const spec = profileSpec(env, plugin.name);
  return typeof spec === 'string' && spec.startsWith('link:') && resolve(env.profileDir, spec.slice(5)) === resolve(env.stableLink(plugin.name));
}

/**
 * Point the profile at the stable link. pnpm may store/resolve the link by
 * realpath (the current snapshot); if so, re-point node_modules/<name> at the
 * stable link ourselves so later deploys only need the link swap.
 */
export async function linkProfile(env, plugin, log) {
  const stable = env.stableLink(plugin.name);
  if (!profileLinked(env, plugin)) {
    log?.(`dsh plugin add link:${stable}`);
    await dshPlugin(env, ['add', `link:${stable}`], log);
  }
  const installed = join(env.profileDir, 'node_modules', plugin.name);
  if (!isSymlinkTo(installed, stable)) {
    rmSync(installed, { recursive: true, force: true });
    mkdirSync(dirname(installed), { recursive: true });
    symlinkSync(stable, installed);
    log?.(`node_modules/${plugin.name} -> stable link`);
  }
}

/**
 * The spec "restore original" installs: exactly what the profile had before we
 * took over (a range, an exact pin, a dist-tag, an alias, a git spec…). Only a
 * missing spec, or one that was already a link, falls back to the latest release.
 */
export function restoreSpec(plugin) {
  const spec = plugin.originalSpec;
  if (typeof spec !== 'string' || !spec.trim() || spec.startsWith('link:')) return `${plugin.name}@latest`;
  return `${plugin.name}@${spec.trim()}`;
}

export async function unlinkProfile(env, plugin, log) {
  const spec = restoreSpec(plugin);
  log?.(`dsh plugin add ${spec}`);
  await dshPlugin(env, ['add', spec], log);
}

/** Take a profile plugin out of dsh (pnpm remove). The local repo and snapshots stay. */
export async function removeFromProfile(env, plugin, log) {
  log?.(`dsh plugin remove ${plugin.name}`);
  await dshPlugin(env, ['remove', plugin.name], log);
  rmSync(join(env.profileDir, 'node_modules', plugin.name), { recursive: true, force: true });
}

// ---------- core packages ----------

export function coreLinked(env, plugin) {
  return isSymlinkTo(plugin.core.path, env.stableLink(plugin.name));
}

export function moveDir(from, to) {
  try {
    renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/** Save the package's private nested node_modules (rare) so snapshots can use them. */
export function preserveNested(env, plugin, log) {
  const nestedSrc = join(plugin.core.path, 'node_modules');
  const nestedDst = join(env.root, '.nested', safeName(plugin.name));
  rmSync(nestedDst, { recursive: true, force: true });
  if (existsSync(nestedSrc) && !lstatSync(plugin.core.path).isSymbolicLink()) {
    mkdirSync(dirname(nestedDst), { recursive: true });
    cpSync(nestedSrc, nestedDst, { recursive: true, verbatimSymlinks: true });
    plugin.core.nested = nestedDst;
    log?.('preserved nested node_modules');
  } else {
    plugin.core.nested = null;
  }
}

/** Replace the core package dir with a symlink to the stable link (backing up the original). */
export function linkCore(env, plugin, log, { env: txnEnv, txn } = {}) {
  const { path } = plugin.core;
  if (coreLinked(env, plugin)) return;
  const st = lstatSafe(path);
  if (st?.isSymbolicLink()) unlinkSync(path);
  else if (st) {
    const version = readJson(join(path, 'package.json')).version;
    const backup = join(env.backupDir, `${safeName(plugin.name)}@${version}`);
    mkdirSync(env.backupDir, { recursive: true });
    rmSync(backup, { recursive: true, force: true });
    try { moveDir(path, backup); } catch (err) { throw explainFsError(err, 'moving the original dsh package to a backup', path); }
    plugin.core.backup = backup;
    plugin.core.originalVersion = version;
    log?.(`original moved to ${backup}`);
    // the original now lives only in the backup: journal it so recovery can put it back
    if (txn) phase(txnEnv, txn, 'core-backup', { backup, originalVersion: version });
  }
  try { symlinkSync(env.stableLink(plugin.name), path); } catch (err) { throw explainFsError(err, 'linking the built-in dsh package', path); }
  log?.(`${path} -> stable link`);
}

/** Put the original package dir back (from backup, else re-extract from npm). */
export async function unlinkCore(env, plugin, log) {
  const { path } = plugin.core;
  if (!lstatSafe(path)?.isSymbolicLink()) { log?.('original already in place'); return; }
  unlinkSync(path);
  if (plugin.core.backup && existsSync(plugin.core.backup)) {
    moveDir(plugin.core.backup, path);
    log?.(`restored original from ${plugin.core.backup}`);
  } else {
    mkdirSync(path, { recursive: true });
    await npmExtract(plugin.name, plugin.core.originalVersion, path, log);
    log?.(`re-extracted ${plugin.name}@${plugin.core.originalVersion} from npm`);
  }
  plugin.core.backup = null;
}

function lstatSafe(p) {
  try { return lstatSync(p); } catch { return null; }
}

/**
 * Install dependency overrides into the dsh install's node_modules
 * (what ~/.dsh/pin-pi-ai-latest.sh did by hand). npm runs with the original
 * package dir in place so it never "repairs" our symlink.
 */
export async function applyCoreDepOverrides(env, plugin, log) {
  const overrides = Object.entries(plugin.depOverrides ?? {});
  if (!overrides.length) return;
  const cwd = dirname(plugin.core.nodeModules);
  const wanted = [];
  for (const [dep, range] of overrides) {
    const target = await npmVersion(dep, range, log);
    let have = null;
    try { have = readJson(join(plugin.core.nodeModules, dep, 'package.json')).version; } catch { /* missing */ }
    if (have === target) log?.(`${dep} already ${target}`);
    else wanted.push(`${dep}@${target}`);
  }
  if (!wanted.length) return;
  const wasLinked = coreLinked(env, plugin);
  if (wasLinked) await unlinkCore(env, plugin, log);
  try {
    log?.(`npm install --no-save ${wanted.join(' ')} (in ${cwd})`);
    await run('npm', ['install', '--no-save', '--no-package-lock', '--no-audit', '--no-fund', ...wanted], { cwd, log, timeoutMs: 10 * 60_000 });
  } finally {
    if (wasLinked) linkCore(env, plugin, log);
  }
}
