// HTTP surface for the web client: POST /local-plugins-api/<action> with a JSON
// body, answering { ok: true, value } or { ok: false, error: { code, message, details } }.
// Requests pass dsh's own Host/Origin fence and browser-cookie auth
// (connection.requestRejection); without that check available nothing is served.
// Full contract: docs/api.md.
import { restartHost } from './restart.js';

export const API = '/local-plugins-api';

const MAX_BODY = 1024 * 1024;

/** Bumped when a request or response shape changes incompatibly; the client compares it. */
export const API_VERSION = 2;

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

const DEFAULT_CODE = { 400: 'INVALID_INPUT', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 409: 'CONFLICT', 413: 'BODY_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 503: 'UNAVAILABLE' };

/** One error shape for every route. Internal details (stack traces, paths of other users) are not exposed. */
export function errorBody(err, fallbackStatus = 500) {
  const status = err?.status ?? fallbackStatus;
  const code = err?.code && /^[A-Z][A-Z0-9_]+$/.test(String(err.code)) ? err.code : (DEFAULT_CODE[status] ?? 'INTERNAL_ERROR');
  const details = { ...(err?.details ?? {}), ...(err?.needsTrust ? { needsTrust: err.needsTrust } : {}) };
  return { status, body: { ok: false, error: { code, message: err?.message ?? String(err), details } } };
}

function sendError(res, err, fallbackStatus) {
  const { status, body } = errorBody(err, fallbackStatus);
  send(res, status, body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('the request body is larger than 1 MB'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = text ? JSON.parse(text) : {};
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        resolve(parsed);
      } catch { reject(Object.assign(new Error('the request body must be a JSON object'), { status: 400 })); }
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
    delete: (b) => ['delete', b.name, (log) => mgr.deletePlugin(b, log)],
    cleanup: (b) => ['cleanup', null, (log) => mgr.cleanup(b, log)],
    repair: () => ['repair installation', null, (log) => mgr.repair(log)],
    reapplyAll: () => ['reapply all', null, (log) => mgr.reapplyAll(log)],
  };
  const direct = {
    state: () => mgr.state(ops),
    installed: () => mgr.installed(),
    dismissNotice: (b) => mgr.dismissNotice(b),
    diskUsage: () => mgr.diskUsage(),
    setSettings: (b) => mgr.setSettings(b),
    cleanupPreview: () => mgr.cleanup({ execute: false }, () => {}),
    history: () => ({ operations: ops.history() }),
    commits: (b) => mgr.commits(b),
    agentDraft: (b) => mgr.agentDraft(b),
    op: (b) => ops.get(b.id),
    restart: () => {
      if (ops.busy()) throw Object.assign(new Error('An operation is still running. Wait for it to finish before restarting; nothing was restarted.'), { status: 409, code: 'BUSY' });
      const p = port();
      mgr.cleanExit(); // a restart the user asked for is not a crash
      setTimeout(() => {
        try { restartHost({ port: p, dshHome: env.dshHome }); } catch (err) { logger?.error?.('restart failed: %s', err.message); }
      }, 200);
      return { restarting: true, port: p };
    },
  };

  return async function handler(req, res) {
    // Fail closed: if dsh's auth check is not available we cannot tell who is calling.
    if (typeof connection?.requestRejection !== 'function') return sendError(res, Object.assign(new Error('dsh authentication is not available, so this API refuses all requests'), { status: 503 }));
    let rejection;
    try { rejection = connection.requestRejection(req); } catch { rejection = 403; }
    if (rejection !== undefined) return sendError(res, Object.assign(new Error(rejection === 401 ? 'sign in to dsh first (open dsh with its token link)' : 'this request was refused by dsh (Host/Origin check)'), { status: rejection === 401 ? 401 : 403 }));

    const action = new URL(req.url, 'http://x').pathname.slice(API.length + 1);
    if (!(action in background || action in direct)) return sendError(res, Object.assign(new Error(`unknown action "${action}"`), { status: 404 }));
    if (req.method !== 'POST') return sendError(res, Object.assign(new Error('use POST'), { status: 405 }));
    // A cross-site <form> can only send simple content types; requiring JSON closes that door.
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return sendError(res, Object.assign(new Error('send the body as application/json'), { status: 415 }));
    try {
      const body = await readBody(req);
      if (action in direct) return send(res, 200, { ok: true, value: await direct[action](body) });
      const [kind, target, fn] = background[action](body);
      const op = ops.start(kind, target, fn, { action, body });
      return send(res, 200, { ok: true, value: { opId: op.id } });
    } catch (err) {
      if (!err?.status) logger?.error?.('%s failed: %s', action, err?.message);
      return sendError(res, err);
    }
  };
}
