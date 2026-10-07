import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorld, g } from './helpers.js';
import { loadRegistry } from '../lib/registry.js';
import { createOps } from '../lib/ops.js';
import { adviceFor, failureTitle } from '../lib/messages.js';

let w;
beforeEach(() => { w = makeWorld(); delete process.env.LPM_FAIL_AT; });
afterEach(() => { delete process.env.LPM_FAIL_AT; delete process.env.LPM_KEEP_SNAPSHOTS; w.cleanup(); });
const reg = () => loadRegistry(w.env.registryFile);
const repo = (n) => w.env.repoDir(n);
let n = 0;
async function edit(name, text = `v${++n}`) {
  writeFileSync(join(repo(name), 'index.js'), `export const line = ${JSON.stringify(text)};\n`);
  await w.mgr.commit({ name, message: text }, w.log);
}
const trashEntries = () => { try { return readdirSync(w.env.trashDir); } catch { return []; } };

test('Delete: needs the typed name, refuses while applied, then moves the repo (commits and all) to the trash', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  await edit('lpm-npm', 'precious work');
  await w.mgr.apply({ name: 'lpm-npm' }, w.log);

  await assert.rejects(w.mgr.deletePlugin({ name: 'lpm-npm', confirmName: 'nope' }, w.log), (e) => e.code === 'CONFIRMATION_MISMATCH' && e.status === 400);
  await assert.rejects(w.mgr.deletePlugin({ name: 'lpm-npm', confirmName: 'lpm-npm' }, w.log), (e) => e.code === 'NOT_UNLINKED' && /Unlink it first/.test(e.message));
  assert.ok(existsSync(repo('lpm-npm')), 'nothing moved');

  await w.mgr.restore({ name: 'lpm-npm' }, w.log);        // "Unlink"
  const r = await w.mgr.deletePlugin({ name: 'lpm-npm', confirmName: 'lpm-npm' }, w.log);
  assert.ok(!existsSync(repo('lpm-npm')));
  assert.ok(existsSync(r.trash) && r.trash.startsWith(w.env.trashDir));
  assert.match(g(r.trash, 'log', '-1', '--format=%s', 'local'), /precious work/, 'every commit is in the trash');
  assert.deepEqual(Object.keys(reg().plugins), []);
  assert.ok(!existsSync(w.env.stableLink('lpm-npm')), 'deployment link gone');
  assert.deepEqual(readdirSync(w.env.deployedDir).filter((x) => x.startsWith('lpm-npm@')), [], 'snapshots gone');
  const note = reg().notices.find((x) => /removed from the list/.test(x.title));
  assert.ok(note && note.message.includes(r.trash));
  assert.equal(note.plugin, null);
});

test('Delete is refused during an unfinished update', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  const r = reg(); r.plugins['lpm-npm'].pending = { worktree: join(w.env.workDir, 'x'), branch: 'b', conflicts: ['a'], target: '2' };
  (await import('../lib/registry.js')).saveRegistry(w.env.registryFile, r);
  await assert.rejects(w.mgr.deletePlugin({ name: 'lpm-npm', confirmName: 'lpm-npm' }, w.log), (e) => e.code === 'INVALID_STATE_CONFLICT');
});

test('moving the repo back from the trash and running Repair tracks it again (not applied)', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  await edit('lpm-npm', 'keep me');
  const { trash } = await w.mgr.deletePlugin({ name: 'lpm-npm', confirmName: 'lpm-npm' }, w.log);
  renameSync(trash, repo('lpm-npm'));
  await w.mgr.repair(w.log);
  const p = reg().plugins['lpm-npm'];
  assert.ok(p && p.applied === false && p.kind === 'profile');
  assert.match(g(repo('lpm-npm'), 'log', '-1', '--format=%s', 'local'), /keep me/);
  await w.mgr.apply({ name: 'lpm-npm' }, w.log);          // and it is fully usable
  assert.equal(reg().plugins['lpm-npm'].applied, true);
});

test('crash during Delete: before the move nothing changed; after the move Repair finishes the removal and tells you where the repo is', async () => {
  for (const [stage, expectGone] of [['moving', false], ['moved', true]]) {
    const w2 = makeWorld();
    try {
      await w2.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w2.log);
      process.env.LPM_FAIL_AT = `${stage}:crash`;
      await assert.rejects(w2.mgr.deletePlugin({ name: 'lpm-npm', confirmName: 'lpm-npm' }, w2.log), /injected crash/);
      delete process.env.LPM_FAIL_AT;
      await w2.mgr.repair(w2.log);
      const r = loadRegistry(w2.env.registryFile);
      if (expectGone) {
        assert.deepEqual(Object.keys(r.plugins), [], `${stage}: removal completed`);
        assert.equal(readdirSync(w2.env.trashDir).length, 1);
        assert.ok(r.notices.some((x) => /Move that folder back/.test(x.message)));
      } else {
        assert.ok(r.plugins['lpm-npm'] && existsSync(w2.env.repoDir('lpm-npm')), `${stage}: plugin intact`);
      }
    } finally { delete process.env.LPM_FAIL_AT; w2.cleanup(); }
  }
});

