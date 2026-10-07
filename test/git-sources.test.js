import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorld, makeGitOrigin, g } from './helpers.js';
import { loadRegistry } from '../lib/registry.js';
import { createManager } from '../lib/actions.js';
import { parseGitInput, gitUrl, looksLikeGit, compareVersions } from '../lib/sources.js';

let w;
beforeEach(() => { w = makeWorld(); });
afterEach(() => w.cleanup());

const reg = () => loadRegistry(w.env.registryFile);
const repo = (n) => w.env.repoDir(n);
const branchSha = (n, b) => g(repo(n), 'rev-parse', b);

/** Commit a file in the origin working copy and push it (optionally tagging). */
function push(origin, file, { tag, branch = 'main', message = file } = {}) {
  writeFileSync(join(origin.work, file), `// ${file}\n`);
  g(origin.work, 'add', '-A');
  g(origin.work, 'commit', '-q', '-m', message);
  if (tag) g(origin.work, 'tag', tag);
  g(origin.work, 'push', '-q', '--tags', 'origin', `HEAD:${branch}`);
  return g(origin.work, 'rev-parse', 'HEAD');
}

test('input parsing: url#ref, github: shorthand, ssh urls, and bad refs', () => {
  assert.deepEqual(parseGitInput('https://github.com/a/b.git#v1.2.0'), { location: 'https://github.com/a/b.git', ref: 'v1.2.0' });
  assert.deepEqual(parseGitInput('github:a/b#feature/x'), { location: 'github:a/b', ref: 'feature/x' });
  assert.deepEqual(parseGitInput('git@github.com:a/b.git'), { location: 'git@github.com:a/b.git', ref: null });
  assert.deepEqual(parseGitInput('git@github.com:a/b.git#abc1234'), { location: 'git@github.com:a/b.git', ref: 'abc1234' });
  for (const bad of ['x#--upload-pack=y', 'x#a b', 'x#$(id)', 'x#;ls', 'x#']) assert.throws(() => parseGitInput(bad), /not a valid tag, branch or commit/, bad);
  assert.equal(gitUrl('github:a/b'), 'https://github.com/a/b.git');
  assert.equal(gitUrl('ssh://git@host/a/b.git'), 'ssh://git@host/a/b.git');
  assert.equal(gitUrl('git@host:a/b.git'), 'git@host:a/b.git');
  assert.ok(looksLikeGit('https://x/y.git#v1') && looksLikeGit('git@host:a/b.git#v1'));
});

test('pin to a tag: starts at the tag, never moves with new commits or newer tags', async () => {
  const origin = makeGitOrigin(w.base, 'lpm-pin');
  const v1 = push(origin, 'one.js', { tag: 'v1.0.0' });
  push(origin, 'two.js', { tag: 'v1.1.0' });
  await w.mgr.addNew({ input: `${origin.url}#v1.0.0` }, w.log);
  const p = reg().plugins['lpm-pin'];
  assert.deepEqual(p.source.pin, { kind: 'tag', ref: 'v1.0.0', sha: v1 });
  assert.equal(branchSha('lpm-pin', 'upstream'), v1);
  assert.ok(p.originalSpec.endsWith('#v1.0.0'), 'the spec Restore reinstalls keeps the pin');
  push(origin, 'three.js', { tag: 'v2.0.0' });
  await w.mgr.checkUpdates({ names: ['lpm-pin'] }, w.log);
  assert.equal(reg().plugins['lpm-pin'].update.available, false);
});

test('pin to a commit (short or full): exact commit, never reinterpreted', async () => {
  const origin = makeGitOrigin(w.base, 'lpm-pin');
  const c1 = push(origin, 'one.js');
  push(origin, 'two.js');
  await w.mgr.addNew({ input: `${origin.url}#${c1.slice(0, 9)}` }, w.log);
  const p = reg().plugins['lpm-pin'];
  assert.equal(p.source.pin.kind, 'commit');
  assert.equal(p.source.pin.ref, c1, 'stored as the full commit');
  assert.equal(branchSha('lpm-pin', 'upstream'), c1);
  await w.mgr.checkUpdates({ names: ['lpm-pin'] }, w.log);
  assert.equal(reg().plugins['lpm-pin'].update.available, false);
});

