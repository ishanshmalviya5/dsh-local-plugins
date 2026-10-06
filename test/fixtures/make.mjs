#!/usr/bin/env node
// Fixture plugins for the isolated e2e environment (~/.dsh-test/fixtures):
//   lpm-fake-git    real dsh plugin, origin = bare git repo
//   lpm-fake-npm    real dsh plugin, origin = tarballs in npm/<name>/<ver>.tgz (LPM_NPM_FIXTURES)
//   lpm-fake-build  git origin whose client bundle is produced by `npm run build`
// Each plugin adds a Settings section labelled "<name> v<version>" so the UI
// shows which commit is live, and has notes.txt for conflict scenarios.
//
//   node make.mjs init
//   node make.mjs git-release <name> <version> [notes]   commit + push to the bare origin
//   node make.mjs npm-release <version> [notes]          publish lpm-fake-npm <version>
//   node make.mjs build-fail on|off                      make lpm-fake-build's build fail
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.env.LPM_FIXTURE_ROOT ?? join(homedir(), '.dsh-test', 'fixtures');
const SRC = join(ROOT, 'src');
const GIT = join(ROOT, 'git');
const NPM = join(ROOT, 'npm');

const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
const g = (cwd, ...a) => sh('git', ['-c', 'user.name=fixture', '-c', 'user.email=f@f', '-c', 'commit.gpgsign=false', ...a], cwd);

function clientJs(name, version) {
  return `window.__ModuleLoader__.load({
  id: ${JSON.stringify(name)},
  factory: (require) => {
    var React = require('react');
    return {
      name: ${JSON.stringify(name)},
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: ${JSON.stringify(name)}, order: 95, label: () => ${JSON.stringify(`${name} v${version}`)}, inject: () => ({}) },
          () => React.createElement('div', { 'data-testid': ${JSON.stringify(name)} }, ${JSON.stringify(`${name} ${version} is live`)})));
      },
    };
  },
});
`;
}

function files(name, version, notes, { build = false } = {}) {
  const pkg = {
    name, version, type: 'module', main: 'lib/index.js',
    exports: { '.': './lib/index.js', './client': './client/client.js', './package.json': './package.json' },
    dsh: { manifestVersion: 1, bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
  };
  if (build) pkg.scripts = { build: 'node build.mjs' };
  const out = {
    'package.json': `${JSON.stringify(pkg, null, 2)}\n`,
    'cordis.patch.yml': `- insert:\n    - id: ${name}\n      name: ${name}\n`,
    'lib/index.js': `export const name = ${JSON.stringify(name)};\nexport function apply(ctx) {\n  ctx.logger?.(name)?.info?.('${name} ${version} loaded');\n}\n`,
    'notes.txt': `${notes}\n`,
  };
  if (build) {
    out['.gitignore'] = 'client/client.js\nnode_modules\n';
    out['build.mjs'] = `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';\nif (existsSync('fail.flag')) { console.error('build failed on purpose (fail.flag)'); process.exit(1); }\nmkdirSync('client', { recursive: true });\nwriteFileSync('client/client.js', ${JSON.stringify(clientJs(name, version))});\nconsole.log('built client/client.js');\n`;
  } else {
    out['client/client.js'] = clientJs(name, version);
  }
  return out;
}

function writeTree(dir, map) {
  for (const [rel, content] of Object.entries(map)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

function gitRelease(name, version, notes) {
  const work = join(SRC, name);
  writeTree(work, files(name, version, notes ?? `notes for ${version}`, { build: name === 'lpm-fake-build' }));
  g(work, 'add', '-A');
  g(work, 'commit', '-q', '-m', `release ${version}`);
  g(work, 'tag', `v${version}`); // releases are tagged: the manager follows release tags
  g(work, 'push', '-q', '--tags', 'origin', 'main');
  console.log(`${name} ${version} pushed to ${join(GIT, `${name}.git`)}`);
}

function npmRelease(version, notes) {
  const name = 'lpm-fake-npm';
  const stage = mkdtempSync(join(tmpdir(), 'lpm-fx-'));
  writeTree(join(stage, 'package'), files(name, version, notes ?? `notes for ${version}`));
  mkdirSync(join(NPM, name), { recursive: true });
  sh('tar', ['-czf', join(NPM, name, `${version}.tgz`), '-C', stage, 'package']);
  rmSync(stage, { recursive: true, force: true });
  console.log(`${name} ${version} -> ${join(NPM, name)}`);
}

function initGit(name) {
  const work = join(SRC, name);
  const bare = join(GIT, `${name}.git`);
  rmSync(work, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(GIT, { recursive: true });
  g(work, 'init', '-q', '-b', 'main');
  sh('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  g(work, 'remote', 'add', 'origin', bare);
  gitRelease(name, '1.0.0', 'line from upstream 1.0.0');
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'init') {
  rmSync(NPM, { recursive: true, force: true });
  initGit('lpm-fake-git');
  initGit('lpm-fake-build');
  npmRelease('1.0.0', 'line from upstream 1.0.0');
  console.log(`\ngit origins: file://${GIT}/lpm-fake-git.git  file://${GIT}/lpm-fake-build.git\nnpm fixtures: LPM_NPM_FIXTURES=${NPM}`);
} else if (cmd === 'git-release') {
  gitRelease(args[0], args[1], args[2]);
} else if (cmd === 'npm-release') {
  npmRelease(args[0], args[1]);
} else if (cmd === 'build-fail') {
  const flag = join(SRC, 'lpm-fake-build', 'fail.flag');
  if (args[0] === 'on') writeFileSync(flag, 'x'); else if (existsSync(flag)) rmSync(flag);
  console.log(`build-fail ${args[0]} (commit it in the local repo to take effect)`);
} else {
  console.error('usage: make.mjs init | git-release <name> <version> [notes] | npm-release <version> [notes] | build-fail on|off');
  process.exit(1);
}