test('disk usage: per plugin repo / snapshots / worktrees / backups, plus the trash and a total', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  await edit('lpm-npm');
  await w.mgr.apply({ name: 'lpm-npm' }, w.log);
  const u = await w.mgr.diskUsage();
  const p = u.plugins['lpm-npm'];
  assert.ok(p.repo > 0 && p.snapshots > 0 && p.snapshotCount === 1);
  assert.equal(p.total, p.repo + p.snapshots + p.worktrees + p.backups);
  assert.equal(u.trash, 0);
  assert.equal(u.total, p.total + u.trash);
  await w.mgr.restore({ name: 'lpm-npm' }, w.log);
  await w.mgr.deletePlugin({ name: 'lpm-npm', confirmName: 'lpm-npm' }, w.log);
  const after = await w.mgr.diskUsage();
  assert.ok(after.trash > 0, 'the trash is counted');
  assert.deepEqual(after.plugins, {});
});

test('cleanup previews first, then removes only snapshots beyond retention (never live or rollback target)', async () => {
  process.env.LPM_KEEP_SNAPSHOTS = '6';
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  const shas = [];
  for (let i = 0; i < 5; i++) { await edit('lpm-npm'); await w.mgr.apply({ name: 'lpm-npm' }, w.log); shas.push(reg().plugins['lpm-npm'].deployedSha.slice(0, 12)); }
  const have = () => readdirSync(w.env.deployedDir).filter((x) => x.startsWith('lpm-npm@')).map((x) => x.slice(8));
  assert.equal(have().length, 5);

  process.env.LPM_KEEP_SNAPSHOTS = '2';
  const preview = await w.mgr.cleanup({}, w.log);
  assert.equal(preview.executed, false);
  assert.equal(preview.snapshots.length, 3);
  assert.ok(preview.bytes > 0);
  assert.equal(have().length, 5, 'a preview changes nothing');

  const done = await w.mgr.cleanup({ execute: true }, w.log);
  assert.equal(done.executed, true);
  assert.deepEqual(have().sort(), [shas[4], shas[3]].sort(), 'live (newest) and the rollback target (previous) survive');
  assert.equal((await w.mgr.cleanup({ execute: true }, w.log)).snapshots.length, 0, 'idempotent');
});

test('operation history lists newest first with titles, durations and advice for failures', async () => {
  const ops = createOps();
  const ok = ops.start('commit', 'a', async () => ({}), { action: 'commit', body: {} }); await ok.promise;
  const bad = ops.start('apply', 'b', async () => { throw Object.assign(new Error('npm run build exited 1'), { code: 'COMMAND_FAILED' }); }, { action: 'apply', body: { name: 'b' } }); await bad.promise;
  const h = ops.history();
  assert.deepEqual(h.map((o) => [o.kind, o.status]), [['apply', 'error'], ['commit', 'ok']]);
  assert.equal(h[0].title, 'Apply failed');
  assert.match(h[0].advice.safe, /previous deployment/);
  assert.match(h[0].advice.next, /failing step/);
  assert.equal(typeof h[0].durationMs, 'number');
  assert.equal(h[0].log, undefined, 'history rows carry no logs; op(id) has them');
  assert.equal(h[1].advice, null);
});

