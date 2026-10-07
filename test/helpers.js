// Fake world for unit tests: temp DSH_HOME + profile, a fake dsh install with
// one core package, npm fixture tarballs, a bare git origin, and a fake
// `dsh plugin` CLI that edits the profile package.json like the real one.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnv } from '../lib/env.js';
import { createManager } from '../lib/actions.js';

export const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitc = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
export const g = (cwd, ...args) => sh('git', [...gitc, ...args], cwd);

export function writePkg(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}

/** Make `<fixtures>/<safe>/<version>.tgz` from a file map. */
export function makeTarball(fixtures, name, version, files) {
  const stage = mkdtempSync(join(tmpdir(), 'lpm-tgz-'));
  writePkg(join(stage, 'package'), { 'package.json': { name, version, type: 'module', main: 'index.js' }, ...files });
  const dir = join(fixtures, name.replace(/\//g, '__'));
  mkdirSync(dir, { recursive: true });
  sh('tar', ['-czf', join(dir, `${version}.tgz`), '-C', stage, 'package']);
  rmSync(stage, { recursive: true, force: true });
}

const FAKE_DSH_BIN = `
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
const profile = args[args.indexOf('--profile') + 1];
const [action, spec] = args.slice(args.indexOf('--profile') + 2);
const pdir = path.join(process.env.DSH_HOME, 'profiles', profile);
const pj = path.join(pdir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
fs.appendFileSync(path.join(pdir, 'cli.log'), args.join(' ') + '\\n');
if (action === 'remove') {
  delete pkg.dependencies[spec];
  fs.writeFileSync(pj, JSON.stringify(pkg, null, 2));
  fs.rmSync(path.join(pdir, 'node_modules', spec), { recursive: true, force: true });
  process.exit(0);
}
if (action !== 'add') process.exit(0);
let name, value;
if (spec.startsWith('link:')) { const target = spec.slice(5); name = JSON.parse(fs.readFileSync(path.join(target, 'package.json'))).name; value = spec; }
else { const at = spec.lastIndexOf('@'); name = spec.slice(0, at); value = spec.slice(at + 1); }
pkg.dependencies[name] = value;
fs.writeFileSync(pj, JSON.stringify(pkg, null, 2));
const nm = path.join(pdir, 'node_modules', name);
fs.rmSync(nm, { recursive: true, force: true });
fs.mkdirSync(path.dirname(nm), { recursive: true });
if (spec.startsWith('link:')) fs.symlinkSync(fs.realpathSync(spec.slice(5)), nm); // like pnpm: resolves the link
else fs.writeFileSync(path.join(path.dirname(nm), 'restored-' + path.basename(name)), value);
`;

export function makeWorld() {
  const base = mkdtempSync(join(tmpdir(), 'lpm-world-'));
  const dshHome = join(base, 'home');
  const fixtures = join(base, 'fixtures');
  process.env.LPM_NPM_FIXTURES = fixtures;
  process.env.LPM_NPM_OFFLINE = '1'; // a package without fixtures is simply "not on npm": no network in unit tests
  process.env.DSH_HOME = dshHome;

  // fake dsh install, flat layout like `npm install --prefix`
  const nm = join(base, 'dsh', 'node_modules');
  const dshRoot = join(nm, '@deepseek-ai', 'dsh');
  writePkg(dshRoot, { 'package.json': { name: '@deepseek-ai/dsh', version: '1.0.0' }, 'lib/bin.js': FAKE_DSH_BIN });
  writePkg(join(nm, '@deepseek-ai', 'dsh-base'), { 'package.json': { name: '@deepseek-ai/dsh-base', version: '1.0.0' } });
  writePkg(join(nm, 'dep-x'), { 'package.json': { name: 'dep-x', version: '2.0.0' } });

  // core package: npm release 1.0.0 installed with one hand edit
  const coreFiles = { 'lib/index.js': 'export const v = 1;\n' };
  makeTarball(fixtures, '@deepseek-ai/dsh-fake-core', '1.0.0', { ...coreFiles, 'package.json': { name: '@deepseek-ai/dsh-fake-core', version: '1.0.0', dependencies: { 'dep-x': '^1.0.0' } } });
  writePkg(join(nm, '@deepseek-ai', 'dsh-fake-core'), {
    'package.json': { name: '@deepseek-ai/dsh-fake-core', version: '1.0.0', dependencies: { 'dep-x': '^1.0.0' } },
    'lib/index.js': 'export const v = 1; // hand edit\n',
  });
  makeTarball(fixtures, 'dep-x', '2.0.0', {});

  // profile with one npm-installed third-party plugin
  const profileDir = join(dshHome, 'profiles', 'web');
  writePkg(profileDir, { 'package.json': { name: 'dsh-profile-web', private: true, dependencies: { 'lpm-npm': '^1.0.0' } } });
  makeTarball(fixtures, 'lpm-npm', '1.0.0', { 'index.js': 'export const line = "one";\n' });
  writePkg(join(profileDir, 'node_modules', 'lpm-npm'), { 'package.json': { name: 'lpm-npm', version: '1.0.0', type: 'module', main: 'index.js' }, 'index.js': 'export const line = "one";\n' });

  const env = createEnv({ dshHome, profile: 'web', dsh: { root: dshRoot, version: '1.0.0', bin: join(dshRoot, 'lib', 'bin.js') } });
  const mgr = createManager(env);
  const logs = [];
  const log = (l) => logs.push(l);
  return {
    base, dshHome, fixtures, nm, dshRoot, profileDir, env, mgr, log, logs,
    read: (p) => readFileSync(p, 'utf8'),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** A bare git origin for a buildable plugin. */
export function makeGitOrigin(base, name, { build = 'node -e "require(\'fs\').writeFileSync(\'built.txt\',\'ok\')"' } = {}) {
  const work = join(base, `${name}-src`);
  const bare = join(base, `${name}.git`);
  writePkg(work, {
    'package.json': { name, version: '1.0.0', type: 'module', main: 'index.js', scripts: { build } },
    'index.js': 'export const line = "one";\n',
  });
  g(work, 'init', '-q', '-b', 'main');
  g(work, 'add', '-A');
  g(work, 'commit', '-q', '-m', 'init');
  sh('git', ['clone', '-q', '--bare', work, bare]);
  g(work, 'remote', 'add', 'origin', bare);
  return { work, bare, url: `file://${bare}` };
}

export { symlinkSync, cpSync };
