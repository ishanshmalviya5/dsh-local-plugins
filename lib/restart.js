// Restart the running dsh web: a detached helper waits for the port to free,
// then re-runs the exact command that started this process (same node flags,
// bin, profile, port, DSH_HOME). Adapted from dsh-pocket's lib/restart.js.
//
// Under launchd (KeepAlive) we only exit — launchd respawns the job, and a
// second manual launch would race it for the port.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export function portFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port' || a === '-p') return Number(args[i + 1]) || null;
    if (a.startsWith('--port=')) return Number(a.slice(7)) || null;
  }
  return null;
}

function helperCode({ file, args, cwd, logFile, port }) {
  return `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
function free(cb) { const s = net.connect(${port}, '127.0.0.1'); s.once('connect', () => { s.destroy(); cb(false); }); s.once('error', () => cb(true)); }
function wait(n) { free((ok) => { if (ok || n <= 0) launch(); else setTimeout(() => wait(n - 1), 200); }); }
function launch() {
  setTimeout(() => {
    try {
      const fd = fs.openSync(${JSON.stringify(logFile)}, 'a');
      spawn(${JSON.stringify(file)}, ${JSON.stringify(args)}, { cwd: ${JSON.stringify(cwd)}, detached: true, stdio: ['ignore', fd, fd], env: process.env }).unref();
    } catch (e) { try { fs.appendFileSync(${JSON.stringify(logFile)}, 'restart failed: ' + e.message + '\\n'); } catch {} }
  }, 300);
}
wait(100);
`;
}

/**
 * @param {{port:number, dshHome:string}} opts
 * @returns {{mode:'launchd'|'respawn', logFile?:string}}
 */
export function restartHost({ port, dshHome }) {
  const underLaunchd = Boolean(process.env.XPC_SERVICE_NAME && process.env.XPC_SERVICE_NAME !== '0' && process.ppid === 1);
  if (underLaunchd) {
    setTimeout(() => process.exit(0), 300);
    return { mode: 'launchd' };
  }
  const args = [...process.execArgv, process.argv[1], ...process.argv.slice(2)];
  if (!args.some((a) => a === '--no-open')) args.push('--no-open');
  const logDir = join(dshHome, 'logs');
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `dsh-web-restart-${port}.log`);
  const helper = spawn(process.execPath, ['-e', helperCode({ file: process.execPath, args, cwd: process.cwd(), logFile, port })], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  helper.on('error', () => {});
  helper.unref();
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
  return { mode: 'respawn', logFile };
}
