// RULE: dsh only ever runs a commit.
//
// A deploy materializes one exact commit as a detached worktree
//   $root/.deployed/<safe>@<sha12>
// prepares it (dependency install / build, or the core node_modules link),
// and only then atomically repoints the stable link
//   $root/.deployed/<safe>  ->  <safe>@<sha12>
// which is what dsh is wired to. The editing tree, uncommitted edits and
// half-merged update trees can never reach dsh.
import { existsSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { git, revParse } from './git.js';
import { run } from './run.js';
import { readJson, safeName } from './env.js';

const KEEP_SNAPSHOTS = 3;

/** Atomically point `link` at `target` (temp symlink + rename over the old one). */
export function swapLink(link, target) {
  const tmp = `${link}.tmp-${process.pid}-${Date.now()}`;
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}

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
export async function prepareSnapshot(plugin, dir, log) {
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
  if (build) {
    if (existsSync(join(dir, 'pnpm-lock.yaml')) && await hasPnpm()) {
      await run('pnpm', ['install', '--ignore-workspace', '--frozen-lockfile=false', '--config.auto-install-peers=false'], { cwd: dir, log });
    } else {
      await run('npm', ['install', '--legacy-peer-deps', '--no-audit', '--no-fund'], { cwd: dir, log });
    }
    await run('npm', ['run', 'build'], { cwd: dir, log });
  } else if (deps.length) {
    await run('npm', ['install', '--omit=dev', '--legacy-peer-deps', '--no-package-lock', '--no-audit', '--no-fund'], { cwd: dir, log });
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

/** Keep the live snapshot plus the newest others, up to KEEP_SNAPSHOTS. */
export async function pruneSnapshots(env, plugin, log) {
  const prefix = `${safeName(plugin.name)}@`;
  const live = currentSnapshot(env, plugin.name);
  let entries;
  try { entries = readdirSync(env.deployedDir).filter((e) => e.startsWith(prefix)); } catch { return; }
  const others = entries.map((e) => join(env.deployedDir, e)).filter((p) => p !== live)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const old of others.slice(KEEP_SNAPSHOTS - 1)) {
    await removeSnapshot(env.repoDir(plugin.name), old);
    log?.(`pruned snapshot ${basename(old)}`);
  }
  await git(env.repoDir(plugin.name), ['worktree', 'prune'], { allowFail: true });
}

/**
 * Deploy `ref` (default: `local` HEAD) of a plugin. Returns the deployed sha.
 * On any failure the stable link is left exactly as it was.
 */
export async function deployCommit(env, plugin, ref = 'local', log) {
  const repoDir = env.repoDir(plugin.name);
  const sha = await revParse(repoDir, ref);
  if (!sha) throw new Error(`unknown commit ${ref}`);
  const snap = snapshotPath(env, plugin.name, sha);
  mkdirSync(env.deployedDir, { recursive: true });
  if (!existsSync(snap)) {
    log?.(`snapshot ${basename(snap)}`);
    await git(repoDir, ['worktree', 'add', '-q', '--detach', snap, sha]);
    try {
      await prepareSnapshot(plugin, snap, log);
    } catch (err) {
      log?.(`prepare failed — live plugin unchanged`);
      await removeSnapshot(repoDir, snap);
      throw err;
    }
  } else {
    log?.(`reusing snapshot ${basename(snap)}`);
  }
  swapLink(env.stableLink(plugin.name), snap);
  log?.(`live link -> ${basename(snap)}`);
  await pruneSnapshots(env, plugin, log);
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
