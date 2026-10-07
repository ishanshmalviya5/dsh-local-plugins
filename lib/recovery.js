// Startup recovery and reconciliation.
//
// recoverInterrupted(): the journal (lib/txn.js) lists operations a dead process never
//   finished. Each is finished or rolled back so that the user ends up with EITHER the
//   previous valid deployment OR the new one, never something in between.
// sweepStale():          deletes only artifacts this plugin created and can rebuild
//   (temp links/files of dead processes, unfinished snapshots, abandoned clones).
// reconcile():           compares registry <-> filesystem <-> git <-> the dsh install and
//   reports disagreements. Safe fixes are applied; everything else is reported, never guessed.
//
// Nothing here ever deletes a backup, a repo, a stash or a branch.
import { writeFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { git, out, revParse } from './git.js';
import { listTxns, pidAlive } from './txn.js';
import { currentSnapshot, swapLink, checkSnapshotLoads } from './deploy.js';
import { coreLinked, moveDir, profileLinked } from './link.js';
import { safeName } from './env.js';

const READY = '.lpm-ready';
const lstatSafe = (p) => { try { return lstatSync(p); } catch { return null; } };
const NOTICE_MAX = 50;

export function addNotice(reg, notice) {
  reg.notices = Array.isArray(reg.notices) ? reg.notices : [];
  const n = { id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, at: Date.now(), dismissed: false, kind: 'info', ...notice };
  reg.notices.unshift(n);
  reg.notices.length = Math.min(reg.notices.length, NOTICE_MAX);
  return n;
}

/** The sha a snapshot was built from (its READY marker), or null when it is not a finished snapshot. */
export function snapshotSha(dir) {
  try { return readFileSync(join(dir, READY), 'utf8').trim() || null; } catch { return null; }
}

function stableTarget(env, name) {
  const t = currentSnapshot(env, name);
  if (!t) return null;
  return existsSync(t) ? t : null;
}

// ---------- permissions ----------

/** The managed folders hold backups of the dsh install and plugin sources: keep them private to the user. */
export function secureDirs(env, log) {
  const fixed = [];
  for (const d of [env.root, env.backupDir, env.txnDir, env.trashDir, join(env.root, 'logs')]) {
    try {
      if (!existsSync(d)) { if (d === env.root) mkdirSync(d, { recursive: true, mode: 0o700 }); else continue; }
      const st = statSync(d);
      if ((st.mode & 0o077) !== 0) { chmodSync(d, 0o700); fixed.push(d); log?.(`made ${d} private (0700)`); }
    } catch (err) { log?.(`could not tighten permissions on ${d}: ${err.message}`); }
  }
  return fixed;
}

// ---------- stale artifacts ----------

/** Remove leftovers that are safe and cheap to rebuild. Returns what was removed. */
export async function sweepStale(env, reg, { log, protect = new Set() } = {}) {
  const removed = [];
  const note = (what) => { removed.push(what); log?.(`cleaned up ${what}`); };
  const deadTemp = (name) => {
    const m = /\.tmp-(\d+)(?:-|$)/.exec(name);
    return m ? (!pidAlive(Number(m[1])) || Number(m[1]) === process.pid) : false; // repair runs exclusively, so our own leftovers are stale too
  };

  // temp symlinks from an interrupted atomic swap
  for (const dir of [env.deployedDir, env.txnDir, env.root]) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.includes('.tmp-') || !deadTemp(n)) continue;
      const p = join(dir, n);
      const st = lstatSafe(p);
      if (!st) continue;
      if (st.isSymbolicLink() || st.isFile()) { unlinkSync(p); note(`stale temp ${n}`); }
    }
  }

  // abandoned clones from "Add" (rebuildable from the origin)
  try {
    for (const n of readdirSync(env.root)) {
      const m = /^\.adding-(\d+)$/.exec(n);
      if (m && Date.now() - Number(m[1]) > 10 * 60_000) { rmSync(join(env.root, n), { recursive: true, force: true }); note(`abandoned download ${n}`); }
    }
  } catch { /* no root yet */ }

  // unfinished snapshots (no READY marker): rebuildable from git; never the live one
  let snaps = [];
  try { snaps = readdirSync(env.deployedDir).filter((n) => n.includes('@') && !n.includes('.tmp-')); } catch { /* none */ }
  const bySafe = new Map(Object.values(reg.plugins).map((p) => [safeName(p.name), p]));
  // anything ANY stable link points at is live, whoever owns it (this manager's own deployment included)
  const linked = new Set();
  try {
    for (const n of readdirSync(env.deployedDir)) {
      const lp = join(env.deployedDir, n);
      if (lstatSafe(lp)?.isSymbolicLink()) { try { linked.add(resolve(env.deployedDir, readlinkSync(lp))); } catch { /* unreadable */ } }
    }
  } catch { /* no deployments yet */ }
  for (const n of snaps) {
    const p = join(env.deployedDir, n);
    const st = lstatSafe(p);
    if (!st?.isDirectory() || existsSync(join(p, READY)) || protect.has(p) || linked.has(resolve(p))) continue;
    const plugin = bySafe.get(n.slice(0, n.lastIndexOf('@')));
    if (!plugin) continue; // not a tracked plugin's snapshot (e.g. the manager itself): never ours to delete
    rmSync(join(p, 'node_modules'), { recursive: true, force: true }); // never follows symlinks
    if (plugin) await git(env.repoDir(plugin.name), ['worktree', 'remove', '--force', p], { allowFail: true });
    rmSync(p, { recursive: true, force: true });
    if (plugin) await git(env.repoDir(plugin.name), ['worktree', 'prune'], { allowFail: true });
    note(`unfinished snapshot ${n}`);
  }
  return removed;
}

