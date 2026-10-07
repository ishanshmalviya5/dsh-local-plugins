// Measures the operations users wait for. `node test/bench.mjs [plugins=20] [bigFiles=3000] [bigCommits=300]`
// Uses the same fake world as the unit tests, so it needs no dsh and no network.
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { makeWorld, makeTarball, g } from './helpers.js';
import { loadRegistry } from '../lib/registry.js';
import { createManager } from '../lib/actions.js';
import { createEnv } from '../lib/env.js';

const N = Number(process.argv[2] ?? 20);
const FILES = Number(process.argv[3] ?? 3000);
const COMMITS = Number(process.argv[4] ?? 300);
const rows = [];
const time = async (label, fn) => { const t = performance.now(); const v = await fn(); const ms = performance.now() - t; rows.push([label, ms]); return v; };
const log = () => {};

const w = makeWorld();
try {
  // ---- many tracked plugins ----
  for (let i = 0; i < N; i++) makeTarball(w.fixtures, `bench-p${i}`, '1.0.0', { 'index.js': `export const n = ${i};\n` });
  await time(`add ${N} plugins (one by one)`, async () => { for (let i = 0; i < N; i++) await w.mgr.addNew({ input: `bench-p${i}` }, log); });
  await time(`apply ${N} plugins (one by one)`, async () => { for (let i = 0; i < N; i++) await w.mgr.apply({ name: `bench-p${i}` }, log); });
  const reg = await time(`load + validate registry (${N} plugins)`, () => loadRegistry(w.env.registryFile));
  await time(`state() (${N} plugins, git stats each)`, () => w.mgr.state(null));
  await time(`state() again`, () => w.mgr.state(null));
  await time(`startup / repair (${N} plugins)`, () => createManager(w.env).startup(log));
  await time(`check for updates (${N} npm plugins, offline fixtures)`, () => w.mgr.checkUpdates({}, log));
  await time(`disk usage (${N} plugins)`, () => w.mgr.diskUsage());
  void reg;

  // ---- one large plugin ----
  const name = 'bench-big';
  makeTarball(w.fixtures, name, '1.0.0', { 'index.js': 'export const v = 0;\n' });
  await w.mgr.addNew({ input: name }, log);
  const dir = w.env.repoDir(name);
  await time(`create ${FILES} files`, async () => {
    for (let d = 0; d < 30; d++) mkdirSync(join(dir, 'src', `d${d}`), { recursive: true });
    for (let i = 0; i < FILES; i++) writeFileSync(join(dir, 'src', `d${i % 30}`, `f${i}.js`), Array.from({ length: 20 }, (_, k) => `export const f${i}_${k} = ${k};\n`).join(''));
    await w.mgr.commit({ name, message: 'many files' }, log);
  });
  await time(`create ${COMMITS} commits`, async () => {
    for (let i = 0; i < COMMITS; i++) { writeFileSync(join(dir, 'src', 'd0', `c${i}.js`), `// ${i}\n`); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', `c${i}`); }
  });
  await time('apply (large: files + history)', () => w.mgr.apply({ name }, log));
  await time('apply again (nothing new; no-op)', () => w.mgr.apply({ name }, log));
  await time('state() with the large plugin tracked', () => w.mgr.state(null));
  writeFileSync(join(dir, 'index.js'), 'export const v = 2;\n');
  await w.mgr.commit({ name, message: 'v2' }, log);
  await time('apply a new commit (snapshot of a large tree)', () => w.mgr.apply({ name }, log));
  await time('rollback to the previous snapshot (already built)', () => w.mgr.apply({ name, ref: loadRegistry(w.env.registryFile).plugins[name].deployHistory[1] }, log));
  await time('disk usage with the large plugin', () => w.mgr.diskUsage());
} finally {
  const w2 = Math.max(...rows.map(([l]) => l.length));
  console.log(`\n${os.platform()} ${os.arch()} · ${os.cpus()[0]?.model} · node ${process.version} · ${N} plugins, ${FILES} files, ${COMMITS} commits\n`);
  for (const [l, ms] of rows) console.log(`${l.padEnd(w2)}  ${ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`}`);
  w.cleanup();
}
