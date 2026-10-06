// Child-process helper shared by git, npm, build and dsh CLI calls.
import { spawn } from 'node:child_process';

export class RunError extends Error {
  constructor(message, result) {
    super(message);
    this.result = result;
  }
}

/**
 * Run one command to completion, streaming each output line to `log`.
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd?:string, env?:object, log?:(line:string)=>void, allowFail?:boolean, timeoutMs?:number, input?:string}} [opts]
 * @returns {Promise<{code:number|null, stdout:string, stderr:string}>}
 */
export function run(file, args, opts = {}) {
  const { cwd, env, log, allowFail = false, timeoutMs = 10 * 60 * 1000, input } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const pending = { out: '', err: '' };
    const feed = (key, chunk) => {
      const text = String(chunk);
      if (key === 'out') stdout += text; else stderr += text;
      if (!log) return;
      pending[key] += text;
      const lines = pending[key].split(/\r?\n/);
      pending[key] = lines.pop();
      for (const line of lines) if (line.trim()) log(line);
    };
    child.stdout.on('data', (c) => feed('out', c));
    child.stderr.on('data', (c) => feed('err', c));
    if (input !== undefined) child.stdin.end(input);
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(new RunError(`${file}: ${err.message}`, { code: null, stdout, stderr }));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (log) for (const rest of [pending.out, pending.err]) if (rest.trim()) log(rest);
      const result = { code, stdout, stderr };
      if (code !== 0 && !allowFail) {
        const tail = (stderr.trim() || stdout.trim()).split('\n').slice(-8).join('\n');
        reject(new RunError(`${file} ${args.join(' ')} exited ${code}${tail ? `\n${tail}` : ''}`, result));
        return;
      }
      resolve(result);
    });
  });
}
