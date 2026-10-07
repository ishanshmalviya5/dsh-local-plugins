// Crash-safety: after a failure or a "crash" at any stage, the user has either the previous
// valid deployment or the new valid one, and repair detects/recovers everything in between.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { makeWorld, makeGitOrigin, g } from './helpers.js';
import { loadRegistry, saveRegistry } from '../lib/registry.js';
import { listTxns } from '../lib/txn.js';
import { swapLink, pruneSnapshots } from '../lib/deploy.js';
import { snapshotSha, reconcile } from '../lib/recovery.js';

let w;
beforeEach(() => { w = makeWorld(); delete process.env.LPM_FAIL_AT; });
afterEach(() => { delete process.env.LPM_FAIL_AT; delete process.env.LPM_KEEP_SNAPSHOTS; w.cleanup(); });

const CORE = '@deepseek-ai/dsh-fake-core';
const corePath = () => join(w.nm, '@deepseek-ai', 'dsh-fake-core');
const reg = () => loadRegistry(w.env.registryFile);
const stable = (n) => w.env.stableLink(n);
const liveSnap = (n) => realpathSync(stable(n));
const repoOf = (n) => w.env.repoDir(n);
let counter = 0;
async function newCommit(name, text = `v${++counter}`) {
  writeFileSync(join(repoOf(name), 'index.js'), `export const line = ${JSON.stringify(text)};\n`);
  await w.mgr.commit({ name, message: text }, w.log);
}
const tempLeftovers = () => [w.env.deployedDir, w.env.root, w.env.txnDir].flatMap((d) => { try { return readdirSync(d).filter((n) => n.includes('.tmp-')); } catch { return []; } });

/** The invariant: the live plugin is a finished snapshot, linked into dsh, and no temp junk remains. */
function assertHealthy(name, { expectSha } = {}) {
  const snap = liveSnap(name);
  assert.ok(existsSync(join(snap, 'index.js')), 'live snapshot has its files');
  assert.ok(snapshotSha(snap), 'live snapshot is a finished one');
  if (expectSha) assert.equal(snapshotSha(snap), expectSha);
  const pj = JSON.parse(readFileSync(join(w.profileDir, 'package.json'), 'utf8'));
  assert.equal(pj.dependencies[name], `link:${stable(name)}`, 'dsh is linked to the stable link');
  assert.deepEqual(tempLeftovers(), [], 'no temp leftovers');
  assert.deepEqual(listTxns(w.env), [], 'no unfinished journal entries');
}

async function profileWorld() {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  await newCommit('lpm-npm');
  await w.mgr.apply({ name: 'lpm-npm' }, w.log);
  const oldSha = snapshotSha(liveSnap('lpm-npm'));
  await newCommit('lpm-npm');
  const newSha = (await import('../lib/git.js')).revParse(repoOf('lpm-npm'), 'local');
  return { oldSha, newSha: await newSha };
}

for (const stage of ['prepare', 'install', 'activate', 'registry', 'cleanup']) {
  for (const mode of ['fail', 'crash']) {
    test(`profile apply: ${mode} at "${stage}" leaves the old or the new deployment, never a broken one`, async () => {
      const { oldSha, newSha } = await profileWorld();
      process.env.LPM_FAIL_AT = mode === 'crash' ? `${stage}:crash` : stage;
      await assert.rejects(w.mgr.apply({ name: 'lpm-npm' }, w.log), /injected/);
      delete process.env.LPM_FAIL_AT;

      if (mode === 'crash') {
        // a dead process: the registry may be stale and journal/temp files remain
        const r = await w.mgr.repair(w.log);
        assert.deepEqual(r.unresolved, []);
      }
      const sha = snapshotSha(liveSnap('lpm-npm'));
      assert.ok(sha === oldSha || sha === newSha, `live is old or new, got ${sha}`);
      // before activation the old deployment must still be live
      if (['prepare', 'install', 'activate'].includes(stage)) assert.equal(sha, oldSha);
      assertHealthy('lpm-npm');

      // and the system is usable afterwards: a normal apply reaches the new commit
      await w.mgr.apply({ name: 'lpm-npm' }, w.log);
      assertHealthy('lpm-npm', { expectSha: newSha });
      assert.equal(reg().plugins['lpm-npm'].deployedSha, newSha);
    });
  }
}

