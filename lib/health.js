// Crash-loop protection for freshly applied code.
//
// After an Apply, the plugin is "on probation". The first boot afterwards starts a
// 60-second health timer; surviving it ends probation. If dsh starts AGAIN before the
// timer fired, without our clean-shutdown hook having run, the new code crashed dsh:
//
//   1. user's work is rescued (git stash + rescue branch; `local` is never rewritten)
//   2. core package -> the original dsh package comes back
//      profile      -> the newest upstream release that passes the load check goes live
//   3. if that fallback crashes too -> the plugin is taken out of dsh and marked disabled;
//      the card offers only "Work on it" until a new commit is applied.
//
// A manager that cannot load at all (dsh dies before plugins start) cannot run this;
// scripts/undo.mjs is the out-of-band answer for that case.
import { out, revParse } from './git.js';
import { deployCommit } from './deploy.js';
import { linkProfile, removeFromProfile, unlinkCore } from './link.js';
import { addNotice, rescueWork } from './recovery.js';

export const HEALTH_MS = () => Number(process.env.LPM_HEALTH_MS) || 60_000;

export function startProbation(p, sha, extra = {}) {
  p.probation = { sha, since: Date.now(), boots: 0, lastBootAt: null, cleanExit: false, ...extra };
}

/**
 * Called once per process start. Mutates `reg`; returns the plugins whose last
 * deployment looks like it crashed dsh, and the ones now being watched.
 */
export function noteBoot(reg, now = Date.now()) {
  const crashed = [];
  const watching = [];
  for (const p of Object.values(reg.plugins)) {
    const pr = p.probation;
    if (!pr || !p.applied) { if (pr) p.probation = null; continue; }
    if (pr.boots >= 1 && !pr.cleanExit && pr.lastBootAt && now - pr.lastBootAt < HEALTH_MS()) {
      crashed.push(p.name);
      continue;
    }
    pr.boots += 1;
    pr.lastBootAt = now;
    pr.cleanExit = false;
    watching.push(p.name);
  }
  return { crashed, watching };
}

/** The health timer fired: the code survived. */
export function markHealthy(reg, names) {
  let n = 0;
  for (const name of names) if (reg.plugins[name]?.probation) { reg.plugins[name].probation = null; n++; }
  return n;
}

/** Graceful shutdown: a restart the user asked for is not a crash. */
export function markCleanExit(reg) {
  for (const p of Object.values(reg.plugins)) if (p.probation) p.probation.cleanExit = true;
}

/**
 * Undo a deployment that crashed dsh. `ctx` supplies the manager's trust/retention helpers.
 * Mutates `p` and `reg`; the caller saves.
 */
export async function revertCrashed(env, reg, p, ctx, log) {
  const pr = p.probation;
  const crashedSha = pr?.sha ?? p.deployedSha;
  const localHead = await revParse(env.repoDir(p.name), 'local');
  const rescued = await rescueWork(env, p, { op: 'update' }, log);
  p.probation = null;
  let mode;
  let detail = '';

  if (p.kind === 'core') {
    await unlinkCore(env, p, log);
    p.applied = false;
    mode = 'original';
    detail = 'The original dsh package is back.';
  } else if (pr?.fallback) {
    await removeFromProfile(env, p, log);
    p.applied = false;
    p.disabled = true;
    mode = 'disabled';
    detail = 'The previous release crashed too, so the plugin was taken out of dsh.';
  } else {
    const candidates = (await out(env.repoDir(p.name), ['rev-list', '-n', '6', 'upstream'], { allowFail: true }).catch(() => '')).split('\n').filter(Boolean).filter((s) => s !== crashedSha);
    for (const sha of candidates) {
      try {
        await deployCommit(env, p, sha, log, { allowScripts: await ctx.trustHolds(p, log), keep: ctx.keep(reg), protect: new Set() });
        await linkProfile(env, p, log);
        p.applied = true;
        p.deployedSha = sha;
        startProbation(p, sha, { fallback: true });
        mode = 'fallback';
        detail = `Release ${sha.slice(0, 12)} (newest upstream version that passes the load check) is live instead.`;
        break;
      } catch (err) {
        log?.(`release ${sha.slice(0, 12)} is not usable: ${err.message.split('\n')[0]}`);
      }
    }
    if (!mode) {
      await removeFromProfile(env, p, log);
      p.applied = false;
      p.disabled = true;
      mode = 'disabled';
      detail = 'No earlier release passed the load check, so the plugin was taken out of dsh.';
    }
  }

  p.lastCrash = { sha: crashedSha, localHead, at: Date.now(), mode };
  reg.restartNeeded = true;
  addNotice(reg, {
    kind: 'crash-revert',
    plugin: p.name,
    mode,
    title: mode === 'disabled' ? `${p.name} was disabled because it crashed dsh` : `${p.name} crashed dsh and was reverted`,
    message: `${p.name} (${String(crashedSha).slice(0, 12)}) made dsh restart within ${Math.round(HEALTH_MS() / 1000)} s of being applied. ${detail} ${rescued ? `Your work is safe: ${rescued.summary}. ` : ''}Use "Work on it" to fix it with an agent, then Apply again.`,
    rescued,
  });
  return { mode, rescued };
}
