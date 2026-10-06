#!/usr/bin/env node
// End-to-end scenarios against the live isolated test instance (:3091), driven
// through the manager's HTTP API, asserting disk state after every step. The
// Playwright pass then covers the same flows through the UI.
//
//   node test/e2e/api-scenarios.mjs [scenario-number ...]
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const T = join(homedir(), '.dsh-test');
const HOME = join(T, 'home');
const PROFILE = join(HOME, 'profiles', 'lpm-test');
const ROOT = join(HOME, 'local-plugins');
const BASE = 'http://127.0.0.1:3091';
const FX = fileURLToPath(new URL('../fixtures/make.mjs', import.meta.url));
const NPM_PREFIX = join(T, 'npm');
const CORE = '@deepseek-ai/dsh-llm-pi-ai';
const CORE_PATH = join(NPM_PREFIX, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai');

let cookie = '';
const results = [];
let current = null;

// ---------- plumbing ----------
function tokenUrl() {
  const logs = [join(T, 'dsh-web.log'), join(HOME, 'logs', 'dsh-web-restart-3091.log')].filter(existsSync);
  const lines = logs.flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l) => ({ l, t: lstatSync(f).mtimeMs })))
    .filter((x) => x.l.includes('dsh web: http'));
  lines.sort((a, b) => a.t - b.t);
  return lines.at(-1)?.l.split('dsh web: ')[1].trim();
}
async function login() {
  const res = await fetch(tokenUrl(), { redirect: 'manual' });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
}
async function call(action, body = {}) {
  const res = await fetch(`${BASE}/local-plugins-api/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!data.ok) throw new Error(`${action}: ${data.error}`);
  return data.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function op(action, body) {
  const { opId } = await call(action, body);
  for (;;) {
    const o = await call('op', { id: opId });
    if (o && o.status !== 'running') return o;
    await sleep(400);
  }
}
async function opOk(action, body) {
  const o = await op(action, body);
  if (o.status !== 'ok') throw new Error(`${action} failed: ${o.error}\n${o.log.slice(-15).join('\n')}`);
  return o;
}
const state = () => call('state');
const plugin = async (name) => (await state()).plugins.find((p) => p.name === name);
async function restart() {
  await call('restart');
  await sleep(1500);
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(`${BASE}/`); if (r.status) break; } catch { /* down */ }
    await sleep(1000);
  }
  await sleep(1500);
  try { await state(); } catch { await login(); await state(); }
}
const pkgJson = () => JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'));
const live = (name) => realpathSync(join(ROOT, '.deployed', name.replace(/\//g, '__')));
const repo = (name) => join(ROOT, name.replace(/\//g, '__'));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();
const fx = (...a) => execFileSync('node', [FX, ...a], { encoding: 'utf8' });
/** Body of the combo script that carries `<name>/client.js` (bundles are served as combos). */
async function served(name) {
  const html = await (await fetch(`${BASE}/`, { headers: { cookie } })).text();
  const combos = [...html.matchAll(/plugins\/\?\?[^"'<> ]+/g)].map((m) => m[0].replace(/&amp;/g, '&'));
  const combo = combos.find((u) => u.includes(`,${name}/client.js`) || u.includes(`??${name}/client.js`));
  if (!combo) return `no combo for ${name}`;
  const r = await fetch(`${BASE}/${combo}`, { headers: { cookie } });
  return r.ok ? r.text() : `HTTP ${r.status}`;
}
function check(cond, fact) {
  current.facts.push({ ok: Boolean(cond), fact });
  if (!cond) throw new Error(`assertion failed: ${fact}`);
}

async function scenario(n, title, fn) {
  if (ONLY.length && !ONLY.includes(n)) return;
  current = { n, title, facts: [], status: 'pass', error: null };
  results.push(current);
  process.stdout.write(`\n[${n}] ${title}\n`);
  try { await fn(); } catch (err) { current.status = 'fail'; current.error = err.message; }
  for (const f of current.facts) process.stdout.write(`   ${f.ok ? '✔' : '✖'} ${f.fact}\n`);
  if (current.error) process.stdout.write(`   ERROR ${current.error}\n`);
}

const ONLY = process.argv.slice(2).map(Number);
await login();

// ---------- scenarios ----------
await scenario(1, 'Load: API reachable, section data, auth enforced', async () => {
  const s = await state();
  check(s.env.profile === 'lpm-test', `profile = ${s.env.profile}`);
  const anon = await fetch(`${BASE}/local-plugins-api/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check(anon.status === 401, `unauthenticated request -> ${anon.status}`);
  check((await served('dsh-local-plugins')).includes('Local Plugins'), 'client bundle served at /plugins/dsh-local-plugins/client.js');
});