// ---------- interrupted operations ----------

/**
 * Finish or roll back every journal entry a dead process left behind.
 * Mutates `reg` (caller saves). Returns { handled, kept } where `kept` are entries
 * that could not be understood (left on disk for a human).
 */
export async function recoverInterrupted(env, reg, { log } = {}) {
  const handled = [];
  const kept = [];
  for (const t of listTxns(env)) {
    if (t.corrupt) { kept.push({ id: t.id, reason: `unreadable journal entry: ${t.error}` }); continue; }
    if (t.pid !== process.pid && pidAlive(t.pid)) { kept.push({ id: t.id, reason: `still owned by running process ${t.pid}` }); continue; }
    const p = reg.plugins[t.plugin];
    const where = `${t.op} of ${t.plugin} (stopped at "${t.phase}")`;
    let outcome;
    try {
      outcome = p ? await recoverOne(env, reg, p, t, log) : { message: 'plugin is no longer tracked; nothing to recover' };
    } catch (err) {
      kept.push({ id: t.id, reason: `${where}: recovery failed — ${err.message}` });
      log?.(`recovery of ${where} failed: ${err.message}`);
      continue;
    }
    rmSync(t.file, { force: true });
    handled.push({ id: t.id, plugin: t.plugin, op: t.op, phase: t.phase, ...outcome });
    log?.(`recovered ${where}: ${outcome.message}`);
    if (p && outcome.notice !== false) {
      addNotice(reg, { kind: outcome.kind ?? 'crash-recovery', plugin: outcome.kind === 'info' ? null : t.plugin, title: `${t.plugin}: an interrupted ${t.op} was recovered`, message: outcome.message, rescued: outcome.rescued ?? null });
    }
  }
  return { handled, kept };
}

async function recoverOne(env, reg, p, t, log) {
  if (t.op === 'apply' || t.op === 'restore') {
    return p.kind === 'core' ? recoverCore(env, reg, p, t, log) : recoverProfile(env, reg, p, t);
  }
  if (t.op === 'delete') {
    // moved to the trash but the registry still lists it: finish the removal; otherwise nothing happened
    if (!existsSync(env.repoDir(t.plugin)) && t.trash && existsSync(t.trash)) {
      delete reg.plugins[t.plugin];
      return { kind: 'info', message: `the delete had moved your repo to ${t.trash}; the plugin was removed from the list. Move that folder back to undo it.` };
    }
    return { message: 'the delete had not started; nothing was changed.', notice: false };
  }
  return { message: `no live changes were made by ${t.op}`, notice: false };
}

/** Live-state truth for a profile plugin after an interrupted apply/restore. */
function recoverProfile(env, reg, p, t) {
  const linked = profileLinked(env, p);
  if (t.op === 'apply') {
    if (linked && stableTarget(env, p.name)) {
      adopt(env, p, reg);
      return { message: 'the new deployment was fully linked; the registry was brought up to date. Restart dsh web to load it.' };
    }
    return { message: `the previous state is intact (stopped before dsh was re-linked); nothing was changed. Run Apply again.`, notice: t.phase !== 'begin' };
  }
  if (!linked) { p.applied = false; return { message: 'the original plugin is installed again; the registry was brought up to date.' }; }
  return { message: 'the restore did not complete; the local plugin is still active. Run Restore original again.' };
}

