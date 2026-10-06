import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { makeWorld, makeTarball, makeGitOrigin, g } from './helpers.js';
import { loadRegistry, saveRegistry } from '../lib/registry.js';
import { createOps } from '../lib/ops.js';
import { createManager } from '../lib/actions.js';
import { createEnv } from '../lib/env.js';

let w;
beforeEach(() => { w = makeWorld(); });
afterEach(() => { w.cleanup(); });

const CORE = '@deepseek-ai/dsh-fake-core';
const corePath = () => join(w.nm, '@deepseek-ai', 'dsh-fake-core');
const reg = () => loadRegistry(w.env.registryFile);
const live = (name) => realpathSync(w.env.stableLink(name));

test('registry round-trips and writes atomically', () => {
  const file = join(w.base, 'r', 'registry.json');
  saveRegistry(file, { version: 1, plugins: { a: { name: 'a' } } });
  assert.deepEqual(loadRegistry(file).plugins.a, { name: 'a' });
  assert.deepEqual(readdirSync(join(w.base, 'r')), ['registry.json']);
});

test('migrate core: pristine upstream + captured hand edit on local', async () => {
  await w.mgr.migrate({ name: CORE }, w.log);
  const dir = w.env.repoDir(CORE);
  assert.match(g(dir, 'log', '--format=%s', 'upstream'), /npm @deepseek-ai\/dsh-fake-core@1\.0\.0/);
  assert.match(g(dir, 'log', '-1', '--format=%s', 'local'), /pre-existing local edits/);
  assert.match(readFileSync(join(dir, 'lib/index.js'), 'utf8'), /hand edit/);
  const p = reg().plugins[CORE];
  assert.equal(p.kind, 'core');
  assert.equal(p.applied, false);
});

test('apply core: install dir becomes a link to the stable link; original backed up; restore puts it back', async () => {
  await w.mgr.migrate({ name: CORE }, w.log);
  await w.mgr.apply({ name: CORE }, w.log);
  assert.ok(lstatSync(corePath()).isSymbolicLink());
  assert.equal(readlinkSync(corePath()), w.env.stableLink(CORE));
  assert.match(basename(live(CORE)), /^@deepseek-ai__dsh-fake-core@[0-9a-f]{12}$/);
  // the snapshot resolves its deps through the shared node_modules
  assert.ok(existsSync(join(live(CORE), 'node_modules', 'dep-x', 'package.json')));
  const p = reg().plugins[CORE];
  assert.ok(existsSync(p.core.backup));
  assert.equal(reg().restartNeeded, true);

  await w.mgr.restore({ name: CORE }, w.log);
  assert.ok(!lstatSync(corePath()).isSymbolicLink());
  assert.match(readFileSync(join(corePath(), 'lib/index.js'), 'utf8'), /hand edit/);
  assert.equal(reg().plugins[CORE].applied, false);
  assert.ok(existsSync(w.env.repoDir(CORE)), 'repo stays tracked');
});

test('commit-only rule: uncommitted edits never reach the live snapshot; Apply deploys commits; snapshots pruned to 3', async () => {
  await w.mgr.migrate({ name: CORE }, w.log);
  await w.mgr.apply({ name: CORE }, w.log);
  const dir = w.env.repoDir(CORE);
  const first = live(CORE);
  writeFileSync(join(dir, 'lib/index.js'), 'export const v = 2;\n');
  assert.match(readFileSync(join(first, 'lib/index.js'), 'utf8'), /hand edit/, 'live code unchanged by working-tree edit');

  const st = await w.mgr.state();
  assert.equal(st.plugins[0].stats.uncommitted, 1);

  await w.mgr.commit({ name: CORE, message: 'v2' }, w.log);
  assert.equal((await w.mgr.state()).plugins[0].stats.notApplied, 1);
  await w.mgr.apply({ name: CORE }, w.log);
  assert.notEqual(live(CORE), first);
  assert.match(readFileSync(join(live(CORE), 'lib/index.js'), 'utf8'), /v = 2/);

  for (const n of [3, 4, 5]) {
    writeFileSync(join(dir, 'lib/index.js'), `export const v = ${n};\n`);
    await w.mgr.apply({ name: CORE }, w.log); // auto-commits, then deploys
  }
  const snaps = readdirSync(w.env.deployedDir).filter((e) => e.startsWith('@deepseek-ai__dsh-fake-core@'));
  assert.equal(snaps.length, 3);
  assert.ok(snaps.includes(basename(live(CORE))));

  // rollback to an older commit
  const { commits } = await w.mgr.commits({ name: CORE });
  await w.mgr.apply({ name: CORE, ref: commits[2].sha }, w.log);
  assert.equal(reg().plugins[CORE].deployedSha, commits[2].sha);
  assert.match(readFileSync(join(live(CORE), 'lib/index.js'), 'utf8'), /v = 3/);
});