await scenario(2, 'Migrate third-party (dsh-jev-decide) → Apply → restart', async () => {
  await opOk('migrate', { name: 'dsh-jev-decide', origin: 'auto' });
  let p = await plugin('dsh-jev-decide');
  check(p && !p.applied, `registered, Tracked only (origin ${p?.source.type})`);
  const branches = git(repo('dsh-jev-decide'), 'branch', '--format=%(refname:short)').split('\n');
  check(branches.includes('upstream') && branches.includes('local'), `repo branches: ${branches.join(', ')}`);
  await opOk('apply', { name: 'dsh-jev-decide' });
  const dep = pkgJson().dependencies['dsh-jev-decide'];
  check(dep === `link:${join(ROOT, '.deployed', 'dsh-jev-decide')}`, `profile dep = ${dep}`);
  check(/^dsh-jev-decide@[0-9a-f]{12}$/.test(basename(live('dsh-jev-decide'))), `stable link -> ${basename(live('dsh-jev-decide'))}`);
  check((await state()).restartNeeded, 'restart needed flagged');
  await restart();
  check(!(await state()).restartNeeded, 'restart cleared the flag');
  check(pkgJson().dsh.profile.bundles.includes('dsh-jev-decide'), 'bundle still composed after restart');
});

await scenario(3, 'Commit-only rule', async () => {
  const dir = repo('dsh-jev-decide');
  const before = live('dsh-jev-decide');
  writeFileSync(join(dir, 'LOCAL-EDIT.md'), 'edited locally\n');
  let p = await plugin('dsh-jev-decide');
  check(p.stats.uncommitted === 1, `uncommitted = ${p.stats.uncommitted}`);
  check(!existsSync(join(before, 'LOCAL-EDIT.md')), 'live snapshot does not see the uncommitted file');
  await opOk('commit', { name: 'dsh-jev-decide', message: 'add LOCAL-EDIT.md' });
  p = await plugin('dsh-jev-decide');
  check(p.stats.notApplied === 1, `newer commits not applied = ${p.stats.notApplied}`);
  const o = await opOk('apply', { name: 'dsh-jev-decide' });
  check(live('dsh-jev-decide') !== before && existsSync(join(live('dsh-jev-decide'), 'LOCAL-EDIT.md')), `live -> ${basename(live('dsh-jev-decide'))}`);
  check(!o.log.some((l) => /dsh plugin add/.test(l)), 'redeploy was only a link swap (no dsh plugin add)');
});

await scenario(4, 'Rollback to an older commit; snapshots pruned to 3', async () => {
  const dir = repo('dsh-jev-decide');
  for (const n of [1, 2]) {
    writeFileSync(join(dir, 'LOCAL-EDIT.md'), `edit ${n}\n`);
    await opOk('apply', { name: 'dsh-jev-decide' });
  }
  const { commits } = await call('commits', { name: 'dsh-jev-decide' });
  const target = commits[3];
  await opOk('apply', { name: 'dsh-jev-decide', ref: target.sha });
  const p = await plugin('dsh-jev-decide');
  check(p.deployedSha === target.sha, `deployed ${target.sha.slice(0, 12)} (${target.subject})`);
  const snaps = readdirSync(join(ROOT, '.deployed')).filter((e) => e.startsWith('dsh-jev-decide@'));
  check(snaps.length <= 3, `snapshots kept: ${snaps.length}`);
  await opOk('apply', { name: 'dsh-jev-decide' }); // back to HEAD
});

await scenario(5, 'Restore original, then Apply again', async () => {
  await opOk('restore', { name: 'dsh-jev-decide' });
  const dep = pkgJson().dependencies['dsh-jev-decide'];
  check(!dep.startsWith('link:'), `profile dep = ${dep} (pnpm records the resolved range of "latest")`);
  const nm = join(PROFILE, 'node_modules', 'dsh-jev-decide');
  const latest = execFileSync('npm', ['view', 'dsh-jev-decide', 'version'], { encoding: 'utf8' }).trim();
  const installed = JSON.parse(readFileSync(join(nm, 'package.json'), 'utf8')).version;
  check(!lstatSync(nm).isSymbolicLink() && installed === latest, `node_modules/dsh-jev-decide is the npm copy ${installed} (latest ${latest})`);
  const p = await plugin('dsh-jev-decide');
  check(p && !p.applied, 'still tracked, state Tracked only');
  check(existsSync(join(ROOT, '.deployed', 'dsh-jev-decide')), '.deployed snapshots untouched');
  await opOk('apply', { name: 'dsh-jev-decide' });
  check(pkgJson().dependencies['dsh-jev-decide'].startsWith('link:'), 'Apply switched back to the local link');
});

