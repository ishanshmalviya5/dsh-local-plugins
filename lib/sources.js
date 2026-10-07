// Origins a local plugin can pull from: npm releases or a git repository.
//
// Test hook: when LPM_NPM_FIXTURES points at a directory containing
// `<safeName>/<version>.tgz`, those tarballs stand in for the npm registry
// for that package (used by the isolated e2e environment's fake plugins).
import { mkdtemp, readdir, rm, cp, mkdir, lstat, readlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import { run } from './run.js';
import { safeName } from './env.js';
import { redact } from './redact.js';

const NPM_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;

/** Reject anything that is not a plain npm package name (blocks `-option` smuggling). */
export function assertPackageName(name) {
  if (typeof name !== 'string' || !NPM_NAME.test(name) || name.length > 214) throw Object.assign(new Error(`not a valid npm package name: ${JSON.stringify(String(name).slice(0, 80))}`), { status: 400, code: 'INVALID_INPUT' });
  return name;
}

/** A version / range / tag must not look like a command-line option. */
export function assertSpec(spec) {
  if (typeof spec !== 'string' || !spec.trim() || spec.startsWith('-') || /\s/.test(spec)) throw Object.assign(new Error(`not a valid version or range: ${JSON.stringify(String(spec).slice(0, 80))}`), { status: 400 });
  return spec;
}

/** A git location must not look like a command-line option. */
export function assertGitLocation(url) {
  if (typeof url !== 'string' || !url.trim() || url.startsWith('-')) throw Object.assign(new Error('not a valid git location'), { status: 400 });
  return url;
}

/** Semver-ish compare (numeric core, prerelease sorts before release). */
export function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre = ''] = String(v).replace(/^v/i, '').split('-', 2);
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const xa = x.pre.split('.');
  const ya = y.pre.split('.');
  for (let i = 0; i < Math.max(xa.length, ya.length); i++) {
    const p = xa[i] ?? '';
    const q = ya[i] ?? '';
    if (p === q) continue;
    if (/^\d+$/.test(p) && /^\d+$/.test(q)) return Number(p) - Number(q);
    return p < q ? -1 : 1;
  }
  return 0;
}

function fixtureDir(name) {
  const base = process.env.LPM_NPM_FIXTURES;
  if (!base) return null;
  const dir = join(base, safeName(name));
  return existsSync(dir) ? dir : null;
}

export function isFixture(name) {
  return fixtureDir(name) !== null;
}

async function fixtureVersions(dir) {
  return (await readdir(dir)).filter((f) => f.endsWith('.tgz')).map((f) => f.slice(0, -4)).sort(compareVersions);
}

export function fixtureTarball(name, version) {
  const dir = fixtureDir(name);
  return dir ? join(dir, `${version}.tgz`) : null;
}

const npmErr = (code, message) => Object.assign(new Error(message), { code, status: 502 });

/** Turn a failed `npm view` into something a person can act on. */
function explainNpmFailure(name, spec, err) {
  const text = `${err?.result?.stderr ?? ''}\n${err?.result?.stdout ?? ''}\n${err?.message ?? ''}`;
  if (/E404|404 Not Found|is not in this registry/i.test(text)) return npmErr('NPM_PACKAGE_NOT_FOUND', `${name} is not on npm (it may have been removed or renamed). Your local copy is unchanged.`);
  if (/ETARGET|No matching version|notarget/i.test(text)) return npmErr('NPM_VERSION_NOT_FOUND', `npm has no version of ${name} matching "${spec}". Your local copy is unchanged.`);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|timed out/i.test(text)) return npmErr('NPM_UNREACHABLE', `cannot reach npm to look up ${name}. Check your connection and try again; nothing was changed.`);
  if (/E401|E403|unauthorized|forbidden/i.test(text)) return npmErr('NPM_ACCESS_DENIED', `npm refused access to ${name} (login or permissions). Nothing was changed.`);
  return npmErr('NPM_LOOKUP_FAILED', `looking up ${name}@${spec} on npm failed: ${redact(String(err?.message ?? err).split('\n')[0])}`);
}

/**
 * Newest published version satisfying `spec` (a version, a range or a dist-tag).
 * Test hooks: LPM_NPM_FIXTURES (tarballs stand in for the registry) and
 * LPM_NPM_OFFLINE=1 (a package without fixtures is "not on npm" instead of a network call).
 */
