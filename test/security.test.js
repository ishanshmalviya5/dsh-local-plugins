import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeWorld } from './helpers.js';
import { loadRegistry, saveRegistry } from '../lib/registry.js';
import { npmExtract, assertSafeTree, unsafeEntryNames, assertPackageName, assertSpec, assertGitLocation, gitUrl } from '../lib/sources.js';
import { secureDirs } from '../lib/recovery.js';
import { swapLink } from '../lib/deploy.js';

let w;
beforeEach(() => { w = makeWorld(); });
afterEach(() => w.cleanup());

const CORE = '@deepseek-ai/dsh-fake-core';
const reg = () => loadRegistry(w.env.registryFile);
const hasPython = (() => { try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

// ---------- a hostile registry must not steer destructive operations ----------

async function tamper(mutate) {
  await w.mgr.migrate({ name: CORE }, w.log);
  const r = reg();
  mutate(r.plugins[CORE]);
  saveRegistry(w.env.registryFile, r);
}

test('registry tampering: a core path outside node_modules quarantines the plugin and nothing is touched', async () => {
  const victim = mkdtempSync(join(tmpdir(), 'lpm-victim-'));
  writeFileSync(join(victim, 'precious.txt'), 'do not delete');
  await tamper((p) => { p.core.path = victim; });
  await assert.rejects(w.mgr.apply({ name: CORE }, w.log), (e) => e.status === 404);
  await assert.rejects(w.mgr.restore({ name: CORE }, w.log), (e) => e.status === 404);
  await w.mgr.repair(w.log);
  assert.equal(readFileSync(join(victim, 'precious.txt'), 'utf8'), 'do not delete');
  assert.ok(existsSync(victim) && !statSync(victim).isSymbolicLink?.());
  const q = reg().quarantine[CORE];
  assert.ok(q && /not <node_modules>/.test(q.problems.join(' ')));
  assert.ok(q.entry.core.path === victim, 'the entry is kept, not destroyed');
  rmSync(victim, { recursive: true, force: true });
});

test('registry tampering: backup, worktree and node_modules paths outside managed storage are quarantined', async () => {
  for (const [label, mutate, pattern] of [
    ['backup', (p) => { p.core.backup = '/etc'; }, /core\.backup/],
    ['nested', (p) => { p.core.nested = '/usr'; }, /core\.nested/],
    ['worktree', (p) => { p.pending = { worktree: '/tmp', branch: 'b', conflicts: [] }; }, /pending\.worktree/],
    ['nodeModules', (p) => { p.core.nodeModules = '/tmp'; p.core.path = '/tmp/' + CORE; }, /core\./],
  ]) {
    const w2 = makeWorld();
    try {
      await w2.mgr.migrate({ name: CORE }, w2.log);
      const r = loadRegistry(w2.env.registryFile);
      mutate(r.plugins[CORE]);
      saveRegistry(w2.env.registryFile, r);
      const after = loadRegistry(w2.env.registryFile);
      // the manager's own view (state) must not act on it
      const s = await w2.mgr.state(null);
      assert.equal(s.plugins.length, 0, label);
      assert.match(JSON.stringify(s.quarantine), pattern, label);
      void after;
    } finally { w2.cleanup(); }
  }
});

test('registry tampering: an invalid plugin name (path traversal) is quarantined', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  const r = reg();
  r.plugins['../../etc'] = { ...r.plugins['lpm-npm'], name: '../../etc' };
  saveRegistry(w.env.registryFile, r);
  const s = await w.mgr.state(null);
  assert.deepEqual(s.plugins.map((p) => p.name), ['lpm-npm']);
  assert.ok(s.quarantine['../../etc']);
});

// ---------- hostile names, locations and specs ----------

test('input validation: package names, specs and git locations', () => {
  for (const bad of ['', '..', '../x', 'a/b/c', '-g', '--foo', 'UPPER', 'a b', 'a;b', '$(id)', '`id`', '@scope', '@/x', 'x'.repeat(215), null, 5]) assert.throws(() => assertPackageName(bad), /valid npm package name/, String(bad));
  for (const good of ['a', 'my-plugin', '@scope/pkg', '@a/b.c_d', 'dsh-x.y']) assert.equal(assertPackageName(good), good);
  for (const bad of ['', '-x', '--registry=x', 'a b', ' ', null]) assert.throws(() => assertSpec(bad), /valid version or range/, String(bad));
  for (const good of ['^1.2.0', '~1', '1.2.3', 'latest', 'beta', '>=1 <2'.replace(' ', '')]) assert.equal(assertSpec(good), good);
  for (const bad of ['', '--upload-pack=x', ' ', null]) assert.throws(() => assertGitLocation(bad), /valid git address/, String(bad));
  assert.equal(gitUrl('ext::sh -c id'), null, 'git ext:: transport is never accepted');
  assert.equal(gitUrl('file:///tmp/x.git'), 'file:///tmp/x.git');
});

// ---------- hostile tarballs ----------

function craftTgz(dir, name, pyBody) {
  const out = join(dir, name);
  execFileSync('python3', ['-c', `import tarfile,io\nt=tarfile.open(${JSON.stringify(out)},'w:gz')\n${pyBody}\nt.close()`]);
  return out;
}
const addFile = "def f(n,c=b'x'):\n  i=tarfile.TarInfo(n); i.size=len(c); t.addfile(i,io.BytesIO(c))\n";

test('tarballs: entries that escape the folder are refused before extraction', { skip: !hasPython }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-tar-'));
  const evil = craftTgz(dir, 'evil.tgz', `${addFile}f('package/package.json',b'{}')\nf('../escaped.txt')\nf('/abs/escaped2.txt')`);
  const names = execFileSync('tar', ['-tzf', evil], { encoding: 'utf8' });
  assert.deepEqual(unsafeEntryNames(names).sort(), ['../escaped.txt', '/abs/escaped2.txt'].sort());
  const w2 = makeWorld();
  try {
    mkdirSync(join(w2.fixtures, 'evil-pkg'), { recursive: true });
    execFileSync('cp', [evil, join(w2.fixtures, 'evil-pkg', '1.0.0.tgz')]);
    const dest = join(dir, 'dest'); mkdirSync(dest);
    await assert.rejects(npmExtract('evil-pkg', '1.0.0', dest, () => {}), (e) => e.code === 'UNSAFE_ARCHIVE' && /escape/.test(e.message));
    assert.equal(existsSync(join(dir, 'escaped.txt')), false);
  } finally { w2.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('tarballs: symlinks pointing outside, and special files, are refused; harmless relative links are allowed', { skip: !hasPython }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-tar-'));
  const sym = "def l(n,target):\n  i=tarfile.TarInfo(n); i.type=tarfile.SYMTYPE; i.linkname=target; t.addfile(i)\n";
  const out = craftTgz(dir, 'sym.tgz', `${addFile}${sym}f('package/package.json',b'{}')\nl('package/escape','/etc')\n`);
  const ex = join(dir, 'x'); mkdirSync(ex);
  execFileSync('tar', ['-xzf', out, '-C', ex]);
  await assert.rejects(assertSafeTree(ex), (e) => e.code === 'UNSAFE_ARCHIVE' && /points outside/.test(e.message));

  const rel = craftTgz(dir, 'rel.tgz', `${addFile}${sym}f('package/package.json',b'{}')\nf('package/lib/a.js')\nl('package/lib/b.js','a.js')\nl('package/up.js','lib/a.js')\n`);
  const ex2 = join(dir, 'x2'); mkdirSync(ex2);
  execFileSync('tar', ['-xzf', rel, '-C', ex2]);
  await assertSafeTree(ex2); // inside links are fine

  const fifo = craftTgz(dir, 'fifo.tgz', `${addFile}f('package/package.json',b'{}')\ni=tarfile.TarInfo('package/pipe'); i.type=tarfile.FIFOTYPE; t.addfile(i)\n`);
  const ex3 = join(dir, 'x3'); mkdirSync(ex3);
  execFileSync('tar', ['-xzf', fifo, '-C', ex3]);
  await assert.rejects(assertSafeTree(ex3), (e) => /special file/.test(e.message));
  rmSync(dir, { recursive: true, force: true });
});

// ---------- symlinks and the stable link ----------

test('the stable link can never point outside managed storage, even via a symlink inside it', () => {
  const within = join(w.base, 'managed'); mkdirSync(within, { recursive: true });
  const outside = join(w.base, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(within, 'trojan'));
  const link = join(within, 'stable');
  assert.throws(() => swapLink(link, join(within, 'trojan'), { within }), /outside the managed folder/);
  assert.equal(existsSync(link), false, 'nothing was created');
  assert.throws(() => swapLink(link, outside, { within }), /outside the managed folder/);
});

// ---------- permissions ----------

test('managed folders and files are private to the user', async () => {
  mkdirSync(w.env.root, { recursive: true, mode: 0o755 });
  chmodSync(w.env.root, 0o755);
  mkdirSync(w.env.backupDir, { recursive: true }); chmodSync(w.env.backupDir, 0o755);
  const fixed = secureDirs(w.env, () => {});
  assert.deepEqual(fixed.sort(), [w.env.root, w.env.backupDir].sort());
  for (const d of [w.env.root, w.env.backupDir]) assert.equal(statSync(d).mode & 0o777, 0o700);
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  assert.equal(statSync(w.env.registryFile).mode & 0o777, 0o600);
  assert.deepEqual(secureDirs(w.env, () => {}), [], 'already private: nothing to change');
});
