// RULE: dsh only ever runs a commit.
//
// A deploy materializes one exact commit as a detached worktree
//   $root/.deployed/<safe>@<sha12>
// prepares it (dependency install / build, or the core node_modules link),
// and only then atomically repoints the stable link
//   $root/.deployed/<safe>  ->  <safe>@<sha12>
// which is what dsh is wired to. The editing tree, uncommitted edits and
// half-merged update trees can never reach dsh.
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, basename, relative, resolve, sep } from 'node:path';
import { faultPoint, isCrash, phase } from './txn.js';
import { git, revParse } from './git.js';
import { run } from './run.js';
import { readJson, safeName } from './env.js';

export const DEFAULT_KEEP_SNAPSHOTS = 3;
/** Written last, after a snapshot is fully prepared; a snapshot without it is never trusted. */
const READY = '.lpm-ready';

/** Thrown when preparing a snapshot would run third-party scripts the user has not allowed. */
export class NeedsTrust extends Error {
  constructor(reasons) {
    super(`needs your permission to run scripts: ${reasons.join('; ')}`);
    this.needsTrust = reasons;
    this.status = 409;
    this.code = 'NEEDS_PERMISSION';
  }
}

const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare'];

/** Packages (the root and everything installed under node_modules) that declare install-time scripts. */
function packagesWithInstallScripts(dir) {
  const found = [];
  const check = (pkgDir, label) => {
    try {
      const scripts = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).scripts ?? {};
      const hit = LIFECYCLE.filter((k) => scripts[k]);
      if (hit.length) found.push(`${label} (${hit.join(', ')})`);
    } catch { /* not a package */ }
  };
  check(dir, 'the plugin itself');
  const nm = join(dir, 'node_modules');
  let entries = [];
  try { entries = readdirSync(nm); } catch { return found; }
  for (const e of entries) {
    if (e.startsWith('.')) continue;
    if (e.startsWith('@')) { try { for (const s of readdirSync(join(nm, e))) check(join(nm, e, s), `${e}/${s}`); } catch { /* skip */ } } else check(join(nm, e), e);
  }
  return found;
}

/** After an install, every declared dependency must actually be there (npm can "succeed" for a dangling file: link). */
export function verifyDependencies(dir, pkg) {
  const missing = Object.keys(pkg.dependencies ?? {}).filter((d) => !existsSync(join(dir, 'node_modules', d, 'package.json')));
  if (missing.length) throw new Error(`the install finished but ${missing.length === 1 ? 'this dependency is' : 'these dependencies are'} missing: ${missing.join(', ')}. Nothing was activated.`);
}

/** Entry files named by package.json must exist; every .js/.mjs/.cjs must parse (`node --check`). */
export async function checkSnapshotLoads(dir, log) {
  const pkg = readJson(join(dir, 'package.json'));
  const wanted = new Set();
  const collect = (v) => {
    if (typeof v === 'string') { if (v.startsWith('./') && !v.includes('*') && /\.(c|m)?js$/.test(v)) wanted.add(v); }
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  collect(pkg.exports);
  if (typeof pkg.main === 'string') wanted.add(pkg.main.startsWith('./') ? pkg.main : `./${pkg.main}`);
  const missing = [...wanted].filter((f) => !existsSync(join(dir, f)));
  if (missing.length) throw new Error(`load check failed — package.json points at file(s) that do not exist: ${missing.join(', ')}. Nothing was activated; restore the files or fix package.json, commit, and Apply again.`);

  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(c|m)?js$/.test(e.name) && files.length < 3000) files.push(p);
    }
  };
  walk(dir);
  const bad = [];
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < files.length) {
      const f = files[next++];
      const r = await run(process.execPath, ['--check', f], { allowFail: true, timeoutMs: 30_000 });
      if (r.code !== 0) bad.push(`${relative(dir, f)}: ${(r.stderr.trim().split('\n').find((l) => /Error/.test(l)) ?? 'syntax error')}`);
    }
  }));
  if (bad.length) throw new Error(`load check failed — ${bad.length} file(s) do not parse:\n${bad.slice(0, 5).join('\n')}\nNothing was activated; fix the syntax, commit, and Apply again.`);
  log?.(`load check ok (${files.length} file(s) parse, entries exist)`);
}

/**
 * Atomically point `link` at `target`: a uniquely named temp symlink is created and
 * validated first, then renamed over the old link, so readers see the old target or
 * the new one, never neither. Refuses (without touching anything) when
 *   - `target` is not an existing directory inside `within` (managed storage), or
 *   - `link` is a real file or directory instead of a symlink.
 */