/** Record the live deployment (what the stable link points at) as the registry's truth. */
function adopt(env, p, reg) {
  const snap = stableTarget(env, p.name);
  const sha = snap ? snapshotSha(snap) : null;
  p.applied = true;
  p.linkLost = false;
  if (sha) {
    p.deployedSha = sha;
    p.deployHistory = [sha, ...(p.deployHistory ?? []).filter((x) => x !== sha)].slice(0, 20);
  }
  reg.restartNeeded = true;
}

/**
 * Core packages: the dsh install itself was being edited. The only states that matter:
 *   path is a symlink to a valid stable link  -> override complete
 *   path missing, backup present              -> put the original back (never leave dsh without the package)
 *   path is a real directory                  -> original is in place
 */
async function recoverCore(env, reg, p, t, log) {
  const path = p.core.path;
  const st = lstatSafe(path);
  const backup = t.backup ?? t.core?.backup ?? p.core.backup ?? null;
  const stable = stableTarget(env, p.name);

  if (st?.isSymbolicLink()) {
    if (coreLinked(env, p) && stable) {
      if (t.op === 'apply') { adopt(env, p, reg); return { message: 'the override was completely in place; the registry was brought up to date. Restart dsh web to load it.' }; }
      return { message: 'the restore did not finish; the local override is still active. Run Restore original again.' };
    }
    // a link into nowhere would crash dsh: take it away and restore the original
    unlinkSync(path);
  } else if (st?.isDirectory()) {
    p.applied = false;
    return { message: 'the original package folder is in place; nothing was lost.' };
  }

  if (backup && existsSync(backup)) {
    const rescued = await rescueWork(env, p, t, log);
    moveDir(backup, path);
    p.core.backup = null;
    p.applied = false;
    p.linkLost = false;
    reg.restartNeeded = true;
    return {
      message: `dsh was interrupted while ${t.op === 'apply' ? 'installing' : 'removing'} your changes to ${p.name}. The original dsh package was put back from the backup, so dsh keeps working. ${rescued ? `Your work is safe: ${rescued.summary}. ` : ''}Use "Work on it" to re-apply your changes.`,
      rescued,
    };
  }
  throw new Error(`${path} is missing and no backup was found at ${backup ?? '(none recorded)'} — reinstall dsh, or restore the package by hand`);
}

// ---------- safety copy of the user's work ----------

/**
 * Preserve everything the user has on `local` before reverting live code: uncommitted
 * edits go to a git stash, committed work gets a rescue branch. Neither touches `local`.
 */
export async function rescueWork(env, p, t, log) {
  const dir = env.repoDir(p.name);
  if (!existsSync(join(dir, '.git'))) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const result = { branch: null, stash: null, summary: '' };
  const head = await revParse(dir, 'local');
  if (head) {
    const branch = `lpm-rescue/${stamp}`;
    await git(dir, ['branch', branch, head], { allowFail: true });
    result.branch = branch;
  }
  const dirty = (await out(dir, ['status', '--porcelain', '--untracked-files=all'])).length > 0;
  if (dirty) {
    const r = await git(dir, ['stash', 'push', '--include-untracked', '-m', `lpm rescue ${stamp} (${t?.op ?? 'crash'} interrupted)`], { allowFail: true });
    if (r.code === 0) result.stash = (await out(dir, ['stash', 'list', '-1', '--format=%gd'])) || 'stash@{0}';
  }
  result.summary = [result.branch && `committed work is on branch ${result.branch}`, result.stash && `uncommitted edits are in ${result.stash}`].filter(Boolean).join(' and ') || 'there was nothing uncommitted';
  log?.(`rescued work: ${result.summary}`);
  return result;
}

// ---------- upgrading from v0.1 ----------

/**
 * v0.1 deployed snapshots without the ".lpm-ready" marker. A live one is adopted (marked
 * finished) only when it is provably the deployment the registry names: the worktree's HEAD
 * is the registry's deployedSha, and it passes the same load check a new deployment must.
 * Anything else is left alone and reported by reconcile().
 */
export async function adoptLegacySnapshots(env, reg, { log } = {}) {
  const adopted = [];
  for (const p of Object.values(reg.plugins)) {
    if (!p.applied || !p.deployedSha) continue;
    const target = stableTarget(env, p.name);
    if (!target || snapshotSha(target)) continue;
    const head = await git(target, ['rev-parse', 'HEAD'], { allowFail: true });
    if (head.code !== 0 || head.stdout.trim() !== p.deployedSha) { log?.(`${p.name}: live snapshot is not at ${p.deployedSha.slice(0, 12)}; not adopting it`); continue; }
    try {
      await checkSnapshotLoads(target);
    } catch (err) { log?.(`${p.name}: live snapshot from an older version failed the load check, so it was not adopted: ${String(err.message).split('\n')[0]}`); continue; }
    writeFileSync(join(target, READY), `${p.deployedSha}\n`);
    adopted.push(p.name);
    log?.(`${p.name}: adopted the live deployment made by an earlier version (${p.deployedSha.slice(0, 12)})`);
  }
  return adopted;
}

