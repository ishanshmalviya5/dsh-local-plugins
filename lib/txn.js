// Transaction journal + fault injection.
//
// Every mutation that touches the live install (apply, restore, reapply, core links)
// writes $root/.txn/<id>.json before it starts, advances `phase` after each durable
// step, and deletes the file when it is fully done. A file that is still there at the
// next boot means the process died mid-operation, and recovery knows exactly how far it got.
//
// Fault injection (tests only): LPM_FAIL_AT=<phase>        -> that step throws, cleanup runs
//                               LPM_FAIL_AT=<phase>:crash  -> that step "kills the process":
//                                                             the error is flagged `crash` so no
//                                                             cleanup or registry save runs.
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export class InjectedFault extends Error {
  constructor(stage, crash) {
    super(`injected ${crash ? 'crash' : 'failure'} at "${stage}"`);
    this.stage = stage;
    this.crash = crash;
  }
}

/** Throw if LPM_FAIL_AT names this stage. Free when the variable is unset. */
export function faultPoint(stage) {
  const spec = process.env.LPM_FAIL_AT;
  if (!spec) return;
  const [at, mode] = spec.split(':');
  if (at === stage) throw new InjectedFault(stage, mode === 'crash');
}

/** A simulated crash must leave everything exactly as it is at that instant. */
export const isCrash = (err) => err instanceof InjectedFault && err.crash;

function file(env, id) {
  return join(env.txnDir, `${id}.json`);
}

function write(env, txn) {
  mkdirSync(env.txnDir, { recursive: true, mode: 0o700 });
  const tmp = `${file(env, txn.id)}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(txn, null, 2), { mode: 0o600 });
  const fd = openSync(tmp, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file(env, txn.id));
}

/** Start a journal entry. `data` records what recovery will need (previous stable target, core paths…). */
export function beginTxn(env, op, plugin, data = {}) {
  const txn = { id: `${Date.now()}-${randomBytes(4).toString('hex')}`, op, plugin, pid: process.pid, startedAt: Date.now(), phase: 'begin', ...data };
  write(env, txn);
  return txn;
}

/** Record that a step is durably done, then give fault injection a chance to fire. */
export function phase(env, txn, name, extra = {}) {
  txn.phase = name;
  Object.assign(txn, extra);
  write(env, txn);
  faultPoint(name);
}

export function endTxn(env, txn) {
  rmSync(file(env, txn.id), { force: true });
}

/** Journal entries left behind (unreadable ones are reported, never deleted). */
export function listTxns(env) {
  let names = [];
  try { names = readdirSync(env.txnDir).filter((n) => n.endsWith('.json')); } catch { return []; }
  return names.map((n) => {
    try { return { ...JSON.parse(readFileSync(join(env.txnDir, n), 'utf8')), file: join(env.txnDir, n) }; } catch (err) { return { id: n, corrupt: true, error: err.message, file: join(env.txnDir, n) }; }
  });
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/**
 * Run `fn(txn)` inside a journal entry. On success or an ordinary error the entry
 * is closed; on a simulated crash it is deliberately left behind, like a real one.
 */
export async function withTxn(env, op, plugin, data, fn) {
  const txn = beginTxn(env, op, plugin, data);
  try {
    const result = await fn(txn);
    endTxn(env, txn);
    return result;
  } catch (err) {
    if (!isCrash(err)) endTxn(env, txn);
    throw err;
  }
}