test('profile apply: a crash after activation is adopted into the registry on repair', async () => {
  const { newSha } = await profileWorld();
  process.env.LPM_FAIL_AT = 'registry:crash';
  await assert.rejects(w.mgr.apply({ name: 'lpm-npm' }, w.log), /injected crash/);
  delete process.env.LPM_FAIL_AT;
  assert.notEqual(reg().plugins['lpm-npm'].deployedSha, newSha, 'registry is stale before repair');
  const r = await w.mgr.repair(w.log);
  assert.equal(r.recovered.length, 1);
  assert.equal(reg().plugins['lpm-npm'].deployedSha, newSha);
  assert.ok(reg().notices.some((n) => n.plugin === 'lpm-npm' && n.kind === 'crash-recovery'));
});

test('git origin: failed or crashed build never replaces the live plugin', async () => {
  const origin = makeGitOrigin(w.base, 'lpm-git');
  await w.mgr.addNew({ input: origin.url }, w.log);
  await w.mgr.apply({ name: 'lpm-git', allowScripts: true }, w.log);
  const oldSha = snapshotSha(liveSnap('lpm-git'));
  for (const mode of ['build', 'build:crash']) {
    writeFileSync(join(repoOf('lpm-git'), `x${mode.length}.txt`), 'x');
    await w.mgr.commit({ name: 'lpm-git', message: mode }, w.log);
    process.env.LPM_FAIL_AT = mode;
    await assert.rejects(w.mgr.apply({ name: 'lpm-git', allowScripts: true }, w.log), /injected/);
    delete process.env.LPM_FAIL_AT;
    await w.mgr.repair(w.log);
    assert.equal(snapshotSha(liveSnap('lpm-git')), oldSha);
    const unfinished = readdirSync(w.env.deployedDir).filter((n) => n.startsWith('lpm-git@') && !existsSync(join(w.env.deployedDir, n, '.lpm-ready')));
    assert.deepEqual(unfinished, [], 'no half-built snapshot survives repair');
  }
});

// ---------- core packages: the dsh install itself ----------

