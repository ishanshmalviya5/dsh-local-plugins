// Child-process helper shared by git, npm, build and dsh CLI calls.
//
// - every child runs in its own process group, so a timeout stops the WHOLE tree
// - timeout: SIGTERM, a grace period, then SIGKILL; the result says it was a timeout
// - exit code AND signal are reported; stdout/stderr are kept (capped, tail preserved)
// - output lines are redacted before they reach logs; error text is redacted too
// - children still running when this process exits are killed, never orphaned
import { spawn } from 'node:child_process';
import { redact } from './redact.js';

const MAX_BUFFER = 8 * 1024 * 1024; // per stream; the newest output is what diagnoses a failure

export class RunError extends Error {
  constructor(message, result) {
    super(message);
    this.result = result;
    this.code = result?.timedOut ? 'COMMAND_TIMEOUT' : 'COMMAND_FAILED';
    this.timedOut = Boolean(result?.timedOut);
    this.exitCode = result?.code ?? null;
    this.signal = result?.signal ?? null;
  }
}

const live = new Set();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const child of live) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
  });
}

/** Append `chunk` to `buf`, dropping the oldest text beyond MAX_BUFFER. */
function append(state, key, chunk) {
  state[key] += chunk;
  if (state[key].length > MAX_BUFFER) { state[key] = state[key].slice(-MAX_BUFFER); state.truncated = true; }
}

/**
 * Run one command to completion, streaming each output line to `log`.
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd?:string, env?:object, log?:(line:string)=>void, allowFail?:boolean, timeoutMs?:number, killGraceMs?:number, input?:string}} [opts]
 * @returns {Promise<{code:number|null, signal:string|null, timedOut:boolean, truncated:boolean, stdout:string, stderr:string}>}
 */
export function run(file, args, opts = {}) {
  const { cwd, env, log, allowFail = false, timeoutMs = 10 * 60 * 1000, killGraceMs = 5000, input } = opts;
  installExitHook();
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: true, // own process group, so a timeout can stop the whole tree
    });
    live.add(child);
    const state = { stdout: '', stderr: '', truncated: false };
    const pending = { out: '', err: '' };
    let timedOut = false;
    const feed = (key, chunk) => {
      const text = String(chunk);
      append(state, key === 'out' ? 'stdout' : 'stderr', text);
      if (!log) return;
      pending[key] += text;
      const lines = pending[key].split(/\r?\n/);
      pending[key] = lines.pop();
      if (pending[key].length > 64 * 1024) { lines.push(pending[key]); pending[key] = ''; } // a line without a newline must not grow forever
      for (const line of lines) if (line.trim()) log(redact(line));
    };
    child.stdout.on('data', (c) => feed('out', c));
    child.stderr.on('data', (c) => feed('err', c));
    if (input !== undefined) child.stdin.end(input);

    const killTree = (signal) => {
      try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
    };
    let hardKill;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      hardKill = setTimeout(() => killTree('SIGKILL'), killGraceMs);
    }, timeoutMs);
    const settle = () => { clearTimeout(timer); clearTimeout(hardKill); live.delete(child); };

    child.once('error', (err) => {
      settle();
      reject(new RunError(redact(`${file}: ${err.message}`), { code: null, signal: null, timedOut: false, truncated: state.truncated, stdout: state.stdout, stderr: state.stderr }));
    });
    child.once('close', (code, signal) => {
      settle();
      killTree('SIGKILL'); // sweep stragglers left in the group (no-op when it is empty)
      if (log) for (const rest of [pending.out, pending.err]) if (rest.trim()) log(redact(rest));
      const result = { code, signal: signal ?? null, timedOut, truncated: state.truncated, stdout: state.stdout, stderr: state.stderr };
      if ((code !== 0 || timedOut) && !allowFail) {
        const tail = (state.stderr.trim() || state.stdout.trim()).split('\n').slice(-8).join('\n');
        const why = timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : signal ? `was killed by ${signal}` : `exited ${code}`;
        reject(new RunError(redact(`${file} ${args.join(' ')} ${why}${tail ? `\n${tail}` : ''}`), result));
        return;
      }
      resolve(result);
    });
  });
}
