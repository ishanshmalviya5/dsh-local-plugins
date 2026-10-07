// One interpretation of "what state is this plugin's repo in?".
// Everything that needs to know (the state endpoint, apply guards, rescue, recovery) asks here
// instead of re-deriving it with its own git commands.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git, out, revParse } from './git.js';

/**
 * @returns {Promise<null | {
 *   local: string|null, upstream: string|null, deployed: string|null,
 *   uncommitted: number, changedVsOriginal: number, notApplied: number|null,
 *   mergePending: boolean, conflicts: string[], updateAvailable: boolean, updateTarget: string|null,
 *   track: 'release'|'branch'|'tag'|'commit'|'npm'
 * }>}  null when the repo does not exist
 */
export async function inspectGit(env, p) {
  const dir = env.repoDir(p.name);
  if (!existsSync(join(dir, '.git'))) return null;
  const [local, upstream] = [await revParse(dir, 'local'), await revParse(dir, 'upstream')];
  const changed = await out(dir, ['diff', '--name-only', 'upstream']);
  const untracked = await out(dir, ['ls-files', '--others', '--exclude-standard']);
  const files = new Set([...changed.split('\n'), ...untracked.split('\n')].filter(Boolean));
  const uncommitted = (await out(dir, ['status', '--porcelain', '--untracked-files=all'])).split('\n').filter(Boolean).length;
  let notApplied = null;
  if (p.deployedSha && local) {
    const r = await git(dir, ['rev-list', '--count', `${p.deployedSha}..local`], { allowFail: true });
    notApplied = r.code === 0 ? Number(r.stdout.trim()) : null;
  }
  const track = p.source.type === 'npm' ? 'npm' : p.source.pin?.kind ?? (p.source.track === 'branch' ? 'branch' : 'release');
  return {
    local, upstream, deployed: p.deployedSha ?? null,
    uncommitted, changedVsOriginal: files.size, notApplied,
    mergePending: Boolean(p.pending), conflicts: p.pending?.conflicts ?? [],
    updateAvailable: Boolean(p.update?.available), updateTarget: p.update?.target ?? null,
    track,
  };
}

/** True when the working tree has anything uncommitted. */
export async function isDirty(env, name) {
  return (await out(env.repoDir(name), ['status', '--porcelain', '--untracked-files=all'])).length > 0;
}

export const localHead = (env, name) => revParse(env.repoDir(name), 'local');