// ---------- reconciliation ----------

/**
 * Compare the registry with the world. Returns issues
 *   { plugin, code, severity: 'error'|'warn'|'info', message, fixed?: boolean }
 * With `fix`, repairs the ones that cannot lose anything (re-point a link at an existing
 * finished snapshot, correct the registry to match reality).
 */
export async function reconcile(env, reg, { fix = false, log } = {}) {
  const issues = [];
  const add = (plugin, code, severity, message, fixed = false) => issues.push({ plugin, code, severity, message, fixed });

  for (const p of Object.values(reg.plugins)) {
    const repo = env.repoDir(p.name);
    if (!existsSync(join(repo, '.git'))) { add(p.name, 'REPO_MISSING', 'error', `the repo ${repo} is missing; the plugin cannot be applied or updated until it is restored from a backup`); continue; }
    if (!p.applied) continue;

    const stable = env.stableLink(p.name);
    const st = lstatSafe(stable);
    const target = stableTarget(env, p.name);
    if (!st) {
      add(p.name, 'STABLE_MISSING', 'error', `the registry says ${p.name} is applied but ${stable} does not exist`);
    } else if (!st.isSymbolicLink()) {
      add(p.name, 'STABLE_NOT_A_LINK', 'error', `${stable} is a real ${st.isDirectory() ? 'directory' : 'file'}, not a link; it was not touched`);
    } else if (!target) {
      add(p.name, 'STABLE_DANGLING', 'error', `${stable} points at ${readlinkSync(stable)}, which no longer exists`);
    } else if (!snapshotSha(target)) {
      add(p.name, 'SNAPSHOT_UNFINISHED', 'error', `the live snapshot ${basename(target)} was never marked finished (an interrupted build?)`);
    } else if (p.deployedSha && snapshotSha(target) !== p.deployedSha) {
      add(p.name, 'SHA_MISMATCH', 'warn', `the registry says ${p.deployedSha.slice(0, 12)} is deployed but the live snapshot is ${snapshotSha(target).slice(0, 12)}`, fix);
      if (fix) { adopt(env, p, reg); }
    }

    // dangling/missing stable link: re-point at the registry's deployed snapshot if it is finished
    if (fix && (!st || (st.isSymbolicLink() && !target)) && p.deployedSha) {
      const candidate = join(env.deployedDir, `${safeName(p.name)}@${p.deployedSha.slice(0, 12)}`);
      if (existsSync(candidate) && snapshotSha(candidate) === p.deployedSha) {
        swapLink(stable, candidate, { within: env.deployedDir });
        log?.(`re-pointed ${p.name} at ${basename(candidate)}`);
        const last = issues.at(-1);
        last.fixed = true;
      }
    }

    if (p.kind === 'core') {
      const path = p.core.path;
      const pst = lstatSafe(path);
      if (!pst) add(p.name, 'CORE_MISSING', 'error', `${path} does not exist; dsh will fail to load ${p.name}. Use Repair installation (restores from backup).`);
      else if (!pst.isSymbolicLink()) add(p.name, 'CORE_NOT_OVERRIDDEN', 'warn', `the registry says ${p.name} is overridden but ${path} is the normal package again (a dsh upgrade?)`);
      else if (!coreLinked(env, p)) add(p.name, 'CORE_WRONG_LINK', 'error', `${path} is a symlink to ${readlinkSync(path)}, not to the managed deployment`);
      if (p.core.backup && !existsSync(p.core.backup)) add(p.name, 'BACKUP_MISSING', 'warn', `the recorded backup ${p.core.backup} is gone; Restore would have to re-download the original from npm`);
    }
  }

  // things on disk the registry knows nothing about: report only
  const tracked = new Set(Object.keys(reg.plugins).map(safeName));
  for (const [dir, code, what] of [[env.backupDir, 'ORPHAN_BACKUP', 'backup'], [env.deployedDir, 'ORPHAN_SNAPSHOT', 'deployment']]) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (n.includes('.tmp-')) continue;
      const owner = n.slice(0, n.lastIndexOf('@') === -1 ? n.length : n.lastIndexOf('@'));
      if (!tracked.has(owner)) add(null, code, 'info', `${what} ${n} belongs to no tracked plugin (kept; delete it yourself if you do not need it)`);
    }
  }
  return issues;
}
