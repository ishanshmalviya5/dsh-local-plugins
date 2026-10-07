import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeWorld, makeTarball, g } from './helpers.js';
import { loadRegistry } from '../lib/registry.js';
import { npmVersion, parseNpmInput, isExactVersion, inspectPackage } from '../lib/sources.js';

let w;
beforeEach(() => { w = makeWorld(); });
afterEach(() => w.cleanup());
const reg = () => loadRegistry(w.env.registryFile);
const repo = (n) => w.env.repoDir(n);
const fx = (name, version, pkgExtra = {}, files = {}) => makeTarball(w.fixtures, name, version, { 'index.js': `export const v = "${version}";\n`, ...files, ...(Object.keys(pkgExtra).length ? { 'package.json': { name, version, type: 'module', main: 'index.js', ...pkgExtra } } : {}) });

test('input parsing: name, name@version, name@tag, scoped names', () => {
  assert.deepEqual(parseNpmInput('lpm'), { name: 'lpm', spec: null });
  assert.deepEqual(parseNpmInput('lpm@1.2.3'), { name: 'lpm', spec: '1.2.3' });
  assert.deepEqual(parseNpmInput('lpm@beta'), { name: 'lpm', spec: 'beta' });
  assert.deepEqual(parseNpmInput('@scope/lpm'), { name: '@scope/lpm', spec: null });
  assert.deepEqual(parseNpmInput('@scope/lpm@^1.2'), { name: '@scope/lpm', spec: '^1.2' });
  assert.ok(isExactVersion('1.2.3') && isExactVersion('v1.2.3-rc.1') && !isExactVersion('^1.2.3') && !isExactVersion('latest') && !isExactVersion(null));
});

test('exact version: installs exactly that version and never offers a newer one', async () => {
  fx('lpm-multi', '1.0.0'); fx('lpm-multi', '1.1.0');
  await w.mgr.addNew({ input: 'lpm-multi@1.0.0' }, w.log);
  const p = reg().plugins['lpm-multi'];
  assert.equal(p.upstreamVersion, '1.0.0');
  assert.equal(p.source.spec, '1.0.0');
  assert.match(readFileSync(join(repo('lpm-multi'), 'index.js'), 'utf8'), /1\.0\.0/);
  await w.mgr.checkUpdates({}, w.log);
  assert.equal(reg().plugins['lpm-multi'].update.available, false);
  // and without a spec it follows latest
  await w.mgr.addNew({ input: 'lpm-other' }, w.log).catch(() => {});
});

test('no spec follows the newest release; a missing version or package is a readable error and adds nothing', async () => {
  fx('lpm-multi', '1.0.0'); fx('lpm-multi', '1.1.0');
  await w.mgr.addNew({ input: 'lpm-multi' }, w.log);
  assert.equal(reg().plugins['lpm-multi'].upstreamVersion, '1.1.0');
  rmSync(repo('lpm-multi'), { recursive: true, force: true });
  const r = reg(); delete r.plugins['lpm-multi']; (await import('../lib/registry.js')).saveRegistry(w.env.registryFile, r);

  await assert.rejects(w.mgr.addNew({ input: 'lpm-multi@9.9.9' }, w.log), (e) => e.code === 'NPM_VERSION_NOT_FOUND' && /no version of lpm-multi matching "9\.9\.9"/.test(e.message));
  await assert.rejects(w.mgr.addNew({ input: 'does-not-exist-pkg' }, w.log), (e) => e.code === 'NPM_PACKAGE_NOT_FOUND' && /not on npm/.test(e.message));
  assert.deepEqual(Object.keys(reg().plugins), []);
  assert.deepEqual(readdirSync(w.env.root).filter((n) => !n.startsWith('.') && n !== 'registry.json'), []);
});