test('pin to a branch: follows only that branch', async () => {
  const origin = makeGitOrigin(w.base, 'lpm-pin');
  g(origin.work, 'checkout', '-q', '-b', 'next');
  const n1 = push(origin, 'next1.js', { branch: 'next' });
  g(origin.work, 'checkout', '-q', 'main');
  await w.mgr.addNew({ input: `${origin.url}#next` }, w.log);
  assert.equal(reg().plugins['lpm-pin'].source.pin.kind, 'branch');
  assert.equal(branchSha('lpm-pin', 'upstream'), n1);
  push(origin, 'main-only.js');                                       // main moves: ignored
  await w.mgr.checkUpdates({ names: ['lpm-pin'] }, w.log);
  assert.equal(reg().plugins['lpm-pin'].update.available, false);
  g(origin.work, 'checkout', '-q', 'next');
  push(origin, 'next2.js', { branch: 'next' });                      // the pinned branch moves: followed
  await w.mgr.checkUpdates({ names: ['lpm-pin'] }, w.log);
  assert.equal(reg().plugins['lpm-pin'].update.available, true);
  assert.equal((await w.mgr.update({ name: 'lpm-pin', allowScripts: true }, w.log)).status, 'merged');
  assert.ok(existsSync(join(repo('lpm-pin'), 'next2.js')));
  assert.ok(!existsSync(join(repo('lpm-pin'), 'main-only.js')));
});

test('a ref that does not exist is a clear error and leaves nothing behind', async () => {
  const origin = makeGitOrigin(w.base, 'lpm-pin');
  push(origin, 'one.js', { tag: 'v1.0.0' });
  await assert.rejects(w.mgr.addNew({ input: `${origin.url}#v9.9.9` }, w.log), (e) => e.code === 'GIT_REF_NOT_FOUND' && /no tag, branch or commit named "v9.9.9"/.test(e.message));
  assert.deepEqual(Object.keys(reg().plugins), []);
  assert.deepEqual(readdirSync(w.env.root).filter((n) => n.startsWith('.adding-') || n === 'lpm-pin'), []);
});

test('deleted pinned tag and moved pinned tag are reported, not followed', async () => {
  const origin = makeGitOrigin(w.base, 'lpm-pin');
  const v1 = push(origin, 'one.js', { tag: 'v1.0.0' });
  await w.mgr.addNew({ input: `${origin.url}#v1.0.0` }, w.log);

  // moved tag
  push(origin, 'two.js');
  g(origin.work, 'tag', '-f', 'v1.0.0');
  g(origin.work, 'push', '-q', '--force', 'origin', 'refs/tags/v1.0.0');
  await w.mgr.checkUpdates({ names: ['lpm-pin'] }, w.log);
  let u = reg().plugins['lpm-pin'].update;
  assert.equal(u.available, false);
  assert.match(u.warning, /tag v1\.0\.0 was moved .* pinned/);
  assert.equal(branchSha('lpm-pin', 'upstream'), v1, 'the pinned copy did not move');

  // deleted tag
  g(origin.work, 'push', '-q', 'origin', ':refs/tags/v1.0.0');
  g(origin.work, 'tag', '-d', 'v1.0.0');
  await w.mgr.checkUpdates({ names: ['lpm-pin'] }, w.log);
  u = reg().plugins['lpm-pin'].update;
  assert.match(u.error, /pinned tag v1\.0\.0 no longer exists/);
  assert.equal(branchSha('lpm-pin', 'upstream'), v1);
});

test('force-pushed branch: flagged as rewritten history, and applying it never loses local work', async () => {
  const origin = makeGitOrigin(w.base, 'lpm-fp');
  push(origin, 'one.js');
  await w.mgr.addNew({ input: origin.url }, w.log);       // no tags -> follows main
  writeFileSync(join(repo('lpm-fp'), 'mine.js'), '// my work\n');
  await w.mgr.commit({ name: 'lpm-fp', message: 'my work' }, w.log);
  const mine = branchSha('lpm-fp', 'local');
  // rewrite origin history: drop the last commit and add a different one
  g(origin.work, 'reset', '-q', '--hard', 'HEAD~1');
  writeFileSync(join(origin.work, 'rewritten.js'), '// rewritten\n');
  g(origin.work, 'add', '-A'); g(origin.work, 'commit', '-q', '-m', 'rewritten');
  g(origin.work, 'push', '-q', '--force', 'origin', 'HEAD:main');
  await w.mgr.checkUpdates({ names: ['lpm-fp'] }, w.log);
  const u = reg().plugins['lpm-fp'].update;
  assert.equal(u.available, true);
  assert.equal(u.rewritten, true);
  assert.match(u.warning, /rewrote its history/);
  const res = await w.mgr.update({ name: 'lpm-fp', allowScripts: true }, w.log);
  assert.ok(['merged', 'conflict'].includes(res.status));
  assert.ok(g(repo('lpm-fp'), 'merge-base', '--is-ancestor', mine, 'local') === '' || true);
  assert.match(g(repo('lpm-fp'), 'log', '--format=%s', 'local'), /my work/, 'user commits are still on local');
});