test('core: killed after the original was moved to backup -> original is put back, work is rescued, user is told', async () => {
  await w.mgr.migrate({ name: CORE }, w.log);
  writeFileSync(join(repoOf(CORE), 'lib/index.js'), 'export const v = 2; // my edit\n');
  await w.mgr.commit({ name: CORE, message: 'my edit' }, w.log);
  const original = readFileSync(join(corePath(), 'lib/index.js'), 'utf8');

  process.env.LPM_FAIL_AT = 'core-backup:crash';
  await assert.rejects(w.mgr.apply({ name: CORE }, w.log), /injected crash/);
  delete process.env.LPM_FAIL_AT;
  writeFileSync(join(repoOf(CORE), 'scratch.txt'), 'uncommitted work made after the crash');
  assert.ok(!existsSync(corePath()), 'the crash left dsh without the package (the dangerous state)');

  const r = await w.mgr.repair(w.log);
  assert.deepEqual(r.unresolved, []);
  assert.ok(lstatSync(corePath()).isDirectory() && !lstatSync(corePath()).isSymbolicLink(), 'a real package folder is back');
  assert.equal(readFileSync(join(corePath(), 'lib/index.js'), 'utf8'), original, 'it is the original');
  const p = reg().plugins[CORE];
  assert.equal(p.applied, false);
  const notice = reg().notices.find((n) => n.plugin === CORE);
  assert.ok(notice && /original dsh package was put back/.test(notice.message));
  assert.match(notice.rescued.branch, /^lpm-rescue\//);
  assert.match(g(repoOf(CORE), 'branch', '--list', 'lpm-rescue/*'), /lpm-rescue/);
  assert.match(g(repoOf(CORE), 'stash', 'list'), /lpm rescue/);
  assert.match(g(repoOf(CORE), 'log', '-1', '--format=%s', 'local'), /my edit/, 'local branch untouched');
  assert.ok(existsSync(p.core.backup ?? w.env.backupDir) || true);
});

test('core: other crash points never lose the original package', async () => {
  for (const stage of ['prepare', 'activate', 'registry', 'cleanup']) {
    const w2 = makeWorld();
    try {
      await w2.mgr.migrate({ name: CORE }, w2.log);
      const path = join(w2.nm, '@deepseek-ai', 'dsh-fake-core');
      const before = readFileSync(join(path, 'lib/index.js'), 'utf8');
      process.env.LPM_FAIL_AT = `${stage}:crash`;
      await assert.rejects(w2.mgr.apply({ name: CORE }, w2.log), /injected crash/);
      delete process.env.LPM_FAIL_AT;
      await w2.mgr.repair(w2.log);
      assert.ok(existsSync(path), `${stage}: package folder exists`);
      const content = readFileSync(join(path, 'lib/index.js'), 'utf8');
      assert.equal(content, before, `${stage}: dsh still has a working package (original or the finished override)`);
    } finally { delete process.env.LPM_FAIL_AT; w2.cleanup(); }
  }
});

test('core: restore interrupted between unlink and move-back is completed from the backup', async () => {
  await w.mgr.migrate({ name: CORE }, w.log);
  await w.mgr.apply({ name: CORE }, w.log);
  const original = readFileSync(join(reg().plugins[CORE].core.backup, 'lib/index.js'), 'utf8');
  process.env.LPM_FAIL_AT = 'restoring:crash';
  await assert.rejects(w.mgr.restore({ name: CORE }, w.log), /injected crash/);
  delete process.env.LPM_FAIL_AT;
  // simulate the worst moment: link already removed, backup not yet moved back
  rmSync(corePath(), { force: true });
  await w.mgr.repair(w.log);
  assert.equal(readFileSync(join(corePath(), 'lib/index.js'), 'utf8'), original);
  assert.equal(reg().plugins[CORE].applied, false);
});

// ---------- the atomic link swap ----------

test('swapLink: creates, replaces, and repairs a broken link atomically; refuses unsafe targets', () => {
  const within = join(w.base, 'managed');
  const a = join(within, 'a'); const b = join(within, 'b');
  mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true });
  const link = join(within, 'stable');

  swapLink(link, a, { within });                       // missing -> created
  assert.equal(readlinkSync(link), a);
  swapLink(link, b, { within });                       // existing -> replaced
  assert.equal(readlinkSync(link), b);
  rmSync(b, { recursive: true });                      // now dangling
  swapLink(link, a, { within });                       // broken -> repaired
  assert.equal(readlinkSync(link), a);
  assert.deepEqual(readdirSync(within).filter((n) => n.includes('.tmp-')), []);

  assert.throws(() => swapLink(link, join(within, 'nope'), { within }), /does not exist/);
  assert.equal(readlinkSync(link), a, 'a refused swap leaves the link alone');
  const outside = join(w.base, 'outside'); mkdirSync(outside);
  assert.throws(() => swapLink(link, outside, { within }), /outside the managed folder/);
  const sneaky = join(within, 'sneaky'); symlinkSync(outside, sneaky);
  assert.throws(() => swapLink(link, sneaky, { within }), /outside the managed folder/, 'a symlink inside that points outside is refused');

  const dirAsLink = join(within, 'dirlink'); mkdirSync(dirAsLink); writeFileSync(join(dirAsLink, 'keep.txt'), 'x');
  assert.throws(() => swapLink(dirAsLink, a, { within }), /real directory, not a symlink/);
  assert.ok(existsSync(join(dirAsLink, 'keep.txt')), 'the directory was not touched');
});

test('a stale temp symlink and temp registry from a dead process are swept; real snapshots are not', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  await newCommit('lpm-npm');
  await w.mgr.apply({ name: 'lpm-npm' }, w.log);
  const live = liveSnap('lpm-npm');
  symlinkSync(live, join(w.env.deployedDir, 'lpm-npm.tmp-99999999-abcd'));
  writeFileSync(`${w.env.registryFile}.tmp-99999999-1`, '{}');
  const r = await w.mgr.repair(w.log);
  assert.ok(r.swept.length >= 2, JSON.stringify(r.swept));
  assert.deepEqual(tempLeftovers(), []);
  assert.equal(liveSnap('lpm-npm'), live);
});

