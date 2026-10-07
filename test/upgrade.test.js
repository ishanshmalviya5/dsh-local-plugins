// Upgrading from v0.1: nothing may be lost, and nothing that worked may suddenly look broken.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorld, makeGitOrigin, g } from './helpers.js';
import { loadRegistry, CURRENT_VERSION } from '../lib/registry.js';
import { snapshotSha } from '../lib/recovery.js';
import { createManager } from '../lib/actions.js';

let w;
beforeEach(() => { w = makeWorld(); });
afterEach(() => w.cleanup());
const CORE = '@deepseek-ai/dsh-fake-core';
const reg = () => loadRegistry(w.env.registryFile);

/** Turn what this version wrote into what v0.1 left behind: version-1 registry, no new fields, no ready markers. */
function downgradeToV01() {
  const file = w.env.registryFile;
  const r = JSON.parse(readFileSync(file, 'utf8'));
  r.version = 1;
  for (const k of ['settings', 'notices', 'quarantine']) delete r[k];
  for (const p of Object.values(r.plugins)) for (const k of ['disabled', 'deployHistory', 'probation', 'lastCrash', 'trustedOrigin', 'trustedPublisher']) delete p[k];
  writeFileSync(file, JSON.stringify(r, null, 2));
  let names = [];
  try { names = readdirSync(w.env.deployedDir); } catch { /* nothing deployed yet */ }
  for (const n of names) rmSync(join(w.env.deployedDir, n, '.lpm-ready'), { force: true });
  rmSync(w.env.txnDir, { recursive: true, force: true });
}

test('a v0.1 install with applied plugins (profile + core), an override, a pending conflict and dsh-upgrade state upgrades without loss', async () => {
  // build the world with the current code, then make it look like v0.1 left it
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  writeFileSync(join(w.env.repoDir('lpm-npm'), 'index.js'), 'export const v = "mine";\n');
  await w.mgr.commit({ name: 'lpm-npm', message: 'mine' }, w.log);
  await w.mgr.apply({ name: 'lpm-npm' }, w.log);
  await w.mgr.migrate({ name: CORE }, w.log);
  await w.mgr.setDep({ name: CORE, dep: 'dep-x', range: '2.0.0' }, w.log);
  await w.mgr.apply({ name: CORE }, w.log);
  const origin = makeGitOrigin(w.base, 'lpm-git');
  await w.mgr.addNew({ input: origin.url }, w.log);
  writeFileSync(join(w.env.repoDir('lpm-git'), 'shared.txt'), 'local\n');
  await w.mgr.commit({ name: 'lpm-git', message: 'local edit' }, w.log);
  // a pending conflict + a "dsh upgraded" banner, as v0.1 stored them
  const r0 = reg();
  r0.plugins['lpm-git'].pending = { worktree: join(w.env.workDir, 'lpm-git'), branch: 'lpm-update', conflicts: ['shared.txt'], target: 'v2', startedAt: 1 };
  r0.dshVersion = '0.9.0'; // v0.1 recorded an older dsh: starting under dsh 1.0.0 must raise the upgrade banner
  (await import('../lib/registry.js')).saveRegistry(w.env.registryFile, r0);
  downgradeToV01();

  const before = JSON.parse(readFileSync(w.env.registryFile, 'utf8'));
  const sha = { npm: before.plugins['lpm-npm'].deployedSha, core: before.plugins[CORE].deployedSha };
  const repoHeads = Object.fromEntries(['lpm-npm', CORE, 'lpm-git'].map((n) => [n, g(w.env.repoDir(n), 'rev-parse', 'local')]));

  // "install v0.2" = start it over the same files
  const mgr = createManager(w.env);
  const res = await mgr.startup(() => {});

  const after = reg();
  assert.equal(after.version, CURRENT_VERSION);
  assert.ok(existsSync(`${w.env.registryFile}.v1.bak`), 'the original v1 file is kept');
  assert.deepEqual(JSON.parse(readFileSync(`${w.env.registryFile}.v1.bak`, 'utf8')), before, 'byte-for-byte what v0.1 wrote');
  assert.deepEqual(Object.keys(after.plugins).sort(), ['lpm-git', 'lpm-npm', CORE].sort(), 'no plugin lost');
  assert.deepEqual(Object.keys(after.quarantine), [], 'nothing was set aside');

  // applied plugins stay applied, with the same deployed commits, and are adopted (not "broken")
  assert.equal(after.plugins['lpm-npm'].applied, true);
  assert.equal(after.plugins['lpm-npm'].deployedSha, sha.npm);
  assert.equal(after.plugins[CORE].applied, true);
  assert.equal(after.plugins[CORE].deployedSha, sha.core);
  assert.deepEqual(res.adopted.sort(), ['lpm-npm', CORE].sort());
  assert.equal(snapshotSha(realpathSync(w.env.stableLink('lpm-npm'))), sha.npm);
  assert.deepEqual(after.plugins['lpm-npm'].deployHistory, [sha.npm], 'rollback history seeded from the deployed commit');

  // dependency override, pending conflict and dsh-upgrade banner survive
  assert.deepEqual(after.plugins[CORE].depOverrides, { 'dep-x': '2.0.0' });
  assert.deepEqual(after.plugins['lpm-git'].pending.conflicts, ['shared.txt']);
  assert.deepEqual([after.upgrade.from, after.upgrade.to], ['0.9.0', '1.0.0'], 'the dsh-upgrade banner is still raised');

  // git repos and the core backup are untouched
  for (const [n, head] of Object.entries(repoHeads)) assert.equal(g(w.env.repoDir(n), 'rev-parse', 'local'), head, `${n}: local branch unchanged`);
  assert.ok(existsSync(after.plugins[CORE].core.backup), 'the original core package backup is still there');

  // everything reads as healthy in the new state machine, and a second start changes nothing
  const s = await mgr.state(null);
  const byName = Object.fromEntries(s.plugins.map((p) => [p.name, p.status.id]));
  assert.equal(byName['lpm-npm'], 'APPLIED');
  assert.equal(byName[CORE], 'APPLIED');
  assert.equal(byName['lpm-git'], 'CONFLICT');
  assert.deepEqual(s.issues.filter((i) => i.severity === 'error'), []);
  const again = await createManager(w.env).startup(() => {});
  assert.deepEqual(again.adopted, []);
  assert.deepEqual(again.recovered, []);
});