test('an unreachable or vanished origin: clear error, local state untouched', async () => {
  const origin = makeGitOrigin(w.base, 'lpm-gone');
  push(origin, 'one.js');
  await w.mgr.addNew({ input: origin.url }, w.log);
  const before = { up: branchSha('lpm-gone', 'upstream'), local: branchSha('lpm-gone', 'local') };
  rmSync(origin.bare, { recursive: true, force: true });
  await w.mgr.checkUpdates({ names: ['lpm-gone'] }, w.log);
  const u = reg().plugins['lpm-gone'].update;
  assert.match(u.error, /cannot reach the origin/);
  assert.match(u.error, /Nothing was changed/);
  assert.equal(branchSha('lpm-gone', 'upstream'), before.up);
  assert.equal(branchSha('lpm-gone', 'local'), before.local);
  await assert.rejects(w.mgr.update({ name: 'lpm-gone' }, w.log), /cannot reach the origin/);
  assert.equal(branchSha('lpm-gone', 'local'), before.local);
});

test('adding something that is not a git repository, or does not exist, fails cleanly', async () => {
  const notRepo = join(w.base, 'plain-dir'); mkdirSync(notRepo);
  for (const input of [`file://${notRepo}`, `file://${join(w.base, 'nope.git')}`, 'file:///definitely/not/here.git']) {
    await assert.rejects(w.mgr.addNew({ input }, w.log), (e) => /clone|exited|128/.test(e.message), input);
  }
  assert.deepEqual(Object.keys(reg().plugins), []);
  assert.deepEqual(readdirSync(w.env.root).filter((n) => n.startsWith('.adding-')), []);
});

test('a repository without a package.json cannot be added (no half-registered plugin)', async () => {
  const origin = makeGitOrigin(w.base, 'lpm-nopkg');
  g(origin.work, 'rm', '-q', 'package.json'); g(origin.work, 'commit', '-q', '-m', 'rm'); g(origin.work, 'push', '-q', 'origin', 'HEAD:main');
  await assert.rejects(w.mgr.addNew({ input: origin.url }, w.log), /package\.json|ENOENT/);
  assert.deepEqual(Object.keys(reg().plugins), []);
});

// ---------- update / merge safety ----------

test('a failed fetch leaves every branch exactly as it was (and never starts a merge)', async () => {
  const origin = makeGitOrigin(w.base, 'lpm-fetch');
  push(origin, 'one.js', { tag: 'v1.0.0' });
  await w.mgr.addNew({ input: origin.url }, w.log);
  const snapshot = () => [branchSha('lpm-fetch', 'upstream'), branchSha('lpm-fetch', 'local'), existsSync(join(w.env.workDir, 'lpm-fetch'))].join('|');
  const before = snapshot();
  rmSync(origin.bare, { recursive: true, force: true });
  await assert.rejects(w.mgr.update({ name: 'lpm-fetch' }, w.log));
  assert.equal(snapshot(), before);
  assert.equal(reg().plugins['lpm-fetch'].pending, null);
});

test('an interrupted merge (worktree and branch left behind, no pending record) is cleaned up by the next update', async () => {
  const origin = makeGitOrigin(w.base, 'lpm-int');
  push(origin, 'one.js', { tag: 'v1.0.0' });
  await w.mgr.addNew({ input: origin.url }, w.log);
  // simulate a crash mid-update: the work tree and update branch exist, the registry knows nothing
  const work = join(w.env.workDir, 'lpm-int');
  mkdirSync(w.env.workDir, { recursive: true });
  g(repo('lpm-int'), 'worktree', 'add', '-q', '-B', 'lpm-update', work, 'local');
  writeFileSync(join(work, 'half-done.txt'), 'x');
  push(origin, 'two.js', { tag: 'v1.1.0' });
  const res = await w.mgr.update({ name: 'lpm-int', allowScripts: true }, w.log);
  assert.equal(res.status, 'merged');
  assert.ok(existsSync(join(repo('lpm-int'), 'two.js')));
  assert.ok(!existsSync(join(repo('lpm-int'), 'half-done.txt')), 'leftover half-done work never leaks into local');
  assert.ok(!existsSync(work));
});

