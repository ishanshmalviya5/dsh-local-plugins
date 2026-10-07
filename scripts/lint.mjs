#!/usr/bin/env node
// Built-in checks (no dependencies): everything parses, nothing leaks, the bundle is current.
//   npm run lint
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const warnings = [];
const fail = (file, msg) => problems.push(`${relative(root, file) || file}: ${msg}`);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dsh-local-plugins-public', '.playwright-mcp', 'conversation']);
const SKIP_FILES = new Set(['RELEASE-HANDOFF.md', 'package-lock.json', 'api-results.json']);
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.DS_Store')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out); else if (!SKIP_FILES.has(name)) out.push(p);
  }
  return out;
}

const files = ['lib', 'scripts', 'client', 'test', 'docs'].filter((d) => existsSync(join(root, d))).flatMap((d) => walk(join(root, d)))
  .concat(['package.json', 'README.md', 'CHANGELOG.md', 'cordis.patch.yml', 'LICENSE'].map((f) => join(root, f)).filter(existsSync));
const isCode = (f) => /\.(m?js|cjs|jsx)$/.test(f);
const isText = (f) => /\.(m?js|cjs|jsx|json|md|ya?ml|sh)$/.test(f) || /LICENSE$/.test(f);
const GENERATED = new Set([join(root, 'client', 'client.js')]);

// 1. every JS file parses (syntax only; nothing is executed)
for (const f of files.filter((x) => /\.(m?js|cjs)$/.test(x) && !x.endsWith('.jsx'))) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { fail(f, `does not parse: ${String(e.stderr).split('\n').find((l) => /Error/.test(l)) ?? 'syntax error'}`); }
}

// 2. hygiene on hand-written text files
for (const f of files.filter(isText)) {
  if (GENERATED.has(f)) continue;
  const text = readFileSync(f, 'utf8');
  if (/\r\n/.test(text)) fail(f, 'has CRLF line endings');
  if (text.length && !text.endsWith('\n')) fail(f, 'does not end with a newline');
  if (/^<{7}( |$)|^>{7}( |$)/m.test(text) && !/test\//.test(relative(root, f))) fail(f, 'contains merge-conflict markers');
  text.split('\n').forEach((line, i) => {
    if (/[ \t]+$/.test(line) && !f.endsWith('.md')) fail(f, `line ${i + 1} has trailing whitespace`);
    if (/\t/.test(line) && isCode(f)) fail(f, `line ${i + 1} contains a tab`);
  });
}

// 3. library code: no debugger/console.log left behind, no focused tests
for (const f of files.filter((x) => x.startsWith(join(root, 'lib')) && isCode(x))) {
  const text = readFileSync(f, 'utf8');
  if (/\bdebugger\b/.test(text)) fail(f, 'contains a debugger statement');
  if (/console\.(log|debug)\(/.test(text) && !f.endsWith('index.js')) fail(f, 'uses console.log (use the logger or the operation log)');
}
for (const f of files.filter((x) => x.startsWith(join(root, 'test')) && /\.test\.js$/.test(x))) {
  if (/\b(test|describe|it)\.only\(/.test(readFileSync(f, 'utf8'))) fail(f, 'contains a focused test (.only)');
}

// 4. the committed client bundle is exactly what the source builds to
try {
  execFileSync(process.execPath, [join(root, 'client', 'build.mjs'), '--check'], { stdio: 'pipe' });
} catch (e) { problems.push(`client/client.js: ${String(e.stderr || e.stdout).trim() || 'bundle check failed'}`); }

// 5. package.json is self-consistent
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version)) fail(join(root, 'package.json'), `version "${pkg.version}" is not semver`);
const exportTargets = Object.values(pkg.exports ?? {}).filter((v) => typeof v === 'string');
for (const t of [...exportTargets, pkg.main].filter(Boolean)) if (!existsSync(join(root, t))) fail(join(root, 'package.json'), `points at ${t}, which does not exist`);
for (const entry of pkg.files ?? []) if (!entry.includes('*') && !existsSync(join(root, entry))) fail(join(root, 'package.json'), `"files" lists ${entry}, which does not exist`);
for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
  const m = /^node (\S+\.m?js)/.exec(cmd);
  if (m && !existsSync(join(root, m[1]))) fail(join(root, 'package.json'), `script "${name}" runs ${m[1]}, which does not exist`);
}
if (existsSync(join(root, 'CHANGELOG.md')) && !readFileSync(join(root, 'CHANGELOG.md'), 'utf8').includes(`## ${pkg.version}`)) fail(join(root, 'CHANGELOG.md'), `has no "## ${pkg.version}" section`);

for (const w of warnings) console.warn(`warning: ${w}`);
if (problems.length) {
  console.error(`${problems.length} problem(s):\n${problems.map((p) => `  ✖ ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`lint ok — ${files.length} files checked`);