test('profile plugin: migrate from npm, apply links the profile to the stable link, restore installs latest', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  await w.mgr.apply({ name: 'lpm-npm' }, w.log);
  const pkg = JSON.parse(readFileSync(join(w.profileDir, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['lpm-npm'], `link:${w.env.stableLink('lpm-npm')}`);
  // the fake CLI resolves the link like pnpm; we re-point it at the stable link
  assert.equal(readlinkSync(join(w.profileDir, 'node_modules', 'lpm-npm')), w.env.stableLink('lpm-npm'));

  await w.mgr.restore({ name: 'lpm-npm' }, w.log);
  const after = JSON.parse(readFileSync(join(w.profileDir, 'package.json'), 'utf8'));
  assert.equal(after.dependencies['lpm-npm'], 'latest');
  assert.equal(reg().plugins['lpm-npm'].applied, false);
  assert.ok(existsSync(w.env.stableLink('lpm-npm')), 'snapshots kept for a fast re-apply');
});

test('npm update, clean: merged into local, nothing deployed until Apply', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  await w.mgr.apply({ name: 'lpm-npm' }, w.log);
  const deployed = reg().plugins['lpm-npm'].deployedSha;
  makeTarball(w.fixtures, 'lpm-npm', '1.1.0', { 'index.js': 'export const line = "one";\n', 'extra.js': 'export {};\n' });
  await w.mgr.checkUpdates({}, w.log);
  assert.equal(reg().plugins['lpm-npm'].update.available, true);
  const r = await w.mgr.update({ name: 'lpm-npm' }, w.log);
  assert.equal(r.status, 'merged');
  assert.ok(existsSync(join(w.env.repoDir('lpm-npm'), 'extra.js')));
  assert.equal(reg().plugins['lpm-npm'].deployedSha, deployed);
  assert.ok(!existsSync(join(live('lpm-npm'), 'extra.js')));
});

test('npm update with conflict: pending worktree, live untouched, finish requires resolution; abort leaves local unchanged', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  const dir = w.env.repoDir('lpm-npm');
  writeFileSync(join(dir, 'index.js'), 'export const line = "mine";\n');
  await w.mgr.commit({ name: 'lpm-npm', message: 'mine' }, w.log);
  await w.mgr.apply({ name: 'lpm-npm' }, w.log);
  const liveBefore = live('lpm-npm');
  makeTarball(w.fixtures, 'lpm-npm', '1.2.0', { 'index.js': 'export const line = "theirs";\n' });

  const r = await w.mgr.update({ name: 'lpm-npm' }, w.log);
  assert.equal(r.status, 'conflict');
  assert.deepEqual(r.conflicts, ['index.js']);
  const p = reg().plugins['lpm-npm'];
  assert.ok(existsSync(p.pending.worktree));
  assert.equal(live('lpm-npm'), liveBefore);

  await assert.rejects(w.mgr.finish({ name: 'lpm-npm' }, w.log), /conflict markers remain/);
  writeFileSync(join(p.pending.worktree, 'index.js'), 'export const line = "mine+theirs";\n');
  const fin = await w.mgr.finish({ name: 'lpm-npm' }, w.log);
  assert.equal(fin.status, 'merged');
  assert.match(readFileSync(join(dir, 'index.js'), 'utf8'), /mine\+theirs/);
  assert.equal(reg().plugins['lpm-npm'].pending, null);
  assert.ok(!existsSync(p.pending.worktree));

  // abort path
  writeFileSync(join(dir, 'index.js'), 'export const line = "mine again";\n');
  await w.mgr.commit({ name: 'lpm-npm' }, w.log);
  makeTarball(w.fixtures, 'lpm-npm', '1.3.0', { 'index.js': 'export const line = "theirs again";\n' });
  const head = g(dir, 'rev-parse', 'local');
  assert.equal((await w.mgr.update({ name: 'lpm-npm' }, w.log)).status, 'conflict');
  await w.mgr.abort({ name: 'lpm-npm' }, w.log);
  assert.equal(g(dir, 'rev-parse', 'local'), head);
  assert.equal(reg().plugins['lpm-npm'].pending, null);
  assert.equal(reg().plugins['lpm-npm'].update.available, true);
});