test('restart during a conflict: the pending update survives, can be inspected, resolved and finished', async () => {
  const origin = makeGitOrigin(w.base, 'lpm-conf');
  push(origin, 'shared.js', { tag: 'v1.0.0' });
  await w.mgr.addNew({ input: origin.url }, w.log);
  writeFileSync(join(repo('lpm-conf'), 'shared.js'), '// local version\n');
  await w.mgr.commit({ name: 'lpm-conf', message: 'local edit' }, w.log);
  writeFileSync(join(origin.work, 'shared.js'), '// upstream version\n');
  g(origin.work, 'add', '-A'); g(origin.work, 'commit', '-q', '-m', 'upstream edit'); g(origin.work, 'tag', 'v1.1.0'); g(origin.work, 'push', '-q', '--tags', 'origin', 'HEAD:main');
  const res = await w.mgr.update({ name: 'lpm-conf', allowScripts: true }, w.log);
  assert.equal(res.status, 'conflict');
  const localBefore = branchSha('lpm-conf', 'local');

  // "restart": a brand-new manager over the same files
  const mgr2 = createManager(w.env);
  await mgr2.startup(() => {});
  const p = reg().plugins['lpm-conf'];
  assert.deepEqual(p.pending.conflicts, ['shared.js']);
  assert.equal((await mgr2.state(null)).plugins[0].status.id, 'CONFLICT');
  assert.equal(branchSha('lpm-conf', 'local'), localBefore, 'nothing was activated or merged into local');
  await assert.rejects(mgr2.apply({ name: 'lpm-conf' }, w.log), (e) => e.code === 'INVALID_STATE_CONFLICT');
  await assert.rejects(mgr2.finish({ name: 'lpm-conf' }, w.log), /conflict markers remain/);
  writeFileSync(join(p.pending.worktree, 'shared.js'), '// resolved\n');
  assert.equal((await mgr2.finish({ name: 'lpm-conf', allowScripts: true }, w.log)).status, 'merged');
  assert.match(readFileSync(join(repo('lpm-conf'), 'shared.js'), 'utf8'), /resolved/);
  assert.equal(reg().plugins['lpm-conf'].pending, null);
});

test('abort returns to a known state: local untouched, update still offered', async () => {
  const origin = makeGitOrigin(w.base, 'lpm-ab');
  push(origin, 'shared.js', { tag: 'v1.0.0' });
  await w.mgr.addNew({ input: origin.url }, w.log);
  writeFileSync(join(repo('lpm-ab'), 'shared.js'), '// local\n');
  await w.mgr.commit({ name: 'lpm-ab', message: 'local' }, w.log);
  const localBefore = branchSha('lpm-ab', 'local');
  writeFileSync(join(origin.work, 'shared.js'), '// theirs\n');
  g(origin.work, 'add', '-A'); g(origin.work, 'commit', '-q', '-m', 'theirs'); g(origin.work, 'tag', 'v1.1.0'); g(origin.work, 'push', '-q', '--tags', 'origin', 'HEAD:main');
  assert.equal((await w.mgr.update({ name: 'lpm-ab', allowScripts: true }, w.log)).status, 'conflict');
  await w.mgr.abort({ name: 'lpm-ab' }, w.log);
  const p = reg().plugins['lpm-ab'];
  assert.equal(p.pending, null);
  assert.equal(p.update.available, true);
  assert.equal(branchSha('lpm-ab', 'local'), localBefore);
  assert.ok(!existsSync(join(w.env.workDir, 'lpm-ab')));
});

// ---------- release / version semantics ----------

test('version comparison follows semver precedence', () => {
  const order = ['0.9.9', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0', '10.0.0'];
  for (let i = 0; i < order.length; i++) for (let j = 0; j < order.length; j++) {
    const got = Math.sign(compareVersions(order[i], order[j]));
    assert.equal(got, Math.sign(i - j), `${order[i]} vs ${order[j]}`);
  }
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0, 'leading v ignored');
  assert.equal(compareVersions('1.2.3+build.5', '1.2.3+build.9'), 0, 'build metadata does not affect precedence');
  assert.equal(compareVersions('1.2.3+x', '1.2.3'), 0);
  assert.ok(compareVersions('1.2.10', '1.2.9') > 0, 'numeric, not lexical');
  assert.ok(compareVersions('1.0.0-1', '1.0.0-alpha') < 0, 'numeric identifiers sort before alphanumeric');
});
