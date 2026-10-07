// HTTP surface for the web client: POST /local-plugins-api/<action> with a JSON
// body, answering { ok: true, value } or { ok: false, error }. Requests pass
// dsh's own Host/Origin fence and browser-cookie auth (connection.requestRejection).
import { restartHost } from './restart.js';

export const API = '/local-plugins-api';

const MAX_BODY = 1024 * 1024;

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(text ? JSON.parse(text) : {}); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/**
 * @param {{mgr:object, ops:object, env:object, port:()=>number, connection?:object, logger?:object}} deps
 */
export function createHandler({ mgr, ops, env, port, connection, logger }) {
  // Long-running mutations go through the single-flight ops queue.
  const background = {
    migrate: (b) => ['migrate', b.name, (log) => mgr.migrate(b, log)],
    add: (b) => ['add', b.input, (log) => mgr.addNew(b, log)],
    check: (b) => ['check', b.names?.join(', ') ?? 'all', (log) => mgr.checkUpdates(b, log)],
    update: (b) => ['update', b.name, (log) => mgr.update(b, log)],
    finish: (b) => ['finish update', b.name, (log) => mgr.finish(b, log)],
    abort: (b) => ['abort update', b.name, (log) => mgr.abort(b, log)],
    apply: (b) => ['apply', b.name, (log) => mgr.apply(b, log)],
    restore: (b) => ['restore original', b.name, (log) => mgr.restore(b, log)],
    commit: (b) => ['commit', b.name, (log) => mgr.commit(b, log)],
    trust: (b) => ['trust', b.name, (log) => mgr.setTrust(b, log)],
    setDep: (b) => ['dependency override', b.name, (log) => mgr.setDep(b, log)],
    reapplyAll: () => ['reapply all', null, (log) => mgr.reapplyAll(log)],
  };
  const direct = {
    state: () => mgr.state(ops),
    installed: () => mgr.installed(),
    commits: (b) => mgr.commits(b),
    agentDraft: (b) => mgr.agentDraft(b),
    op: (b) => ops.get(b.id),
    restart: () => {
      if (ops.busy()) throw Object.assign(new Error('an operation is still running'), { status: 409 });
      const p = port();
      setTimeout(() => {
        try { restartHost({ port: p, dshHome: env.dshHome }); } catch (err) { logger?.error?.('restart failed: %s', err.message); }
      }, 200);
      return { restarting: true, port: p };
    },
  };

  return async function handler(req, res) {
    let rejection;
    if (typeof connection?.requestRejection === 'function') {
      try { rejection = connection.requestRejection(req); } catch { rejection = 403; }
    }
    if (rejection !== undefined) return send(res, rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' });
    const action = new URL(req.url, 'http://x').pathname.slice(API.length + 1);
    if (req.method !== 'POST' || !(action in background || action in direct)) return send(res, 404, { ok: false, error: 'not found' });
    try {
      const body = await readBody(req);
      if (action in direct) return send(res, 200, { ok: true, value: await direct[action](body) });
      const [kind, target, fn] = background[action](body);
      const op = ops.start(kind, target, fn, { action, body });
      return send(res, 200, { ok: true, value: { opId: op.id } });
    } catch (err) {
      return send(res, err.status ?? 500, { ok: false, error: err.message });
    }
  };
}