test('v0.1 data is safe if the new code refuses part of it: a bad entry is set aside, the rest keeps working', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  downgradeToV01();
  const r = JSON.parse(readFileSync(w.env.registryFile, 'utf8'));
  r.plugins.weird = { name: 'weird', kind: 'sideways' };
  writeFileSync(w.env.registryFile, JSON.stringify(r));
  await createManager(w.env).startup(() => {});
  const after = reg();
  assert.deepEqual(Object.keys(after.plugins), ['lpm-npm']);
  assert.deepEqual(after.quarantine.weird.entry, { name: 'weird', kind: 'sideways' }, 'kept for a human');
});

test('older snapshots that v0.1 left unfinished-looking are never deleted while they are live, and old unlinked ones are only rebuilt on demand', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  for (const t of ['A', 'B']) { writeFileSync(join(w.env.repoDir('lpm-npm'), 'index.js'), `export const v = "${t}";\n`); await w.mgr.commit({ name: 'lpm-npm', message: t }, w.log); await w.mgr.apply({ name: 'lpm-npm' }, w.log); }
  const [A, B] = reg().plugins['lpm-npm'].deployHistory.slice().reverse();
  downgradeToV01();
  await createManager(w.env).startup(() => {});
  const have = readdirSync(w.env.deployedDir).filter((n) => n.startsWith('lpm-npm@'));
  assert.ok(have.some((n) => n.endsWith(B.slice(0, 12))), 'the live one survives');
  assert.ok(!have.some((n) => n.endsWith(A.slice(0, 12))), 'the old unmarked one is cleaned up (it is rebuildable)');
  await w.mgr.apply({ name: 'lpm-npm', ref: A }, w.log);   // and rollback to it simply rebuilds it
  assert.equal(readFileSync(join(realpathSync(w.env.stableLink('lpm-npm')), 'index.js'), 'utf8').includes('"A"'), true);
});
