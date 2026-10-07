#!/usr/bin/env node
// Validate what would actually be published: pack the tarball, inspect it, install it into an
// empty project and exercise it from there.  `npm run check:package`
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const { redact } = await import(pathToFileURL(join(root, 'lib', 'redact.js')).href);
const { privateTerms } = await import(pathToFileURL(join(root, 'scripts', 'private-terms.mjs')).href);
const problems = [];
const bad = (m) => problems.push(m);
const ok = (m) => console.log(`  ✔ ${m}`);

const work = mkdtempSync(join(tmpdir(), 'lpm-pack-'));
try {
  // ---- 1. pack ----
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', work], { cwd: root, encoding: 'utf8' }))[0];
  const tgz = join(work, packed.filename);
  const names = packed.files.map((f) => f.path);
  console.log(`${packed.filename}: ${names.length} files, ${(packed.size / 1024).toFixed(0)} KB`);

  // ---- 2. only intended files ----
  const ALLOWED = [/^package\.json$/, /^README\.md$/, /^CHANGELOG\.md$/, /^LICENSE$/, /^cordis\.patch\.yml$/, /^lib\/[\w.-]+\.m?js$/, /^client\/client\.js$/, /^docs\/[\w.-]+\.md$/, /^scripts\/(undo\.mjs|self-deploy\.sh)$/];
  const stray = names.filter((n) => !ALLOWED.some((re) => re.test(n)));
  stray.length ? bad(`unexpected files in the package: ${stray.join(', ')}`) : ok('only intended files are included (runtime, client bundle, docs, two scripts)');
  const FORBIDDEN = [/(^|\/)\.env/, /\.log$/, /\.tgz$/, /node_modules/, /(^|\/)test\//, /RELEASE-HANDOFF/, /conversation/, /\.DS_Store/, /\.git(\/|$)/, /public\//, /\.pem$|\.key$|id_rsa/];
  const forbidden = names.filter((n) => FORBIDDEN.some((re) => re.test(n)));
  forbidden.length ? bad(`forbidden files in the package: ${forbidden.join(', ')}`) : ok('no tests, .env, keys, logs, handoff notes or conversation exports');
  for (const must of ['README.md', 'CHANGELOG.md', 'LICENSE', 'client/client.js', 'lib/index.js', 'cordis.patch.yml', 'scripts/undo.mjs']) if (!names.includes(must)) bad(`the package is missing ${must}`);
  ok('README, CHANGELOG, LICENSE, client bundle and entry points are present');

  // ---- 3. contents: no secrets, no local paths, no personal data ----
  const ex = join(work, 'x'); mkdirSync(ex);
  execFileSync('tar', ['-xzf', tgz, '-C', ex]);
  const LOCAL = privateTerms({ username: userInfo().username });
  const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
  const ALLOWED_EMAILS = new Set(['local-plugins@dsh.local']);
  const walk = (d, o = []) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p, o) : o.push(p); } return o; };
  for (const f of walk(join(ex, 'package'))) {
    const rel = f.slice(join(ex, 'package').length + 1);
    const text = readFileSync(f, 'utf8');
    for (const re of LOCAL) if (re.test(text)) bad(`${rel}: contains a local path or private name (${re})`);
    for (const m of text.match(EMAIL) ?? []) if (!ALLOWED_EMAILS.has(m) && !/@(scope|\d|types|deepseek-ai|earendil-works)/.test(m) && !/^[\w.-]+@\d/.test(m) && !/\.(js|mjs|json)$/.test(m)) bad(`${rel}: contains an e-mail address (${m})`);
    // anything the redactor would mask is a secret-looking string (docs may *describe* patterns, so only flag long token shapes)
    if (/(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(text)) bad(`${rel}: contains something that looks like a credential`);
    void redact;
  }
  ok('no local paths, private names, e-mail addresses or credential-shaped strings');

  // ---- 4. manifest ----
  const m = JSON.parse(readFileSync(join(ex, 'package', 'package.json'), 'utf8'));
  if (m.version !== pkg.version) bad('packed version differs from package.json');
  if (m.private) bad('package.json is marked private');
  if (m.dsh?.manifestVersion !== 1 || m.dsh?.client?.platform !== 'web') bad('the dsh manifest is missing or wrong');
  const changelog = readFileSync(join(ex, 'package', 'CHANGELOG.md'), 'utf8');
  if (!changelog.includes(`## ${m.version}`)) bad(`CHANGELOG has no section for ${m.version}`);
  if (!new RegExp(`^\\| ${m.version.replace(/\./g, '\\.')} \\|`, 'm').test(readFileSync(join(ex, 'package', 'README.md'), 'utf8'))) bad(`README's compatibility table has no row for version ${m.version}`);
  for (const t of Object.values(m.exports).filter((v) => typeof v === 'string')) if (!existsSync(join(ex, 'package', t))) bad(`export ${t} is missing from the package`);
  if (m.dependencies && Object.keys(m.dependencies).length) bad(`runtime dependencies were added (${Object.keys(m.dependencies).join(', ')}); this package promises none`);
  ok(`manifest: version ${m.version}, dsh manifest 1, exports resolve, no runtime dependencies, changelog + README current`);

  // ---- 5. install the tarball into an empty project and use it from there ----
  const proj = join(work, 'project'); mkdirSync(proj);
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  execFileSync('npm', ['install', tgz, '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', '--loglevel=error'], { cwd: proj, stdio: 'pipe' });
  const installed = join(proj, 'node_modules', 'dsh-local-plugins');
  const probe = `
    const m = await import('dsh-local-plugins');
    if (m.name !== 'dsh-local-plugins' || typeof m.apply !== 'function' || !Array.isArray(m.inject)) throw new Error('server entry has the wrong shape');
    let captured; globalThis.window = { __ModuleLoader__: { load: (d) => { captured = d; } } };
    await import('dsh-local-plugins/client');
    if (!captured || captured.id !== 'dsh-local-plugins') throw new Error('client bundle did not register itself');
    const stub = new Proxy(function () {}, { get: (t, k) => (k === '__esModule' ? true : stub), apply: () => stub });
    const client = captured.factory(() => stub);
    if (client.name !== 'dsh-local-plugins' || typeof client.apply !== 'function') throw new Error('client module has the wrong shape');
    console.log('ok');`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: proj, encoding: 'utf8' }).trim();
  out === 'ok' ? ok('installed from the tarball: server entry and client bundle load and have the right shape') : bad(`probe printed ${out}`);

  // the undo script must work from the installed copy, on an empty dsh home
  const home = join(work, 'dshhome'); mkdirSync(join(home, 'local-plugins'), { recursive: true });
  writeFileSync(join(home, 'local-plugins', 'registry.json'), JSON.stringify({ version: 2, plugins: {} }));
  const undo = execFileSync(process.execPath, [join(installed, 'scripts', 'undo.mjs'), '--home', home, '--list'], { encoding: 'utf8' });
  /nothing is applied/.test(undo) ? ok('scripts/undo.mjs runs from the installed package') : bad(`undo.mjs --list printed: ${undo}`);

  // a v1 registry is migrated by the installed code, with a backup (smoke test of the shipped migration path)
  const reg1 = join(home, 'local-plugins', 'registry.json');
  writeFileSync(reg1, JSON.stringify({ version: 1, plugins: {} }));
  const mig = `const { loadRegistry, saveRegistry, CURRENT_VERSION } = await import('dsh-local-plugins/package.json', { with: { type: 'json' } }).then(() => import(${JSON.stringify(pathToFileURL(join(installed, 'lib', 'registry.js')).href)})); saveRegistry(${JSON.stringify(reg1)}, loadRegistry(${JSON.stringify(reg1)})); console.log(CURRENT_VERSION);`;
  const v = execFileSync(process.execPath, ['--input-type=module', '-e', mig], { cwd: proj, encoding: 'utf8' }).trim();
  (v === '2' && existsSync(`${reg1}.v1.bak`)) ? ok('the shipped registry code migrates v1 -> v2 and keeps the backup') : bad(`migration smoke test: version ${v}, backup ${existsSync(`${reg1}.v1.bak`)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `  ✖ ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('\npackage ok');