export async function npmVersion(name, spec = 'latest', log) {
  assertPackageName(name);
  assertSpec(spec);
  const fx = fixtureDir(name);
  if (fx) {
    const versions = await fixtureVersions(fx);
    if (!versions.length) throw new Error(`no fixture tarballs for ${name}`);
    if (spec === 'latest') return versions.at(-1);
    if (versions.includes(spec)) return spec;
    throw npmErr('NPM_VERSION_NOT_FOUND', `npm has no version of ${name} matching "${spec}". Your local copy is unchanged.`);
  }
  if (process.env.LPM_NPM_OFFLINE === '1') throw npmErr('NPM_PACKAGE_NOT_FOUND', `${name} is not on npm (it may have been removed or renamed). Your local copy is unchanged.`);
  let r;
  try {
    r = await run('npm', ['view', `${name}@${spec}`, 'version', '--json'], { log, timeoutMs: 60_000 });
  } catch (err) { throw explainNpmFailure(name, spec, err); }
  let parsed;
  try { parsed = JSON.parse(r.stdout.trim() || 'null'); } catch { throw npmErr('NPM_BAD_METADATA', `npm returned unreadable metadata for ${name}@${spec}; nothing was changed.`); }
  const v = Array.isArray(parsed) ? parsed.at(-1) : parsed;
  if (typeof v !== 'string' || !v) throw npmErr('NPM_VERSION_NOT_FOUND', `npm has no version of ${name} matching "${spec}". Your local copy is unchanged.`);
  return v;
}

/** `name`, `name@1.2.3`, `name@beta`, `@scope/name@^1` -> { name, spec } (spec null when absent). */
export function parseNpmInput(input) {
  const s = String(input ?? '').trim();
  const at = s.lastIndexOf('@');
  if (at <= 0) return { name: s, spec: null };
  const name = s.slice(0, at);
  const spec = s.slice(at + 1);
  return { name, spec: spec || null };
}

const EXACT = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const isExactVersion = (spec) => typeof spec === 'string' && EXACT.test(spec);

/**
 * Check what an extracted/cloned package declares. Returns { name, version, warnings }.
 * Throws INCOMPATIBLE_MANIFEST when the plugin asks for a manifest version this manager
 * does not understand, and BAD_PACKAGE when package.json is unusable.
 */
export function inspectPackage(dir, { expectName } = {}) {
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch (err) { throw Object.assign(new Error(`the package has no readable package.json (${err.code === 'ENOENT' ? 'missing' : 'invalid JSON'})`), { status: 400, code: 'BAD_PACKAGE' }); }
  if (!pkg || typeof pkg !== 'object' || typeof pkg.name !== 'string') throw Object.assign(new Error('the package.json has no "name"'), { status: 400, code: 'BAD_PACKAGE' });
  const warnings = [];
  if (expectName && pkg.name !== expectName) throw Object.assign(new Error(`the package is named "${pkg.name}", not "${expectName}" (renamed upstream?)`), { status: 409, code: 'PACKAGE_RENAMED', details: { from: expectName, to: pkg.name } });
  if (pkg.dsh === undefined) warnings.push('package.json has no "dsh" manifest, so dsh may not recognise it as a plugin');
  else if (pkg.dsh === null || typeof pkg.dsh !== 'object') warnings.push('the "dsh" field in package.json is not an object');
  else if (pkg.dsh.manifestVersion !== undefined && pkg.dsh.manifestVersion !== 1) throw Object.assign(new Error(`this plugin uses dsh manifest version ${JSON.stringify(pkg.dsh.manifestVersion)}, which this version of dsh-local-plugins does not understand (it supports 1). Nothing was changed.`), { status: 409, code: 'INCOMPATIBLE_MANIFEST' });
  return { name: pkg.name, version: typeof pkg.version === 'string' ? pkg.version : null, warnings };
}

/** npm account that published `name@version` (null when unknown, or for test fixtures). */
export async function npmPublisher(name, version) {
  if (fixtureDir(name)) return null;
  assertPackageName(name);
  assertSpec(version);
  const r = await run('npm', ['view', `${name}@${version}`, '_npmUser.name', '--json'], { allowFail: true, timeoutMs: 60_000 });
  if (r.code !== 0) return null;
  try { const v = JSON.parse(r.stdout.trim() || 'null'); return typeof v === 'string' ? v : Array.isArray(v) ? v.at(-1) ?? null : null; } catch { return null; }
}

/**
 * Refuse tarballs that could write or point outside their own folder:
 * absolute or `..` entry names, symlinks that resolve outside, device/fifo/socket files.
 */