test('every failure answers: what happened, is it safe, what next — for every action and known code', () => {
  const actions = ['apply', 'rollback', 'update', 'finish update', 'abort', 'restore original', 'commit', 'setDep', 'migrate', 'add', 'check', 'repair', 'reapply all', 'trust', 'delete', 'cleanup', 'startup recovery'];
  const codes = [null, 'NEEDS_PERMISSION', 'COMMAND_TIMEOUT', 'COMMAND_FAILED', 'BUSY', 'PACKAGE_RENAMED', 'INCOMPATIBLE_MANIFEST', 'NPM_UNREACHABLE', 'NPM_PACKAGE_NOT_FOUND', 'NPM_VERSION_NOT_FOUND', 'ORIGIN_UNREACHABLE', 'GIT_REF_NOT_FOUND', 'UNSAFE_ARCHIVE', 'INVALID_STATE_CONFLICT', 'INVALID_STATE_DISABLED', 'NOT_UNLINKED', 'CONFIRMATION_MISMATCH', 'REGISTRY_CORRUPT', 'SOMETHING_UNKNOWN'];
  const vague = /^(failed|error|invalid|something went wrong)\.?$/i;
  for (const action of actions) {
    assert.match(failureTitle(action), /failed$/);
    for (const code of codes) {
      const a = adviceFor({ action, code });
      assert.ok(a.safe.length > 20 && a.next.length > 20, `${action}/${code}`);
      assert.ok(!vague.test(a.safe) && !vague.test(a.next));
    }
  }
  assert.match(adviceFor({ action: 'apply', code: null }).safe, /previous deployment/);
  assert.match(adviceFor({ action: 'update', code: 'ORIGIN_UNREACHABLE' }).safe, /unchanged/);
});

test('the operation log records which commit and snapshot an Apply produced', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const logFile = join(mkdtempSync(join(tmpdir(), 'lpm-oplog-')), 'ops.jsonl');
  const ops = createOps({ logFile });
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  await edit('lpm-npm');
  const op = ops.start('apply', 'lpm-npm', (log) => w.mgr.apply({ name: 'lpm-npm' }, log), { action: 'apply', body: { name: 'lpm-npm' } });
  await op.promise;
  const line = JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n').at(-1));
  assert.equal(line.action, 'apply');
  assert.equal(line.commit, reg().plugins['lpm-npm'].deployedSha);
  assert.equal(line.snapshot, `lpm-npm@${line.commit.slice(0, 12)}`);
  assert.equal(line.status, 'ok');
});

test('leftover trial-merge folders are reported, listed in the cleanup preview, and removed only on confirmation; an owned one is never touched', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  mkdirSync(join(w.env.workDir, 'stray'), { recursive: true });
  writeFileSync(join(w.env.workDir, 'stray', 'half.txt'), 'x');
  const owned = join(w.env.workDir, 'lpm-npm'); mkdirSync(owned, { recursive: true }); writeFileSync(join(owned, 'conflict.txt'), 'keep');
  const r = reg(); r.plugins['lpm-npm'].pending = { worktree: owned, branch: 'lpm-update', conflicts: ['conflict.txt'], target: '2' };
  (await import('../lib/registry.js')).saveRegistry(w.env.registryFile, r);

  const issues = (await w.mgr.state(null)).issues;
  assert.ok(issues.some((i) => i.code === 'ORPHAN_WORKTREE' && /stray/.test(i.message) && i.severity === 'info'));
  assert.ok(!issues.some((i) => /\.work\/lpm-npm/.test(i.message ?? '')), 'the one an update owns is not reported');

  const preview = await w.mgr.cleanup({}, w.log);
  const row = preview.snapshots.find((x) => x.kind === 'worktree');
  assert.deepEqual([row.name, preview.snapshots.length], ['stray', 1]);
  assert.ok(existsSync(join(w.env.workDir, 'stray')), 'a preview removes nothing');

  await w.mgr.cleanup({ execute: true }, w.log);
  assert.ok(!existsSync(join(w.env.workDir, 'stray')));
  assert.equal(readFileSync(join(owned, 'conflict.txt'), 'utf8'), 'keep', 'the pending update worktree is untouched');
  assert.equal((await w.mgr.cleanup({}, w.log)).snapshots.length, 0, 'idempotent');
});

test('the retention setting is validated, saved, shown as effective, and overridden by the environment variable', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  assert.deepEqual((await w.mgr.state(null)).effectiveSettings, { keepSnapshots: 3, keepFromEnv: false });
  assert.deepEqual(w.mgr.setSettings({ keepSnapshots: 5 }), { keepSnapshots: 5 });
  assert.equal(reg().settings.keepSnapshots, 5);
  assert.deepEqual((await w.mgr.state(null)).effectiveSettings, { keepSnapshots: 5, keepFromEnv: false });
  for (const bad of [0, 21, 2.5, 'x', null, undefined, -1]) assert.throws(() => w.mgr.setSettings({ keepSnapshots: bad }), (e) => e.status === 400 && /between 1 and 20/.test(e.message), String(bad));
  assert.equal(reg().settings.keepSnapshots, 5, 'rejected values change nothing');
  process.env.LPM_KEEP_SNAPSHOTS = '2';
  assert.deepEqual((await w.mgr.state(null)).effectiveSettings, { keepSnapshots: 2, keepFromEnv: true });
});
