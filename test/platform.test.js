import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, symlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorld } from './helpers.js';
import { assertSupportedPlatform, explainFsError } from '../lib/platform.js';
import { overlayInstalled } from '../lib/repo.js';
import { git } from '../lib/git.js';

let w;
beforeEach(() => { w = makeWorld(); });
afterEach(() => { try { chmodSync(w.env.deployedDir, 0o755); } catch { /* may not exist */ } w.cleanup(); });

test('Windows is refused up front with a useful message; macOS and Linux are accepted', () => {
  assert.throws(() => assertSupportedPlatform('win32'), (e) => e.code === 'UNSUPPORTED_PLATFORM' && /does not support Windows/.test(e.message) && /WSL/.test(e.message) && /Nothing was changed/.test(e.message));
  assert.equal(assertSupportedPlatform('darwin'), true);
  assert.equal(assertSupportedPlatform('linux'), true);
});

test('permission failures are explained, other errors pass through untouched', () => {
  for (const code of ['EPERM', 'EACCES', 'EROFS']) {
    const e = explainFsError(Object.assign(new Error('raw'), { code }), 'switching the live deployment', '/x/stable');
    assert.equal(e.code, 'PERMISSION_DENIED');
    assert.match(e.message, /switching the live deployment \(\/x\/stable\)/);
    assert.match(e.message, /Nothing was changed; the current deployment is still active/);
    assert.equal(e.cause.code, code);
  }
  const other = Object.assign(new Error('boom'), { code: 'ENOENT' });
  assert.equal(explainFsError(other, 'x', 'y'), other);
});

test('an unwritable deployments folder: Apply fails with a readable error and the live plugin is untouched', { skip: process.getuid?.() === 0 }, async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  writeFileSync(join(w.env.repoDir('lpm-npm'), 'index.js'), 'export const v = 1;\n');
  await w.mgr.apply({ name: 'lpm-npm' }, w.log);
  const live = realpathSync(w.env.stableLink('lpm-npm'));
  writeFileSync(join(w.env.repoDir('lpm-npm'), 'index.js'), 'export const v = 2;\n');
  await w.mgr.commit({ name: 'lpm-npm', message: 'v2' }, w.log);
  chmodSync(w.env.deployedDir, 0o555);               // read-only
  await assert.rejects(w.mgr.apply({ name: 'lpm-npm' }, w.log), (e) => /Permission denied|read-only|creating the new deployment/.test(e.message));
  chmodSync(w.env.deployedDir, 0o755);
  assert.equal(realpathSync(w.env.stableLink('lpm-npm')), live, 'the previous deployment is still live');
  await w.mgr.apply({ name: 'lpm-npm' }, w.log);     // and it recovers once the folder is writable again
  assert.notEqual(realpathSync(w.env.stableLink('lpm-npm')), live);
});

test('overlay without rsync: copies the installed package exactly, drops files that are gone, keeps .git and node_modules, and skips both from the source', async () => {
  const dest = join(w.base, 'repo'); mkdirSync(dest, { recursive: true });
  await git(dest, ['init', '-q', '-b', 'local']);
  writeFileSync(join(dest, 'old-file.js'), 'removed upstream');
  mkdirSync(join(dest, 'node_modules', 'keep'), { recursive: true }); writeFileSync(join(dest, 'node_modules', 'keep', 'x.js'), 'kept');
  const src = join(w.base, 'installed');
  mkdirSync(join(src, 'lib', 'node_modules'), { recursive: true }); mkdirSync(join(src, '.git'), { recursive: true });
  writeFileSync(join(src, 'package.json'), '{"name":"x","version":"1.0.0"}');
  writeFileSync(join(src, 'lib', 'a.js'), 'a'); writeFileSync(join(src, 'lib', 'node_modules', 'nested.js'), 'nested'); writeFileSync(join(src, '.git', 'HEAD'), 'ref: nope');
  symlinkSync('a.js', join(src, 'lib', 'link.js'));
  await overlayInstalled(dest, src, () => {});
  assert.ok(!existsSync(join(dest, 'old-file.js')), 'stale file removed');
  assert.equal(readFileSync(join(dest, 'lib', 'a.js'), 'utf8'), 'a');
  assert.ok(!existsSync(join(dest, 'lib', 'node_modules')), 'nested node_modules not copied');
  assert.equal(readFileSync(join(dest, 'node_modules', 'keep', 'x.js'), 'utf8'), 'kept', "the repo's own node_modules is left alone");
  assert.notEqual(readFileSync(join(dest, '.git', 'HEAD'), 'utf8'), 'ref: nope', "the source's .git is never copied");
  assert.equal((await import('node:fs')).readlinkSync(join(dest, 'lib', 'link.js')), 'a.js', 'symlinks are copied as links');
  assert.ok(readdirSync(dest).includes('package.json'));
});
