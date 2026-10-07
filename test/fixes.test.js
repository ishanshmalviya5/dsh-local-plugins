import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorld, makeGitOrigin } from './helpers.js';
import { loadRegistry, saveRegistry } from '../lib/registry.js';
import { run } from '../lib/run.js';

let w;
beforeEach(() => { w = makeWorld(); });
afterEach(() => { w.cleanup(); });

const CORE = '@deepseek-ai/dsh-fake-core';
const corePath = () => join(w.nm, '@deepseek-ai', 'dsh-fake-core');
const reg = () => loadRegistry(w.env.registryFile);
const snaps = (name) => w.env.stableLink(name);

test('an unfinished snapshot is thrown away and rebuilt, not reused', async () => {
  const origin = makeGitOrigin(w.base, 'lpm-git');
  await w.mgr.addNew({ input: origin.url }, w.log);
  await w.mgr.apply({ name: 'lpm-git' }, w.log);
  const sha = reg().plugins['lpm-git'].deployedSha;
  const snap = join(w.env.deployedDir, `lpm-git@${sha.slice(0, 12)}`);
  assert.ok(existsSync(join(snap, '.lpm-ready')), 'finished snapshots carry the ready marker');

  // simulate a crash mid-build on a snapshot that is not live: marker gone, build output gone
  await w.mgr.restore({ name: 'lpm-git' }, w.log);
  rmSync(snaps('lpm-git'), { force: true });
  rmSync(join(snap, '.lpm-ready'));
  rmSync(join(snap, 'built.txt'));
  w.logs.length = 0;
  await w.mgr.apply({ name: 'lpm-git' }, w.log);
  assert.ok(w.logs.some((l) => /unfinished — rebuilding/.test(l)), w.logs.join('\n'));
  assert.ok(existsSync(join(snap, 'built.txt')), 'rebuilt');
  assert.ok(existsSync(join(snap, '.lpm-ready')));
});

test('concurrent registry changes survive Add and plugin ops', async () => {
  await w.mgr.migrate({ name: 'lpm-npm' }, w.log);
  // another writer (the quiet startup check) saves a badge while an Add is in flight
  const origin = makeGitOrigin(w.base, 'lpm-git');
  const adding = w.mgr.addNew({ input: origin.url }, w.log);
  const r = reg();
  r.plugins['lpm-npm'].update = { available: true, target: '9.9.9', checkedAt: 1, error: null };
  saveRegistry(w.env.registryFile, r);
  await adding;
  assert.equal(reg().plugins['lpm-npm'].update?.target, '9.9.9', 'badge written during Add is kept');
  assert.ok(reg().plugins['lpm-git']);

  // same for a withPlugin op: a fresher badge written while it runs is kept
  const r2 = reg();
  r2.plugins['lpm-npm'].update = null;
  saveRegistry(w.env.registryFile, r2);
  const op = w.mgr.commit({ name: 'lpm-npm', message: 'x' }, w.log);
  const r3 = reg();
  r3.plugins['lpm-npm'].update = { available: true, target: '8.8.8', checkedAt: 2, error: null };
  saveRegistry(w.env.registryFile, r3);
  await op;
  assert.equal(reg().plugins['lpm-npm'].update?.target, '8.8.8');
});

test('Add rejects option-looking input and bad names', async () => {
  for (const input of ['--upload-pack=touch /tmp/pwned.git', '-g', '--registry=http://evil']) {
    await assert.rejects(w.mgr.addNew({ input }, w.log), /not an option|valid/);
  }
  await assert.rejects(w.mgr.addNew({ input: 'Bad Name' }, w.log), /valid npm package name/);
  await assert.rejects(w.mgr.migrate({ name: '--foo' }, w.log), /valid npm package name/);
  await w.mgr.migrate({ name: CORE }, w.log);
  await assert.rejects(w.mgr.setDep({ name: CORE, dep: '--foo', range: 'latest' }, w.log), /valid npm package name/);
  await assert.rejects(w.mgr.setDep({ name: CORE, dep: 'dep-x', range: '--registry=x' }, w.log), /valid version or range/);
  assert.ok(!existsSync('/tmp/pwned'), 'nothing was executed');
});

test('a stuck job is killed with everything it started', async () => {
  const pidFile = join(w.base, 'child.pid');
  const t0 = Date.now();
  await assert.rejects(
    run('sh', ['-c', `sleep 60 & echo $! > ${pidFile}; wait`], { timeoutMs: 300 }),
    /timed out/,
  );
  assert.ok(Date.now() - t0 < 4000, 'returned promptly instead of waiting for the grandchild');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'grandchild is gone');
});

test('a missing core folder gives a clear message, and Reapply all repairs it', async () => {
  await w.mgr.migrate({ name: CORE }, w.log);
  await w.mgr.apply({ name: CORE }, w.log);
  // dsh reinstall: the linked package folder disappears
  rmSync(corePath(), { force: true, recursive: true });
  await w.mgr.checkUpdates({ names: [CORE] }, w.log);
  assert.match(reg().plugins[CORE].update.error, /link lost.*Reapply all/);

  const { summary } = await w.mgr.reapplyAll(w.log);
  assert.match(summary.join('\n'), /re-applied/);
  assert.ok(lstatSync(corePath()).isSymbolicLink());
});