export async function assertSafeTree(root) {
  const base = resolve(root);
  const inside = (p) => p === base || p.startsWith(base + sep);
  const walk = async (dir) => {
    for (const name of await readdir(dir)) {
      const p = join(dir, name);
      const st = await lstat(p);
      if (st.isSymbolicLink()) {
        const target = resolve(dirname(p), await readlink(p));
        if (!inside(target)) throw Object.assign(new Error(`the package contains a symlink (${p.slice(base.length + 1)}) that points outside itself — refusing to extract it`), { status: 400, code: 'UNSAFE_ARCHIVE' });
      } else if (st.isDirectory()) await walk(p);
      else if (!st.isFile()) throw Object.assign(new Error(`the package contains a special file (${p.slice(base.length + 1)}) — refusing to extract it`), { status: 400, code: 'UNSAFE_ARCHIVE' });
    }
  };
  await walk(base);
}

/** Entry names in a tarball that would escape the extraction folder. */
export function unsafeEntryNames(listing) {
  return listing.split('\n').filter(Boolean).filter((n) => n.startsWith('/') || n.split('/').includes('..'));
}

/**
 * Extract `name@version` from npm into `dest` (its contents, not a `package/` dir).
 * `dest` must exist; files are added on top of whatever is there.
 */
export async function npmExtract(name, version, dest, log) {
  assertPackageName(name);
  assertSpec(version);
  const tmp = await mkdtemp(join(tmpdir(), 'lpm-pack-'));
  try {
    let tgz = fixtureTarball(name, version);
    if (!tgz || !existsSync(tgz)) {
      log?.(`npm pack ${name}@${version}`);
      const r = await run('npm', ['pack', `${name}@${version}`, '--json', '--pack-destination', tmp], { cwd: tmp, timeoutMs: 5 * 60_000 });
      const info = JSON.parse(r.stdout);
      tgz = join(tmp, (Array.isArray(info) ? info[0] : info).filename);
    }
    const ex = join(tmp, 'x');
    await mkdir(ex);
    const listing = (await run('tar', ['-tzf', tgz])).stdout;
    const bad = unsafeEntryNames(listing);
    if (bad.length) throw Object.assign(new Error(`the package contains entries that escape its folder (${bad.slice(0, 3).join(', ')}) — refusing to extract it`), { status: 400, code: 'UNSAFE_ARCHIVE' });
    await run('tar', ['-xzf', tgz, '-C', ex, '--no-same-owner']);
    await assertSafeTree(ex);
    // npm tarballs wrap content in one top-level dir (usually `package/`).
    const tops = await readdir(ex);
    const inner = tops.length === 1 ? join(ex, tops[0]) : ex;
    await cp(inner, dest, { recursive: true, force: true });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Normalize package.json `repository` / user input into a clonable URL.
 * Returns null for things that are not git locations.
 */
export function gitUrl(input) {
  if (!input) return null;
  let s = typeof input === 'string' ? input : input.url;
  if (!s) return null;
  s = s.trim();
  if (/^(github|gitlab|bitbucket):/.test(s)) {
    const [host, path] = s.split(':');
    return `https://${host}.${host === 'bitbucket' ? 'org' : 'com'}/${path.replace(/\.git$/, '')}.git`;
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://github.com/${s.replace(/\.git$/, '')}.git`;
  s = s.replace(/^git\+/, '');
  if (/^git:\/\/github\.com\//.test(s)) s = s.replace(/^git:/, 'https:');
  if (/^(https?|ssh|git|file):\/\//.test(s) || /^git@[^:]+:/.test(s) || s.startsWith('/')) return s;
  return null;
}

/**
 * Split `location#ref` (ref = tag, branch or commit). The ref is validated so it can never
 * look like an option or contain spaces/shell characters.
 */
export function parseGitInput(input) {
  const s = String(input ?? '').trim();
  const i = s.lastIndexOf('#');
  if (i <= 0) return { location: s, ref: null };
  const ref = s.slice(i + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,199}$/.test(ref)) throw Object.assign(new Error(`"${ref.slice(0, 40)}" is not a valid tag, branch or commit name`), { status: 400, code: 'INVALID_INPUT' });
  return { location: s.slice(0, i), ref };
}

/** True when user input in "Add new" names a git location rather than an npm package. */
export function looksLikeGit(input) {
  const s = input.trim();
  return /^(https?|ssh|git|file):\/\//.test(s) || /^git@/.test(s) || /^(github|gitlab|bitbucket):/.test(s) || s.startsWith('/') || s.endsWith('.git');
}