test('git origin: add new, build on apply; a failing build leaves the live link alone', async () => {
  const origin = makeGitOrigin(w.base, 'lpm-git');
  await w.mgr.addNew({ input: origin.url }, w.log);
  await w.mgr.apply({ name: 'lpm-git' }, w.log);
  assert.ok(existsSync(join(live('lpm-git'), 'built.txt')), 'build script ran in the snapshot');
  const good = live('lpm-git');

  const dir = w.env.repoDir('lpm-git');
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  pkg.scripts.build = 'node -e "process.exit(3)"';
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  await assert.rejects(w.mgr.apply({ name: 'lpm-git' }, w.log), /exited 3/);
  assert.equal(live('lpm-git'), good);
  assert.match(reg().plugins['lpm-git'].lastError, /exited 3/);
});

test('git origin update: new upstream commit merges cleanly', async () => {
  const origin = makeGitOrigin(w.base, 'lpm-git');
  await w.mgr.addNew({ input: origin.url }, w.log);
  writeFileSync(join(origin.work, 'feature.js'), 'export {};\n');
  g(origin.work, 'add', '-A');
  g(origin.work, 'commit', '-q', '-m', 'feature');
  g(origin.work, 'push', '-q', 'origin', 'main');
  await w.mgr.checkUpdates({ names: ['lpm-git'] }, w.log);
  assert.equal(reg().plugins['lpm-git'].update.available, true);
  assert.equal((await w.mgr.update({ name: 'lpm-git' }, w.log)).status, 'merged');
  assert.ok(existsSync(join(w.env.repoDir('lpm-git'), 'feature.js')));
});

test('dependency override is a commit on local and needs Apply', async () => {
  await w.mgr.migrate({ name: CORE }, w.log);
  await w.mgr.setDep({ name: CORE, dep: 'dep-x', range: 'latest' }, w.log);
  const dir = w.env.repoDir(CORE);
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies['dep-x'], 'latest');
  assert.match(g(dir, 'log', '-1', '--format=%s'), /dependency override dep-x -> latest/);
  // installed dep-x (2.0.0) already matches "latest" -> no npm install needed
  await w.mgr.apply({ name: CORE }, w.log);
  assert.ok(w.logs.some((l) => /dep-x already 2\.0\.0/.test(l)));
  await w.mgr.setDep({ name: CORE, dep: 'dep-x', range: null }, w.log);
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies['dep-x'], '^1.0.0');
});

test('boot detects a dsh upgrade that reset a core link; reapplyAll re-links', async () => {
  await w.mgr.migrate({ name: CORE }, w.log);
  await w.mgr.apply({ name: CORE }, w.log);
  // simulate `npm i -g @deepseek-ai/dsh@1.1.0`: real dir back, new version
  const { rmSync, cpSync } = await import('node:fs');
  rmSync(corePath());
  cpSync(reg().plugins[CORE].core.backup, corePath(), { recursive: true });
  const env2 = createEnv({ dshHome: w.dshHome, profile: 'web', dsh: { ...w.env.dsh, version: '1.1.0' } });
  const mgr2 = createManager(env2);
  const booted = mgr2.boot();
  assert.deepEqual(booted.upgrade, { from: '1.0.0', to: '1.1.0', lost: 1 });
  assert.equal(booted.plugins[CORE].linkLost, true);
  await mgr2.reapplyAll(w.log);
  assert.ok(lstatSync(corePath()).isSymbolicLink());
  assert.equal(reg().upgrade, null);
  assert.equal(reg().dshVersion, '1.1.0');
});

