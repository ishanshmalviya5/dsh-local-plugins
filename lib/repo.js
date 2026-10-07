// Per-plugin git repo: `upstream` = pristine original, `local` = user edits.
// npm-origin repos get one commit on `upstream` per release ("npm <name>@<v>"),
// which turns "update from npm" into an ordinary merge.
import { mkdir, readdir, rm, appendFile, mkdtemp, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { git, out, revParse, commitAll, originDefaultBranch, remoteTags, latestReleaseTag } from './git.js';
import { npmExtract, compareVersions, assertGitLocation } from './sources.js';
import { run } from './run.js';

/** Keep dependency installs and the core node_modules link out of git. */
async function excludeLocalArtifacts(dir) {
  const commonDir = await out(dir, ['rev-parse', '--git-common-dir']);
  const infoDir = join(commonDir.startsWith('/') ? commonDir : join(dir, commonDir), 'info');
  await mkdir(infoDir, { recursive: true });
  await appendFile(join(infoDir, 'exclude'), '\n# dsh-local-plugins\nnode_modules\n');
}

/** Empty a worktree except `.git`. */
async function wipeTree(dir) {
  for (const entry of await readdir(dir)) {
    if (entry === '.git') continue;
    await rm(join(dir, entry), { recursive: true, force: true });
  }
}

/** New repo whose `upstream` holds npm `name@version`; `local` checked out on top. */
export async function createFromNpm(dir, name, version, log) {
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', 'upstream']);
  await excludeLocalArtifacts(dir);
  await npmExtract(name, version, dir, log);
  await commitAll(dir, `npm ${name}@${version}`, { force: true });
  await git(dir, ['checkout', '-q', '-b', 'local']);
  log?.(`created ${dir} from npm ${name}@${version}`);
}

/**
 * New repo cloned from git. `upstream` starts at the tag matching `version`
 * when one exists (so a migrated plugin starts where it was installed); with
 * no version, at the newest release tag; with neither, at the default branch tip.
 */
export async function createFromGit(dir, url, { version, log, ref = null } = {}) {
  assertGitLocation(url);
  await run('git', ['clone', '-q', '--', url, dir], { log, env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 10 * 60_000 });
  await excludeLocalArtifacts(dir);
  const branch = await originDefaultBranch(dir);
  let start = `origin/${branch}`;
  let pin = null;
  if (ref) {
    // an explicit choice is never reinterpreted: tag first, then branch, then commit; else a clear error
    if (await revParse(dir, `refs/tags/${ref}`)) { pin = { kind: 'tag', ref }; start = `refs/tags/${ref}`; }
    else if (await revParse(dir, `refs/remotes/origin/${ref}`)) { pin = { kind: 'branch', ref }; start = `refs/remotes/origin/${ref}`; }
    else if (/^[0-9a-f]{7,40}$/i.test(ref) && await revParse(dir, ref)) { pin = { kind: 'commit', ref: await revParse(dir, ref) }; start = pin.ref; }
    else throw Object.assign(new Error(`${url} has no tag, branch or commit named "${ref}"`), { status: 400, code: 'GIT_REF_NOT_FOUND' });
    log?.(`pinned to ${pin.kind} ${pin.ref}`);
  } else if (version) {
    const tags = await remoteTags(url);
    const tag = [`v${version}`, version].find((t) => tags.includes(t)) ?? tags.find((t) => t.endsWith(`@${version}`));
    if (tag) start = `refs/tags/${tag}`;
    log?.(tag ? `starting from tag ${tag}` : `no tag for ${version}; starting from ${branch}`);
  } else {
    // a plugin added from its git URL starts at its newest release, like an npm install would
    const release = await latestReleaseTag(dir, compareVersions);
    if (release) start = `refs/tags/${release.tag}`;
    log?.(release ? `starting from release ${release.tag}` : `no release tags; starting from ${branch}`);
  }
  await git(dir, ['checkout', '-q', '-B', 'upstream', start]);
  await git(dir, ['branch', '-q', '--unset-upstream'], { allowFail: true });
  await git(dir, ['checkout', '-q', '-b', 'local']);
  // keep the two-branch model: drop the clone's own copy of the default branch
  if (branch !== 'upstream' && branch !== 'local') await git(dir, ['branch', '-q', '-D', branch], { allowFail: true });
  return { branch, sha: await revParse(dir, 'upstream'), pin };
}

/**
 * Copy an installed package over `local` and commit it if it differs from
 * the pristine release — captures hand edits made in node_modules before
 * the plugin was migrated. Returns the commit sha or null.
 */
export async function overlayInstalled(dir, installedPath, log) {
  // Make `dir` an exact copy of the installed package, keeping its own .git and node_modules
  // (what `rsync -a --delete --exclude .git --exclude node_modules` did, without needing rsync).
  const skip = (p) => ['.git', 'node_modules'].includes(basename(p));
  for (const entry of await readdir(dir)) if (!skip(entry)) await rm(join(dir, entry), { recursive: true, force: true });
  await cp(installedPath, dir, { recursive: true, force: true, verbatimSymlinks: true, preserveTimestamps: true, filter: (src) => src === installedPath || !skip(src) });
  const sha = await commitAll(dir, 'pre-existing local edits (captured at migrate)', { force: true });
  log?.(sha ? 'captured pre-existing edits from the installed copy' : 'installed copy matches the release');
  return sha;
}

/** Record npm `name@version` as a new commit on `upstream` (no checkout of `local` touched). */
export async function commitNpmRelease(dir, name, version, log) {
  const tmp = await mkdtemp(join(tmpdir(), 'lpm-up-'));
  const wt = join(tmp, 'wt');
  await git(dir, ['worktree', 'add', '-q', wt, 'upstream']);
  try {
    await wipeTree(wt);
    await npmExtract(name, version, wt, log);
    const sha = await commitAll(wt, `npm ${name}@${version}`, { force: true });
    log?.(sha ? `upstream <- npm ${name}@${version}` : `npm ${name}@${version} identical to upstream`);
  } finally {
    await git(dir, ['worktree', 'remove', '--force', wt], { allowFail: true });
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function recentCommits(dir, limit = 20) {
  const s = await out(dir, ['log', '-n', String(limit), '--format=%H%x09%cI%x09%s', 'local']);
  return s ? s.split('\n').map((l) => { const [sha, date, subject] = l.split('\t'); return { sha, date, subject }; }) : [];
}

export { wipeTree };
