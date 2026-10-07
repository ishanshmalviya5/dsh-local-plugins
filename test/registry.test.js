import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry, saveRegistry, migrateRegistry, validatePlugin, backupBeforeMigration, RegistryError, CURRENT_VERSION } from '../lib/registry.js';

let dir, file;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lpm-reg-')); file = join(dir, 'registry.json'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const good = (name, extra = {}) => ({ name, kind: 'profile', source: { type: 'npm', name }, ...extra });

test('v1 registry migrates to the current version without losing anything', () => {
  const v1 = { version: 1, dshVersion: '0.2.0-rc.2', restartNeeded: true, upgrade: null, futureField: 7, plugins: { a: good('a', { applied: true, deployedSha: 'abc123', note: 'keep me' }) } };
  writeFileSync(file, JSON.stringify(v1));
  const reg = loadRegistry(file);
  assert.equal(reg.version, CURRENT_VERSION);
  assert.equal(reg.futureField, 7, 'unknown top-level fields kept');
  assert.equal(reg.plugins.a.note, 'keep me', 'unknown plugin fields kept');
  assert.deepEqual(reg.plugins.a.deployHistory, ['abc123']);
  assert.equal(reg.plugins.a.disabled, false);
  assert.equal(reg.settings.keepSnapshots, 3);
  assert.equal(reg.restartNeeded, true);
});

test('migration is idempotent and never overwrites existing values', () => {
  const v1 = { version: 1, settings: { keepSnapshots: 9 }, plugins: { a: good('a', { disabled: true, deployHistory: ['x', 'y'] }) } };
  const once = migrateRegistry(v1);
  const twice = migrateRegistry({ ...once, version: 1 }); // pretend it ran again
  assert.deepEqual(twice, once);
  assert.equal(once.settings.keepSnapshots, 9);
  assert.equal(once.plugins.a.disabled, true);
  assert.deepEqual(once.plugins.a.deployHistory, ['x', 'y']);
});

test('a registry from the future is refused, untouched', () => {
  writeFileSync(file, JSON.stringify({ version: CURRENT_VERSION + 1, plugins: {} }));
  const before = readFileSync(file, 'utf8');
  assert.throws(() => loadRegistry(file), (e) => e instanceof RegistryError && e.code === 'REGISTRY_TOO_NEW' && /newer release/.test(e.message));
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('malformed JSON and wrong shapes give a recovery message, not a crash', () => {
  writeFileSync(file, '{ not json');
  assert.throws(() => loadRegistry(file), (e) => e.code === 'REGISTRY_CORRUPT' && /Repair installation/.test(e.message));
  writeFileSync(file, '[]');
  assert.throws(() => loadRegistry(file), (e) => e.code === 'REGISTRY_INVALID');
  writeFileSync(file, JSON.stringify({ version: 'two', plugins: {} }));
  assert.throws(() => loadRegistry(file), (e) => e.code === 'REGISTRY_INVALID');
  writeFileSync(file, JSON.stringify({ version: 2, plugins: [] }));
  assert.throws(() => loadRegistry(file), (e) => e.code === 'REGISTRY_INVALID');
});

test('one malformed entry is quarantined (kept), the others keep working', () => {
  writeFileSync(file, JSON.stringify({ version: 2, plugins: { ok: good('ok'), bad: { name: 'bad', kind: 'weird' }, worse: 5, mismatch: good('other') } }));
  const reg = loadRegistry(file);
  assert.deepEqual(Object.keys(reg.plugins), ['ok']);
  assert.deepEqual(Object.keys(reg.quarantine).sort(), ['bad', 'mismatch', 'worse']);
  assert.match(reg.quarantine.bad.problems.join(' '), /kind must be/);
  assert.deepEqual(reg.quarantine.bad.entry, { name: 'bad', kind: 'weird' }, 'original kept for recovery');
  saveRegistry(file, reg);
  assert.ok(loadRegistry(file).quarantine.bad, 'quarantine survives a save');
});

test('validatePlugin checks the parts the code depends on', () => {
  assert.deepEqual(validatePlugin('a', good('a')), []);
  assert.match(validatePlugin('a', good('a', { kind: 'core' })).join(), /core\.path/);
  assert.deepEqual(validatePlugin('a', good('a', { kind: 'core', core: { path: '/p', nodeModules: '/n' } })), []);
  assert.match(validatePlugin('a', { ...good('a'), source: { type: 'git' } }).join(), /url/);
  assert.match(validatePlugin('a', { ...good('a'), depOverrides: [] }).join(), /depOverrides/);
});

test('the pre-migration file is backed up once, and saving writes the new version with private permissions', () => {
  writeFileSync(file, JSON.stringify({ version: 1, plugins: {} }));
  const bak = backupBeforeMigration(file);
  assert.equal(bak, `${file}.v1.bak`);
  assert.equal(JSON.parse(readFileSync(bak, 'utf8')).version, 1);
  saveRegistry(file, loadRegistry(file));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, CURRENT_VERSION);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(backupBeforeMigration(file), null, 'nothing to back up once current');
  writeFileSync(`${file}.v1.bak`, 'precious');
  writeFileSync(file, JSON.stringify({ version: 1, plugins: {} }));
  backupBeforeMigration(file);
  assert.equal(readFileSync(`${file}.v1.bak`, 'utf8'), 'precious', 'an existing backup is never overwritten');
  assert.ok(!readdirSync(dir).some((f) => f.includes('.tmp-')), 'no temp files left');
});

import { makeWorld } from './helpers.js';
test('state() reports a broken registry instead of throwing; a v1 registry is migrated on boot with a backup', async () => {
  const w = makeWorld();
  try {
    mkdirSync(w.env.root, { recursive: true });
    writeFileSync(w.env.registryFile, '{ broken');
    const s = await w.mgr.state(null);
    assert.equal(s.registryError.code, 'REGISTRY_CORRUPT');
    assert.deepEqual(s.plugins, []);

    writeFileSync(w.env.registryFile, JSON.stringify({ version: 1, plugins: {} }));
    w.mgr.boot();
    assert.ok(existsSync(`${w.env.registryFile}.v1.bak`));
    assert.equal(JSON.parse(readFileSync(w.env.registryFile, 'utf8')).version, CURRENT_VERSION);
  } finally { w.cleanup(); }
});

test('startup on a v0.1 registry keeps a backup of the original file (first save, not just boot)', async () => {
  const w = makeWorld();
  try {
    mkdirSync(w.env.root, { recursive: true });
    const v1 = { version: 1, dshVersion: '0.2.0-rc.2', restartNeeded: false, upgrade: null, plugins: {} };
    writeFileSync(w.env.registryFile, JSON.stringify(v1));
    await w.mgr.startup(() => {});
    assert.equal(JSON.parse(readFileSync(w.env.registryFile, 'utf8')).version, CURRENT_VERSION);
    assert.equal(JSON.parse(readFileSync(`${w.env.registryFile}.v1.bak`, 'utf8')).version, 1, 'the untouched v1 file is kept');
    assert.deepEqual(JSON.parse(readFileSync(`${w.env.registryFile}.v1.bak`, 'utf8')), v1);
  } finally { w.cleanup(); }
});