await scenario(6, 'Add new from origin (git URL + npm name), apply both, restart', async () => {
  await opOk('add', { input: `file://${join(T, 'fixtures', 'git', 'lpm-fake-git.git')}` });
  await opOk('add', { input: 'lpm-fake-npm' });
  check(Boolean(await plugin('lpm-fake-git')) && Boolean(await plugin('lpm-fake-npm')), 'both registered');
  await opOk('apply', { name: 'lpm-fake-git' });
  await opOk('apply', { name: 'lpm-fake-npm' });
  await restart();
  check((await served('lpm-fake-git')).includes('lpm-fake-git 1.0.0 is live'), 'lpm-fake-git 1.0.0 client served');
  check((await served('lpm-fake-npm')).includes('lpm-fake-npm 1.0.0 is live'), 'lpm-fake-npm 1.0.0 client served');
});

await scenario(7, 'Update, clean (git + npm): Check now → Update → Apply → restart', async () => {
  fx('git-release', 'lpm-fake-git', '1.1.0', 'line from upstream 1.0.0');
  fx('npm-release', '1.1.0', 'line from upstream 1.0.0');
  await opOk('check', {});
  const s = await state();
  const avail = s.plugins.filter((p) => p.update?.available).map((p) => p.name);
  check(avail.includes('lpm-fake-git') && avail.includes('lpm-fake-npm'), `updates available: ${avail.join(', ')}`);
  for (const n of ['lpm-fake-git', 'lpm-fake-npm']) {
    const o = await opOk('update', { name: n });
    check(o.result.status === 'merged', `${n}: ${o.result.status}`);
    check(!(await plugin(n)).update.available, `${n}: badge cleared`);
    await opOk('apply', { name: n });
  }
  await restart();
  check((await served('lpm-fake-git')).includes('1.1.0 is live'), 'lpm-fake-git 1.1.0 live');
  check((await served('lpm-fake-npm')).includes('1.1.0 is live'), 'lpm-fake-npm 1.1.0 live');
});

await scenario(8, 'Update with conflict: Fix-with-agent draft, Finish; and Abort', async () => {
  const dir = repo('lpm-fake-git');
  writeFileSync(join(dir, 'notes.txt'), 'line edited locally\n');
  await opOk('commit', { name: 'lpm-fake-git', message: 'local notes' });
  await opOk('apply', { name: 'lpm-fake-git' });
  const liveBefore = live('lpm-fake-git');
  fx('git-release', 'lpm-fake-git', '1.2.0', 'line changed upstream in 1.2.0');
  const o = await opOk('update', { name: 'lpm-fake-git' });
  check(o.result.status === 'conflict', `update -> ${o.result.status} (${o.result.conflicts?.join(', ')})`);
  const p = await plugin('lpm-fake-git');
  check(existsSync(p.pending.worktree), `worktree ${p.pending.worktree}`);
  check(live('lpm-fake-git') === liveBefore, 'live snapshot unchanged');
  const draft = await call('agentDraft', { name: 'lpm-fake-git', mode: 'conflict' });
  check(draft.path === p.pending.worktree && draft.text.includes('notes.txt'), 'agent draft targets the worktree and lists notes.txt');
  const fin1 = await op('finish', { name: 'lpm-fake-git' });
  check(fin1.status === 'error' && /markers/.test(fin1.error), 'Finish refused while markers remain');
  writeFileSync(join(p.pending.worktree, 'notes.txt'), 'line edited locally + upstream 1.2.0\n');
  await opOk('finish', { name: 'lpm-fake-git' });
  check(readFileSync(join(dir, 'notes.txt'), 'utf8').includes('+ upstream 1.2.0'), 'local has the resolution');
  check((await plugin('lpm-fake-git')).pending === null, 'pending cleared');

  // abort path on the npm plugin
  const ndir = repo('lpm-fake-npm');
  writeFileSync(join(ndir, 'notes.txt'), 'npm line edited locally\n');
  await opOk('commit', { name: 'lpm-fake-npm' });
  const head = git(ndir, 'rev-parse', 'local');
  fx('npm-release', '1.2.0', 'npm line changed upstream');
  const o2 = await opOk('update', { name: 'lpm-fake-npm' });
  check(o2.result.status === 'conflict', `npm update -> ${o2.result.status}`);
  await opOk('abort', { name: 'lpm-fake-npm' });
  check(git(ndir, 'rev-parse', 'local') === head, 'Abort: local unchanged');
  const np = await plugin('lpm-fake-npm');
  check(np.pending === null && np.update.available, 'Abort: no pending, update still offered');
});

