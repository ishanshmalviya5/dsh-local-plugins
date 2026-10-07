// Thin git wrappers. Every call pins identity, disables signing and hooks so a
// commit made by the manager never blocks on the user's global git config.
import { run } from './run.js';

const BASE = [
  '-c', 'user.name=dsh-local-plugins',
  '-c', 'user.email=local-plugins@dsh.local',
  '-c', 'commit.gpgsign=false',
  '-c', 'tag.gpgsign=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'advice.detachedHead=false',
  '-c', 'init.defaultBranch=upstream',
];

export function git(dir, args, opts = {}) {
  return run('git', [...BASE, '-C', dir, ...args], { ...opts, env: { GIT_TERMINAL_PROMPT: '0', ...opts.env } });
}

export async function out(dir, args, opts) {
  return (await git(dir, args, opts)).stdout.trim();
}

export async function revParse(dir, ref) {
  const r = await git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function isAncestor(dir, a, b) {
  const r = await git(dir, ['merge-base', '--is-ancestor', a, b], { allowFail: true });
  return r.code === 0;
}

/** Porcelain status lines of the working tree (empty = clean). */
export async function statusLines(dir) {
  const s = await out(dir, ['status', '--porcelain', '--untracked-files=all']);
  return s ? s.split('\n') : [];
}

/** Commit everything in the working tree; returns the new sha or null when clean. */
export async function commitAll(dir, message, { force = false } = {}) {
  await git(dir, ['add', '-A', ...(force ? ['--force'] : []), '.']);
  const staged = await git(dir, ['diff', '--cached', '--quiet'], { allowFail: true });
  if (staged.code === 0) return null;
  await git(dir, ['commit', '-q', '-m', message]);
  return revParse(dir, 'HEAD');
}

export async function conflictedFiles(dir) {
  const s = await out(dir, ['diff', '--name-only', '--diff-filter=U']);
  return s ? s.split('\n') : [];
}

/** Files that still contain conflict markers (guards "Finish update"). */
export async function filesWithMarkers(dir) {
  const r = await git(dir, ['grep', '-l', '-I', '-E', '^(<<<<<<<|>>>>>>>)( |$)'], { allowFail: true });
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim().split('\n') : [];
}

export async function lsRemoteOk(url) {
  if (typeof url !== 'string' || url.startsWith('-')) return false;
  const r = await run('git', ['ls-remote', '--heads', '--', url], { allowFail: true, timeoutMs: 30_000, env: { GIT_TERMINAL_PROMPT: '0' } });
  return r.code === 0;
}

export async function remoteTags(url) {
  if (typeof url !== 'string' || url.startsWith('-')) return [];
  const r = await run('git', ['ls-remote', '--tags', '--', url], { allowFail: true, timeoutMs: 30_000, env: { GIT_TERMINAL_PROMPT: '0' } });
  if (r.code !== 0) return [];
  return r.stdout.split('\n').map((l) => l.split('\t')[1]).filter(Boolean)
    .map((ref) => ref.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, ''));
}

/** Default branch of `origin` in a clone. */
export async function originDefaultBranch(dir) {
  const r = await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (r.code === 0) return r.stdout.trim().replace(/^origin\//, '');
  for (const b of ['main', 'master']) if (await revParse(dir, `origin/${b}`)) return b;
  return 'main';
}

const RELEASE_TAG = /^(?:.+@)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/**
 * Newest release tag in a clone (`v1.2.3`, `1.2.3`, `name@1.2.3`): the highest
 * stable version, or the highest pre-release when no stable one exists.
 * @returns {Promise<{tag:string, version:string}|null>} null when no tag looks like a release
 */
export async function latestReleaseTag(dir, compare) {
  const list = (await out(dir, ['tag', '-l'])).split('\n').filter(Boolean);
  const releases = list.map((tag) => ({ tag, version: RELEASE_TAG.exec(tag)?.[1] })).filter((r) => r.version);
  if (!releases.length) return null;
  const stable = releases.filter((r) => !r.version.includes('-'));
  const pool = stable.length ? stable : releases;
  return pool.reduce((best, r) => (compare(r.version, best.version) > 0 ? r : best));
}
