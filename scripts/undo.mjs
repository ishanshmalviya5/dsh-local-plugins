#!/usr/bin/env node
// Emergency undo: put the original plugins back WITHOUT dsh running.
// Use it when a deployed plugin keeps dsh from starting, so Settings → Local Plugins is unreachable.
//
//   node undo.mjs --list                       show what is applied
//   node undo.mjs --all                        restore every applied plugin
//   node undo.mjs <plugin> [<plugin> …]        restore just these
// Options: --profile <name> (default web) · --home <dir> (default $DSH_HOME or ~/.dsh)
//          --dsh-root <dir> (the @deepseek-ai/dsh install; found from `dsh` on PATH when omitted)
//
// Core packages are put back from .backup; profile plugins are re-installed through `dsh plugin add`
// (that step may need network). Your local repos stay tracked — Apply switches back later.
import { realpathSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1] ?? null; };
const has = (n) => argv.includes(n);
const names = argv.filter((a, i) => !a.startsWith('--') && !['--profile', '--home', '--dsh-root'].includes(argv[i - 1]));

const { assertSupportedPlatform } = await import(pathToFileURL(join(root, 'lib/platform.js')).href);
try { assertSupportedPlatform(); } catch (err) { console.error(err.message); process.exit(1); }
const { createEnv, detectDshInstall } = await import(pathToFileURL(join(root, 'lib/env.js')).href);
const { createManager } = await import(pathToFileURL(join(root, 'lib/actions.js')).href);
const { loadRegistry } = await import(pathToFileURL(join(root, 'lib/registry.js')).href);

function findDsh() {
  const explicit = flag('--dsh-root');
  if (explicit) {
    const r = resolve(explicit);
    return { root: r, version: JSON.parse(execFileSync('cat', [join(r, 'package.json')], { encoding: 'utf8' })).version, bin: join(r, 'lib', 'bin.js') };
  }
  try {
    const bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
    return detectDshInstall(['node', realpathSync(bin)]);
  } catch { return null; }
}

const dshHome = resolve(flag('--home') ?? (process.env.DSH_HOME?.trim() || join(process.env.HOME, '.dsh')));
const env = createEnv({ dshHome, profile: flag('--profile') ?? 'web', dsh: findDsh() });
if (!existsSync(env.registryFile)) { console.error(`no registry at ${env.registryFile}`); process.exit(1); }
const applied = Object.values(loadRegistry(env.registryFile).plugins).filter((p) => p.applied);

if (has('--list') || (!has('--all') && !names.length)) {
  if (!applied.length) console.log('nothing is applied');
  for (const p of applied) console.log(`${p.name}  (${p.kind}, deployed ${String(p.deployedSha).slice(0, 12)})`);
  if (applied.length) console.log('\nrun with --all, or name the plugins to restore');
  process.exit(0);
}

const targets = has('--all') ? applied.map((p) => p.name) : names;
const mgr = createManager(env);
let failed = 0;
for (const name of targets) {
  try {
    await mgr.restore({ name }, (l) => console.log(`  ${l}`));
    console.log(`restored ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAILED ${name}: ${err.message}`);
  }
}
console.log(failed ? `\n${failed} failed` : '\ndone — start dsh again');
process.exit(failed ? 1 : 0);