test('ops queue is single-flight', async () => {
  const ops = createOps();
  let release;
  const op = ops.start('a', null, () => new Promise((r) => { release = r; }));
  assert.throws(() => ops.start('b', null, () => {}), /busy/);
  await new Promise((r) => setImmediate(r));
  release();
  await op.promise;
  assert.equal(ops.last().status, 'ok');
  ops.start('c', null, () => {});
});

test('agent drafts point at the repo, or at the update worktree for conflicts', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  const d = w.mgr.agentDraft({ name: 'lpm-npm' });
  assert.equal(d.path, w.env.repoDir('lpm-npm'));
  assert.match(d.text, /dsh only runs committed code/);
  assert.throws(() => w.mgr.agentDraft({ name: 'lpm-npm', mode: 'conflict' }), /no pending update/);
});

test('git origin with release tags: updates follow the newest stable tag, not branch commits', async () => {
  const origin = makeGitOrigin(w.base, 'lpm-tagged');
  g(origin.work, 'tag', 'v1.0.0');
  writeFileSync(join(origin.work, 'unreleased.js'), 'export {};\n');
  g(origin.work, 'add', '-A');
  g(origin.work, 'commit', '-q', '-m', 'unreleased work');
  g(origin.work, 'push', '-q', '--tags', 'origin', 'main');

  // added from its URL, it starts at the newest release, not the branch tip
  await w.mgr.addNew({ input: origin.url }, w.log);
  const dir = w.env.repoDir('lpm-tagged');
  assert.ok(!existsSync(join(dir, 'unreleased.js')), 'starts at v1.0.0, not the unreleased tip');

  // an untagged commit on main is not an update
  await w.mgr.checkUpdates({ names: ['lpm-tagged'] }, w.log);
  assert.equal(reg().plugins['lpm-tagged'].update.available, false);

  // a pre-release does not beat the stable line
  g(origin.work, 'tag', 'v1.1.0-beta.1');
  g(origin.work, 'push', '-q', '--tags', 'origin');
  await w.mgr.checkUpdates({ names: ['lpm-tagged'] }, w.log);
  assert.equal(reg().plugins['lpm-tagged'].update.available, false);

  // a new stable release is offered by tag name and merges exactly that tag
  writeFileSync(join(origin.work, 'released.js'), 'export {};\n');
  g(origin.work, 'add', '-A');
  g(origin.work, 'commit', '-q', '-m', 'release 1.1.0');
  g(origin.work, 'tag', 'v1.1.0');
  writeFileSync(join(origin.work, 'after-release.js'), 'export {};\n');
  g(origin.work, 'add', '-A');
  g(origin.work, 'commit', '-q', '-m', 'post-release work');
  g(origin.work, 'push', '-q', '--tags', 'origin', 'main');
  await w.mgr.checkUpdates({ names: ['lpm-tagged'] }, w.log);
  assert.deepEqual([reg().plugins['lpm-tagged'].update.available, reg().plugins['lpm-tagged'].update.target], [true, 'v1.1.0']);
  assert.equal((await w.mgr.update({ name: 'lpm-tagged' }, w.log)).status, 'merged');
  assert.ok(existsSync(join(dir, 'released.js')) && existsSync(join(dir, 'unreleased.js')), 'got v1.1.0 (which contains the earlier commit)');
  assert.ok(!existsSync(join(dir, 'after-release.js')), 'post-release commits are not pulled');
  assert.equal(reg().plugins['lpm-tagged'].upstreamVersion, 'v1.1.0');
});
