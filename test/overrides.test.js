import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorld, makeTarball, makeGitOrigin, g } from './helpers.js';
import { loadRegistry } from '../lib/registry.js';
import { snapshotSha } from '../lib/recovery.js';
import { inspectGit } from '../lib/gitstate.js';

let w;
beforeEach(() => { w = makeWorld(); });
afterEach(() => w.cleanup());
const reg = () => loadRegistry(w.env.registryFile);
const repo = (n) => w.env.repoDir(n);
const pkgOf = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const live = (n) => realpathSync(w.env.stableLink(n));

function localDep(name, version = '1.0.0') {
  const dir = join(w.base, 'deps', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }));
  writeFileSync(join(dir, 'index.js'), `module.exports = "${name}@${version}";\n`);
  return `file:${dir}`;
}

test('override lifecycle: normal -> override -> apply -> update -> rollback -> remove override -> restore', async () => {
  const dep = localDep('dep-local');
  makeTarball(w.fixtures, 'lpm-ov', '1.0.0', { 'index.js': 'export const v = 1;\n', 'package.json': { name: 'lpm-ov', version: '1.0.0', type: 'module', main: 'index.js', dependencies: { 'dep-local': dep } } });
  await w.mgr.addNew({ input: 'lpm-ov' }, w.log);
  const original = pkgOf(repo('lpm-ov')).dependencies['dep-local'];
  assert.equal(original, dep);

  // override: a commit on local, recorded in the registry, pending until Apply
  const dep2 = localDep('dep-local-2', '2.0.0');
  const r1 = await w.mgr.setDep({ name: 'lpm-ov', dep: 'dep-local', range: dep2 }, w.log);
  assert.ok(r1.sha);
  assert.equal(pkgOf(repo('lpm-ov')).dependencies['dep-local'], dep2, 'the override is in git');
  assert.deepEqual(reg().plugins['lpm-ov'].depOverrides, { 'dep-local': dep2 });
  assert.match(g(repo('lpm-ov'), 'log', '-1', '--format=%s', 'local'), /dependency override dep-local/);

  // apply: the live snapshot uses the override, reproducibly (same commit -> same result)
  await w.mgr.apply({ name: 'lpm-ov', allowScripts: true }, w.log);
  const first = live('lpm-ov');
  assert.equal(pkgOf(first).dependencies['dep-local'], dep2);
  assert.ok(existsSync(join(first, 'node_modules', 'dep-local')));
  const overrideSha = reg().plugins['lpm-ov'].deployedSha;

  // survives restart
  const { createManager } = await import('../lib/actions.js');
  await createManager(w.env).startup(() => {});
  assert.deepEqual(reg().plugins['lpm-ov'].depOverrides, { 'dep-local': dep2 });

  // survives an upstream update (release 1.1.0 changes other things, not that dependency)
  makeTarball(w.fixtures, 'lpm-ov', '1.1.0', { 'index.js': 'export const v = 11;\n', 'extra.js': '// new\n', 'package.json': { name: 'lpm-ov', version: '1.1.0', type: 'module', main: 'index.js', dependencies: { 'dep-local': dep } } });
  await w.mgr.checkUpdates({}, w.log);
  const up = await w.mgr.update({ name: 'lpm-ov', allowScripts: true }, w.log);
  assert.equal(up.status, 'merged');
  assert.equal(pkgOf(repo('lpm-ov')).dependencies['dep-local'], dep2, 'override kept after the merge');
  assert.ok(existsSync(join(repo('lpm-ov'), 'extra.js')), 'and the new release content arrived');
  await w.mgr.apply({ name: 'lpm-ov', allowScripts: true }, w.log);
  assert.equal(pkgOf(live('lpm-ov')).dependencies['dep-local'], dep2);

  // survives a rollback to the pre-update deployment
  await w.mgr.apply({ name: 'lpm-ov', ref: overrideSha, allowScripts: true }, w.log);
  assert.equal(snapshotSha(live('lpm-ov')), overrideSha);
  assert.equal(pkgOf(live('lpm-ov')).dependencies['dep-local'], dep2);

  // removing it restores the exact original spec, as a commit
  await w.mgr.setDep({ name: 'lpm-ov', dep: 'dep-local', range: null }, w.log);
  assert.equal(pkgOf(repo('lpm-ov')).dependencies['dep-local'], dep, 'the original range is back');
  assert.deepEqual(reg().plugins['lpm-ov'].depOverrides, {});
  await w.mgr.apply({ name: 'lpm-ov', allowScripts: true }, w.log);
  assert.equal(pkgOf(live('lpm-ov')).dependencies['dep-local'], dep);

  // restore original: the profile gets its original spec back (not the override)
  await w.mgr.restore({ name: 'lpm-ov' }, w.log);
  const pj = JSON.parse(readFileSync(join(w.profileDir, 'package.json'), 'utf8')).dependencies['lpm-ov'];
  assert.match(pj, /^file:/, 'what the profile had before, never the link');
  assert.equal(reg().plugins['lpm-ov'].applied, false);
});