test('a package removed from npm after it was added: update check says so, local copy untouched', async () => {
  fx('lpm-multi', '1.0.0');
  await w.mgr.addNew({ input: 'lpm-multi' }, w.log);
  rmSync(join(w.fixtures, 'lpm-multi'), { recursive: true, force: true });
  await w.mgr.checkUpdates({}, w.log);
  const u = reg().plugins['lpm-multi'].update;
  assert.match(u.error, /not on npm \(it may have been removed or renamed\)/);
  assert.match(u.error, /local copy is unchanged/);
  assert.equal(g(repo('lpm-multi'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'local');
});

// ---------- npm failure modes, through a fake `npm` executable ----------

function fakeNpm(script) {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-fakenpm-'));
  writeFileSync(join(dir, 'npm'), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, 'npm'), 0o755);
  return dir;
}
async function withFakeNpm(script, fn) {
  const dir = fakeNpm(script);
  const oldPath = process.env.PATH; const oldOffline = process.env.LPM_NPM_OFFLINE;
  process.env.PATH = `${dir}:${oldPath}`; delete process.env.LPM_NPM_OFFLINE;
  try { return await fn(); } finally { process.env.PATH = oldPath; if (oldOffline) process.env.LPM_NPM_OFFLINE = oldOffline; rmSync(dir, { recursive: true, force: true }); }
}

test('npm failures are translated into actionable errors', async () => {
  const cases = [
    ['echo "npm error code E404" >&2; echo "npm error 404 Not Found - GET https://registry.npmjs.org/x" >&2; exit 1', 'NPM_PACKAGE_NOT_FOUND', /not on npm/],
    ['echo "npm error code ETARGET" >&2; echo "npm error notarget No matching version found for x@9" >&2; exit 1', 'NPM_VERSION_NOT_FOUND', /no version of x matching/],
    ['echo "npm error code ENOTFOUND" >&2; echo "npm error network request failed" >&2; exit 1', 'NPM_UNREACHABLE', /cannot reach npm/],
    ['echo "npm error code E403" >&2; echo "npm error 403 Forbidden" >&2; exit 1', 'NPM_ACCESS_DENIED', /refused access/],
    ['echo "this is not json"; exit 0', 'NPM_BAD_METADATA', /unreadable metadata/],
    ['echo "{}"; exit 0', 'NPM_VERSION_NOT_FOUND', /no version/],
    ['echo "npm error something odd with token=abc123secret" >&2; exit 1', 'NPM_LOOKUP_FAILED', /^((?!abc123secret).)*$/s],
  ];
  for (const [script, code, pattern] of cases) {
    await withFakeNpm(script, async () => {
      await assert.rejects(npmVersion('x', 'latest'), (e) => e.code === code && pattern.test(e.message), `${code}: ${script}`);
    });
  }
  await withFakeNpm('echo \'["1.0.0","1.2.0"]\'', async () => assert.equal(await npmVersion('x', '^1'), '1.2.0', 'a range answered with a list takes the newest'));
});

// ---------- package manifests ----------

test('manifest checks: missing/odd dsh manifest warns, unsupported manifestVersion refuses, bad package.json refuses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-mf-'));
  const put = (pkg) => writeFileSync(join(dir, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
  put({ name: 'a', version: '1.0.0' });
  assert.match(inspectPackage(dir).warnings.join(), /no "dsh" manifest/);
  put({ name: 'a', dsh: 'nope' });
  assert.match(inspectPackage(dir).warnings.join(), /not an object/);
  put({ name: 'a', dsh: { manifestVersion: 1 } });
  assert.deepEqual(inspectPackage(dir).warnings, []);
  put({ name: 'a', dsh: { manifestVersion: 2 } });
  assert.throws(() => inspectPackage(dir), (e) => e.code === 'INCOMPATIBLE_MANIFEST' && /does not understand/.test(e.message));
  put('{ nope');
  assert.throws(() => inspectPackage(dir), (e) => e.code === 'BAD_PACKAGE' && /invalid JSON/.test(e.message));
  put({ version: '1' });
  assert.throws(() => inspectPackage(dir), (e) => e.code === 'BAD_PACKAGE' && /no "name"/.test(e.message));
  put({ name: 'b', dsh: { manifestVersion: 1 } });
  assert.throws(() => inspectPackage(dir, { expectName: 'a' }), (e) => e.code === 'PACKAGE_RENAMED' && e.details.to === 'b');
  rmSync(dir, { recursive: true, force: true });
});

test('adding a package without a usable package.json adds nothing', async () => {
  fx('lpm-badpkg', '1.0.0', {}, { 'package.json': '{ not json' });
  await assert.rejects(w.mgr.addNew({ input: 'lpm-badpkg' }, w.log), (e) => e.code === 'BAD_PACKAGE' || /JSON/.test(e.message));
  assert.deepEqual(Object.keys(reg().plugins), []);
  assert.ok(!existsSync(repo('lpm-badpkg')));
});

test('an update that renames the package, or needs a newer manifest, is refused and local stays untouched', async () => {
  fx('lpm-ren', '1.0.0', { dsh: { manifestVersion: 1 } });
  await w.mgr.addNew({ input: 'lpm-ren' }, w.log);
  const localBefore = g(repo('lpm-ren'), 'rev-parse', 'local');

  fx('lpm-ren', '2.0.0', { name: 'lpm-ren-new', dsh: { manifestVersion: 1 } });
  await w.mgr.checkUpdates({}, w.log);
  await assert.rejects(w.mgr.update({ name: 'lpm-ren' }, w.log), (e) => e.code === 'PACKAGE_RENAMED' && e.details.to === 'lpm-ren-new');
  assert.equal(g(repo('lpm-ren'), 'rev-parse', 'local'), localBefore);
  assert.equal(reg().plugins['lpm-ren'].pending, null);
  assert.ok(!existsSync(join(w.env.workDir, 'lpm-ren')), 'the trial merge was cleaned up');

  fx('lpm-ren', '3.0.0', { dsh: { manifestVersion: 2 } });
  await w.mgr.checkUpdates({}, w.log);
  await assert.rejects(w.mgr.update({ name: 'lpm-ren' }, w.log), (e) => e.code === 'INCOMPATIBLE_MANIFEST');
  assert.equal(g(repo('lpm-ren'), 'rev-parse', 'local'), localBefore);
});