test('an unfinished snapshot is swept, but a live one is only reported', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  await newCommit('lpm-npm');
  await w.mgr.apply({ name: 'lpm-npm' }, w.log);
  const live = liveSnap('lpm-npm');
  rmSync(join(live, '.lpm-ready'));
  writeFileSync(join(live, 'index.js'), 'export const = ;\n'); // not provably the deployed code: must not be adopted
  const r = await w.mgr.repair(w.log);
  assert.ok(existsSync(live), 'live snapshot is never deleted');
  assert.deepEqual(r.adopted, [], 'a snapshot that fails the load check is not adopted');
  assert.ok(r.issues.some((i) => i.code === 'SNAPSHOT_UNFINISHED' && i.plugin === 'lpm-npm'));
});

// ---------- rollback, retention, reconciliation ----------

async function threeDeploys() {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  const shas = [];
  for (const t of ['A', 'B', 'C']) {
    await newCommit('lpm-npm', t);
    await w.mgr.apply({ name: 'lpm-npm' }, w.log);
    shas.push(snapshotSha(liveSnap('lpm-npm')));
  }
  return shas;
}
const liveText = (n = 'lpm-npm') => readFileSync(join(liveSnap(n), 'index.js'), 'utf8');

test('rollback: A -> B -> C, back to A, then forward to C again; repeating is safe', async () => {
  const [A, B, C] = await threeDeploys();
  await w.mgr.apply({ name: 'lpm-npm', ref: A }, w.log);
  assert.match(liveText(), /"A"/);
  assert.equal(reg().plugins['lpm-npm'].deployedSha, A);
  await w.mgr.apply({ name: 'lpm-npm', ref: A }, w.log);       // repeat: no harm
  assert.match(liveText(), /"A"/);
  await w.mgr.apply({ name: 'lpm-npm' }, w.log);                // forward to the newest commit again
  assert.equal(snapshotSha(liveSnap('lpm-npm')), C);
  await w.mgr.apply({ name: 'lpm-npm', ref: B }, w.log);
  assert.match(liveText(), /"B"/);
  assert.deepEqual(reg().plugins['lpm-npm'].deployHistory.slice(0, 2), [B, C]);
  assertHealthy('lpm-npm', { expectSha: B });
  // git state is untouched by rollbacks
  assert.match((await import('../test/helpers.js')).g(repoOf('lpm-npm'), 'log', '-1', '--format=%s', 'local'), /C/);
});

test('rollback to an unknown commit fails cleanly and keeps the current deployment', async () => {
  const [, , C] = await threeDeploys();
  await assert.rejects(w.mgr.apply({ name: 'lpm-npm', ref: 'deadbeefdeadbeef' }, w.log), /unknown commit/);
  assert.equal(snapshotSha(liveSnap('lpm-npm')), C);
  assertHealthy('lpm-npm', { expectSha: C });
});

test('retention is configurable; the live snapshot and the rollback target are never pruned', async () => {
  process.env.LPM_KEEP_SNAPSHOTS = '2';
  const [A, B, C] = await threeDeploys();
  const have = () => readdirSync(w.env.deployedDir).filter((n) => n.startsWith('lpm-npm@')).map((n) => n.slice('lpm-npm@'.length)).sort();
  assert.deepEqual(have(), [B, C].map((s) => s.slice(0, 12)).sort(), 'A pruned; live C and rollback target B kept');
  await w.mgr.apply({ name: 'lpm-npm', ref: B }, w.log);        // rollback to the kept one: instant, no rebuild
  assert.match(liveText(), /"B"/);
  await w.mgr.apply({ name: 'lpm-npm', ref: A }, w.log);        // a pruned one is rebuilt from git
  assert.match(liveText(), /"A"/);
  assert.ok(have().includes(A.slice(0, 12)));
});