export function swapLink(link, target, { within } = {}) {
  let st;
  try { st = statSync(target); } catch { throw new Error(`refusing to activate ${basename(target)}: the snapshot does not exist. The current deployment was not touched.`); }
  if (!st.isDirectory()) throw new Error(`refusing to activate ${basename(target)}: it is not a directory. The current deployment was not touched.`);
  if (within) {
    const root = realpathSync(within);
    const real = realpathSync(target);
    if (real !== root && !real.startsWith(root + sep)) throw new Error(`refusing to activate ${target}: it resolves outside the managed folder ${within}. The current deployment was not touched.`);
  }
  let existing = null;
  try { existing = lstatSync(link); } catch { /* absent */ }
  if (existing && !existing.isSymbolicLink()) throw new Error(`refusing to replace ${link}: it is a real ${existing.isDirectory() ? 'directory' : 'file'}, not a symlink. Move it away yourself, then retry.`);
  const tmp = `${link}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  symlinkSync(target, tmp);
  try {
    if (resolve(dirname_(tmp), readlinkSync(tmp)) !== resolve(target)) throw new Error('temp symlink does not point at the target');
    faultPoint('activate');
    renameSync(tmp, link);
  } catch (err) {
    if (!isCrash(err)) rmSync(tmp, { force: true });
    throw err;
  }
}

function dirname_(p) { return resolve(p, '..'); }

export function currentSnapshot(env, name) {
  try { return readlinkSync(env.stableLink(name)); } catch { return null; }
}

function snapshotPath(env, name, sha) {
  return join(env.deployedDir, `${safeName(name)}@${sha.slice(0, 12)}`);
}

let pnpmAvailable;
async function hasPnpm() {
  if (pnpmAvailable === undefined) pnpmAvailable = (await run('pnpm', ['--version'], { allowFail: true }).catch(() => ({ code: 1 }))).code === 0;
  return pnpmAvailable;
}

/** Link every top-level entry of `dir` into `into` (scoped packages one level deeper). */
function linkEntries(into, dir) {
  for (const e of readdirSync(dir)) {
    if (e.startsWith('.')) continue;
    const src = join(dir, e);
    const dst = join(into, e);
    if (e.startsWith('@') && statSync(src).isDirectory()) {
      mkdirSync(dst, { recursive: true });
      linkEntries(dst, src);
      continue;
    }
    rmSync(dst, { force: true });
    symlinkSync(src, dst);
  }
}

/**
 * A real node_modules made of symlinks: every shared entry, then the package's
 * own nested modules on top (a few core packages pin private copies).
 */
function mergedNodeModules(target, shared, nested) {
  mkdirSync(target, { recursive: true });
  linkEntries(target, shared);
  linkEntries(target, nested);
}

/**
 * Make a snapshot runnable.
 *  - core: link node_modules to the dsh install's node_modules so the
 *    package's own imports resolve from its realpath (the snapshot).
 *  - profile, git origin with a build script: full install + build.
 *  - profile otherwise: production dependencies only (npm releases ship built code).
 * Peer dependencies are skipped: dsh resolves them to the runtime's copy.
 */
export async function prepareSnapshot(plugin, dir, log, { allowScripts = false } = {}) {
  if (plugin.kind === 'core') {
    if (plugin.core.nested && existsSync(plugin.core.nested)) {
      mergedNodeModules(join(dir, 'node_modules'), plugin.core.nodeModules, plugin.core.nested);
      log?.('linked shared node_modules + preserved nested modules');
    } else {
      symlinkSync(plugin.core.nodeModules, join(dir, 'node_modules'));
      log?.('linked shared node_modules');
    }
    return;
  }
  const pkg = readJson(join(dir, 'package.json'));
  const deps = Object.keys(pkg.dependencies ?? {});
  const build = plugin.source.type === 'git' && pkg.scripts?.build;
  faultPoint('install');
  if (build) {
    if (!allowScripts) throw new NeedsTrust(['it must run its own build script (npm run build) and install its dependencies']);
    if (existsSync(join(dir, 'pnpm-lock.yaml')) && await hasPnpm()) {
      await run('pnpm', ['install', '--ignore-workspace', '--frozen-lockfile=false', '--config.auto-install-peers=false'], { cwd: dir, log });
    } else {
      await run('npm', ['install', '--legacy-peer-deps', '--no-audit', '--no-fund'], { cwd: dir, log });
    }
    faultPoint('build');
    await run('npm', ['run', 'build'], { cwd: dir, log });
    verifyDependencies(dir, pkg);
  } else if (deps.length) {
    const base = ['install', '--omit=dev', '--legacy-peer-deps', '--no-package-lock', '--no-audit', '--no-fund'];
    if (allowScripts) {
      await run('npm', base, { cwd: dir, log });
      verifyDependencies(dir, pkg);
    } else {
      await run('npm', [...base, '--ignore-scripts'], { cwd: dir, log });
      verifyDependencies(dir, pkg);
      const withScripts = packagesWithInstallScripts(dir);
      if (withScripts.length) throw new NeedsTrust([`these would run install scripts: ${withScripts.slice(0, 8).join(', ')}${withScripts.length > 8 ? ', …' : ''}`]);
    }
  } else {
    log?.('no dependencies to install');
  }
}

async function removeSnapshot(repoDir, dir) {
  // Never let a recursive delete walk into the shared core node_modules.
  // rmSync never follows symlinks, so this removes only our links / the snapshot's own installs.
  rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
  await git(repoDir, ['worktree', 'remove', '--force', dir], { allowFail: true });
}

/**
 * Keep the live snapshot, the rollback target (the previous deployment) and the newest
 * others, up to `keep` in total. Never deletes the live one or anything in `protect`
 * (a set of 12-char shas); a snapshot that is already gone is simply skipped.
 */
export function planPrune(env, plugin, { keep = DEFAULT_KEEP_SNAPSHOTS, protect = new Set() } = {}) {
  const prefix = `${safeName(plugin.name)}@`;
  const live = currentSnapshot(env, plugin.name);
  let entries;
  try { entries = readdirSync(env.deployedDir).filter((e) => e.startsWith(prefix) && !e.includes('.tmp-')); } catch { return []; }
  const full = entries.map((e) => join(env.deployedDir, e));
  const isProtected = (p) => p === live || protect.has(basename(p).slice(prefix.length));
  const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
  const keepCount = Math.max(1, Number(keep) || DEFAULT_KEEP_SNAPSHOTS);
  const kept = full.filter(isProtected);
  const others = full.filter((p) => !isProtected(p)).sort((a, b) => mtime(b) - mtime(a));
  return others.slice(Math.max(0, keepCount - kept.length));
}

export async function pruneSnapshots(env, plugin, log, opts = {}) {
  for (const old of planPrune(env, plugin, opts)) {
    await removeSnapshot(env.repoDir(plugin.name), old);
    log?.(`pruned snapshot ${basename(old)}`);
  }
  await git(env.repoDir(plugin.name), ['worktree', 'prune'], { allowFail: true });
}

/**
 * Deploy `ref` (default: `local` HEAD) of a plugin. Returns the deployed sha.
 * On any failure the stable link is left exactly as it was.
 */
export async function deployCommit(env, plugin, ref = 'local', log, { allowScripts = false, txn = null, keep = DEFAULT_KEEP_SNAPSHOTS, protect = new Set() } = {}) {
  const repoDir = env.repoDir(plugin.name);
  const sha = await revParse(repoDir, ref);
  if (!sha) throw new Error(`unknown commit ${ref}: there is no such commit in this plugin's repo, so nothing was deployed. Pick one from "Deploy older commit…".`);
  const snap = snapshotPath(env, plugin.name, sha);
  mkdirSync(env.deployedDir, { recursive: true });
  if (existsSync(snap) && !existsSync(join(snap, READY))) {
    if (currentSnapshot(env, plugin.name) === snap) {
      writeFileSync(join(snap, READY), `${sha}\n`); // deployed before markers existed and already live: trust it
    } else {
      log?.(`snapshot ${basename(snap)} was left unfinished — rebuilding`);
      await removeSnapshot(repoDir, snap);
      rmSync(snap, { recursive: true, force: true });
      await git(repoDir, ['worktree', 'prune'], { allowFail: true });
    }
  }
  if (!existsSync(snap)) {
    log?.(`snapshot ${basename(snap)}`);
    await git(repoDir, ['worktree', 'prune'], { allowFail: true }); // a snapshot deleted by hand leaves a stale registration
    await git(repoDir, ['worktree', 'add', '-q', '--detach', snap, sha]);
    if (txn) phase(env, txn, 'snapshot', { snapshot: snap, sha });
    try {
      faultPoint('prepare');
      await prepareSnapshot(plugin, snap, log, { allowScripts });
      await checkSnapshotLoads(snap, log);
      writeFileSync(join(snap, READY), `${sha}\n`);
      if (txn) phase(env, txn, 'prepared');
    } catch (err) {
      if (isCrash(err)) throw err; // a real crash would leave the half-built snapshot behind; recovery handles it
      log?.(`prepare failed — live plugin unchanged`);
      await removeSnapshot(repoDir, snap);
      throw err;
    }
  } else {
    log?.(`reusing snapshot ${basename(snap)}`);
  }
  swapLink(env.stableLink(plugin.name), snap, { within: env.deployedDir });
  if (txn) phase(env, txn, 'activated');
  log?.(`live link -> ${basename(snap)}`);
  faultPoint('cleanup');
  await pruneSnapshots(env, plugin, log, { keep, protect });
  return sha;
}

/** Remove every snapshot and the stable link (used when a plugin is forgotten). */
export async function removeAllSnapshots(env, plugin) {
  const prefix = `${safeName(plugin.name)}@`;
  try { unlinkSync(env.stableLink(plugin.name)); } catch { /* absent */ }
  let entries = [];
  try { entries = readdirSync(env.deployedDir).filter((e) => e.startsWith(prefix)); } catch { /* none */ }
  for (const e of entries) await removeSnapshot(env.repoDir(plugin.name), join(env.deployedDir, e));
}