test('an invalid override is rejected before anything is changed', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  const head = () => g(repo('lpm-npm'), 'rev-parse', 'local');
  const before = head();
  const pkgBefore = readFileSync(join(repo('lpm-npm'), 'package.json'), 'utf8');
  for (const [dep, range] of [['', '1.0.0'], ['--evil', '1.0.0'], ['Bad Name', '1.0.0'], ['dep-x', '--registry=x'], ['dep-x', 'a b'], ['../x', '1']]) {
    await assert.rejects(w.mgr.setDep({ name: 'lpm-npm', dep, range }, w.log), (e) => e.status === 400 || /required|valid/.test(e.message), `${dep} ${range}`);
  }
  assert.equal(head(), before, 'no commit was made');
  assert.equal(readFileSync(join(repo('lpm-npm'), 'package.json'), 'utf8'), pkgBefore, 'package.json untouched');
  assert.deepEqual(reg().plugins['lpm-npm'].depOverrides, {});
});

test('a dependency that cannot be installed never produces a live snapshot', async () => {
  makeTarball(w.fixtures, 'lpm-ov', '1.0.0', { 'index.js': 'export const v = 1;\n', 'package.json': { name: 'lpm-ov', version: '1.0.0', type: 'module', main: 'index.js', dependencies: { 'dep-ok': localDep('dep-ok') } } });
  await w.mgr.addNew({ input: 'lpm-ov' }, w.log);
  await w.mgr.apply({ name: 'lpm-ov', allowScripts: true }, w.log);
  const good = live('lpm-ov');
  await w.mgr.setDep({ name: 'lpm-ov', dep: 'dep-ok', range: `file:${join(w.base, 'does-not-exist')}` }, w.log);
  await assert.rejects(w.mgr.apply({ name: 'lpm-ov', allowScripts: true }, w.log), /dependenc(y is|ies are) missing: dep-ok/);
  assert.equal(live('lpm-ov'), good, 'the previous deployment is still live');
  assert.ok(existsSync(join(good, 'index.js')));
  const leftovers = (await import('node:fs')).readdirSync(w.env.deployedDir).filter((n) => n.startsWith('lpm-ov@') && !existsSync(join(w.env.deployedDir, n, '.lpm-ready')));
  assert.deepEqual(leftovers, [], 'no half-installed snapshot is left behind');
});

test('core override of a dependency: installed into the dsh install, original backed up, undone by restore', async () => {
  const CORE = '@deepseek-ai/dsh-fake-core';
  await w.mgr.migrate({ name: CORE }, w.log);
  await w.mgr.setDep({ name: CORE, dep: 'dep-x', range: '2.0.0' }, w.log);
  await w.mgr.apply({ name: CORE }, w.log);
  assert.equal(JSON.parse(readFileSync(join(w.nm, 'dep-x', 'package.json'), 'utf8')).version, '2.0.0');
  assert.equal(pkgOf(live(CORE)).dependencies['dep-x'], '2.0.0');
  await w.mgr.restore({ name: CORE }, w.log);
  assert.ok(!lstatSync(join(w.nm, '@deepseek-ai', 'dsh-fake-core')).isSymbolicLink());
  assert.equal(pkgOf(join(w.nm, '@deepseek-ai', 'dsh-fake-core')).dependencies['dep-x'], '^1.0.0', 'the original package.json is back');
});

// ---------- the central git state ----------

test('inspectGit answers every question in one place, for every kind of origin', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  const p0 = reg().plugins['lpm-npm'];
  let s = await inspectGit(w.env, p0);
  assert.equal(s.track, 'npm');
  assert.equal(s.uncommitted, 0); assert.equal(s.notApplied, null); assert.equal(s.mergePending, false);
  assert.equal(s.local, s.upstream, 'nothing changed yet');

  writeFileSync(join(repo('lpm-npm'), 'index.js'), 'export const x = 1;\n');
  s = await inspectGit(w.env, p0);
  assert.equal(s.uncommitted, 1);
  assert.equal(s.changedVsOriginal, 1);
  await w.mgr.apply({ name: 'lpm-npm' }, w.log);
  const p1 = reg().plugins['lpm-npm'];
  s = await inspectGit(w.env, p1);
  assert.equal(s.deployed, s.local); assert.equal(s.notApplied, 0); assert.equal(s.uncommitted, 0);
  writeFileSync(join(repo('lpm-npm'), 'more.js'), '//\n');
  await w.mgr.commit({ name: 'lpm-npm' }, w.log);
  s = await inspectGit(w.env, reg().plugins['lpm-npm']);
  assert.equal(s.notApplied, 1);
  s = await inspectGit(w.env, { ...p1, pending: { conflicts: ['a.js'] }, update: { available: true, target: '2.0.0' } });
  assert.deepEqual([s.mergePending, s.conflicts, s.updateAvailable, s.updateTarget], [true, ['a.js'], true, '2.0.0']);
  assert.equal(await inspectGit(w.env, { name: 'missing', source: { type: 'npm' } }), null, 'a missing repo is null, not a crash');

  const origin = makeGitOrigin(w.base, 'lpm-g');
  await w.mgr.addNew({ input: origin.url }, w.log);
  assert.equal((await inspectGit(w.env, reg().plugins['lpm-g'])).track, 'release');
  const pinned = reg().plugins['lpm-g'];
  assert.equal((await inspectGit(w.env, { ...pinned, source: { ...pinned.source, pin: { kind: 'tag', ref: 'v1' } } })).track, 'tag');
  assert.equal((await inspectGit(w.env, { ...pinned, source: { ...pinned.source, track: 'branch' } })).track, 'branch');
});