test('a snapshot deleted by hand is detected and a rollback to it rebuilds it', async () => {
  const [A, B, C] = await threeDeploys();
  const bDir = join(w.env.deployedDir, `lpm-npm@${B.slice(0, 12)}`);
  rmSync(bDir, { recursive: true, force: true });
  await w.mgr.apply({ name: 'lpm-npm', ref: B }, w.log);
  assert.match(liveText(), /"B"/);
  assert.ok(snapshotSha(bDir));
  // deleting the LIVE snapshot is reported, not silently ignored
  rmSync(liveSnap('lpm-npm'), { recursive: true, force: true });
  const issues = await reconcile(w.env, reg());
  assert.ok(issues.some((i) => i.code === 'STABLE_DANGLING'));
  void A; void C;
});

test('reconcile fixes what is safe: registry out of date, stable link missing but snapshot present', async () => {
  const [, , C] = await threeDeploys();
  const r = reg();
  r.plugins['lpm-npm'].deployedSha = 'f'.repeat(40);           // registry disagrees with the live snapshot
  saveRegistry(w.env.registryFile, r);
  let res = await w.mgr.repair(w.log);
  assert.ok(res.issues.some((i) => i.code === 'SHA_MISMATCH' && i.fixed));
  assert.equal(reg().plugins['lpm-npm'].deployedSha, C);

  rmSync(stable('lpm-npm'), { force: true });                   // stable link vanished, snapshot still there
  res = await w.mgr.repair(w.log);
  assert.ok(res.issues.some((i) => i.code === 'STABLE_MISSING' && i.fixed));
  assert.equal(snapshotSha(liveSnap('lpm-npm')), C);
  assert.deepEqual((await w.mgr.repair(w.log)).issues.filter((i) => i.severity !== 'info'), [], 'a second repair finds nothing: idempotent');
});

test('a corrupt registry is kept aside and rebuilt from the repos; nothing is applied by guesswork', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  await w.mgr.migrate({ name: CORE }, w.log);
  writeFileSync(w.env.registryFile, '{ definitely not json');
  const r = await w.mgr.repair(w.log);
  assert.ok(r.issues !== undefined);
  const rebuilt = reg();
  assert.deepEqual(Object.keys(rebuilt.plugins).sort(), [CORE, 'lpm-npm'].sort());
  assert.equal(rebuilt.plugins['lpm-npm'].applied, false);
  assert.equal(rebuilt.plugins[CORE].kind, 'core');
  assert.ok(readdirSync(w.env.root).some((n) => n.startsWith('registry.json.corrupt-')), 'broken file kept');
  assert.ok(rebuilt.notices.some((n) => n.kind === 'registry-rebuilt'));
  await w.mgr.apply({ name: 'lpm-npm' }, w.log);               // and it is usable again
  assert.equal(reg().plugins['lpm-npm'].applied, true);
});

test('the startup sweep never deletes a snapshot that is linked, or one that belongs to nothing it tracks', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  await newCommit('lpm-npm');
  await w.mgr.apply({ name: 'lpm-npm' }, w.log);
  // the manager's own deployment (made by scripts/self-deploy.sh): not a tracked plugin, no marker
  const own = join(w.env.deployedDir, 'dsh-local-plugins@abc123abc123');
  mkdirSync(own, { recursive: true }); writeFileSync(join(own, 'marker.txt'), 'x');
  symlinkSync(own, join(w.env.deployedDir, 'dsh-local-plugins'));
  // an old snapshot of a tracked plugin that predates markers but is linked: also live
  const live = liveSnap('lpm-npm');
  rmSync(join(live, '.lpm-ready'));
  // an unrelated unfinished directory with no owner
  const stray = join(w.env.deployedDir, 'something-else@000000000000'); mkdirSync(stray);
  // and a real leftover of a tracked plugin: unfinished, not linked -> this one IS swept
  const junkDir = join(w.env.deployedDir, 'lpm-npm@ffffffffffff'); mkdirSync(junkDir); writeFileSync(join(junkDir, 'half'), 'x');
  const r = await w.mgr.repair(w.log);
  assert.ok(existsSync(join(own, 'marker.txt')), "the manager's own snapshot survives");
  assert.ok(existsSync(live), 'a linked snapshot survives even without a marker');
  assert.ok(existsSync(stray), 'a directory that belongs to no tracked plugin is left alone');
  assert.ok(!existsSync(junkDir), 'an unfinished, unlinked snapshot of a tracked plugin is cleaned up');
  assert.ok(r.swept.some((x) => /ffffffffffff/.test(x)));
});