await scenario(9, 'Work on it: draft targets the repo folder', async () => {
  const d = await call('agentDraft', { name: 'dsh-jev-decide', mode: 'work' });
  check(d.path === repo('dsh-jev-decide'), `path ${d.path}`);
  check(/dsh only runs committed code/.test(d.text) && d.text.trimEnd().endsWith('Task:'), 'draft explains the commit-only rule and ends with "Task:"');
});

await scenario(10, 'Build failure keeps the live snapshot', async () => {
  await opOk('add', { input: `file://${join(T, 'fixtures', 'git', 'lpm-fake-build.git')}` });
  await opOk('apply', { name: 'lpm-fake-build' });
  const good = live('lpm-fake-build');
  check(existsSync(join(good, 'client', 'client.js')), 'build produced client/client.js in the snapshot');
  writeFileSync(join(repo('lpm-fake-build'), 'fail.flag'), 'x');
  const o = await op('apply', { name: 'lpm-fake-build' });
  check(o.status === 'error' && o.log.some((l) => /build failed on purpose/.test(l)), `apply failed with build log (${o.error?.split('\n')[0]})`);
  check(live('lpm-fake-build') === good, 'stable link still on the last good snapshot');
  execFileSync('git', ['-C', repo('lpm-fake-build'), 'rm', '-q', 'fail.flag']);
  await opOk('commit', { name: 'lpm-fake-build', message: 'unbreak build' });
});

await scenario(11, 'Core override: migrate dsh-llm-pi-ai, dep override, apply, restart, restore', async () => {
  await opOk('migrate', { name: CORE });
  await opOk('apply', { name: CORE });
  check(lstatSync(CORE_PATH).isSymbolicLink() && readlinkSync(CORE_PATH) === join(ROOT, '.deployed', '@deepseek-ai__dsh-llm-pi-ai'), 'core dir is a symlink to the stable link');
  const p = await plugin(CORE);
  check(existsSync(p.core.backup), `original backed up at ${p.core.backup}`);
  await opOk('setDep', { name: CORE, dep: '@earendil-works/pi-ai', range: 'latest' });
  const o = await opOk('apply', { name: CORE });
  const latest = execFileSync('npm', ['view', '@earendil-works/pi-ai', 'version'], { encoding: 'utf8' }).trim();
  const have = JSON.parse(readFileSync(join(NPM_PREFIX, 'node_modules', '@earendil-works', 'pi-ai', 'package.json'), 'utf8')).version;
  check(have === latest, `pi-ai installed ${have} (npm latest ${latest})`);
  check(JSON.parse(readFileSync(join(live(CORE), 'package.json'), 'utf8')).dependencies['@earendil-works/pi-ai'] === 'latest', 'deployed package.json declares latest');
  check(lstatSync(CORE_PATH).isSymbolicLink(), `still linked after npm install (${o.log.filter((l) => /npm install/.test(l)).length} install)`);
  await restart();
  check((await state()).env.dshVersion, 'dsh booted with the core override');
  await opOk('restore', { name: CORE });
  check(!lstatSync(CORE_PATH).isSymbolicLink() && existsSync(join(CORE_PATH, 'package.json')), 'restore put the original dir back');
  await opOk('apply', { name: CORE }); // keep active for scenario 12
  check(lstatSync(CORE_PATH).isSymbolicLink(), 're-applied for the upgrade test');
});

await scenario(12, 'dsh reinstall resets the core link → banner → Reapply all', async () => {
  execFileSync('rm', [CORE_PATH]);
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: NPM_PREFIX, stdio: 'ignore' });
  check(!lstatSync(CORE_PATH).isSymbolicLink(), 'reinstall replaced the symlink with a real dir');
  await restart();
  const s = await state();
  check(s.upgrade && s.upgrade.lost >= 1, `banner: ${JSON.stringify(s.upgrade)}`);
  check(s.plugins.find((p) => p.name === CORE).linkLost, 'plugin marked Link lost');
  const o = await opOk('reapplyAll', {});
  check(lstatSync(CORE_PATH).isSymbolicLink(), 're-linked');
  check((await state()).upgrade === null, `banner cleared (${o.result.summary.join('; ')})`);
});

await scenario(13, 'Restart from the API returns on :3091', async () => {
  await restart();
  check((await state()).env.profile === 'lpm-test', 'instance back on 3091');
});

writeFileSync(fileURLToPath(new URL('./api-results.json', import.meta.url)), `${JSON.stringify(results, null, 2)}\n`);
const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
process.exit(failed.length ? 1 : 0);
