import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorld, makeGitOrigin } from './helpers.js';
import { createHandler, API, API_VERSION } from '../lib/routes.js';
import { createOps } from '../lib/ops.js';
import { loadRegistry } from '../lib/registry.js';

let w, ops;
beforeEach(() => { w = makeWorld(); ops = createOps(); });
afterEach(() => w.cleanup());

const okConn = { requestRejection: () => undefined };
const handlerWith = (connection = okConn) => createHandler({ mgr: w.mgr, ops, env: w.env, port: () => 1, connection, logger: { error() {}, warn() {} } });

/** Drive the handler with mock request/response objects (no sockets needed). */
async function call(handler, action, body = {}, { method = 'POST', type = 'application/json', raw } = {}) {
  const req = new EventEmitter();
  req.method = method; req.url = `${API}/${action}`; req.headers = type ? { 'content-type': type } : {};
  req.destroy = () => {};
  let status; let headers; let text = '';
  const res = { writeHead(s, h) { status = s; headers = h; }, end(t) { text = t; } };
  const done = handler(req, res);
  const payload = raw ?? JSON.stringify(body);
  if (typeof payload === 'string') req.emit('data', Buffer.from(payload)); else for (const chunk of payload) req.emit('data', chunk);
  req.emit('end');
  await done;
  return { status, headers, json: JSON.parse(text) };
}

test('every error has the same shape: { ok:false, error:{ code, message, details } }', async () => {
  const h = handlerWith();
  const cases = [
    [await call(h, 'nope'), 404, 'NOT_FOUND'],
    [await call(h, 'state', {}, { method: 'GET' }), 405, 'METHOD_NOT_ALLOWED'],
    [await call(h, 'state', {}, { type: 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [await call(h, 'state', null, { raw: '[1,2]' }), 400, 'INVALID_INPUT'],
    [await call(h, 'state', null, { raw: '{oops' }), 400, 'INVALID_INPUT'],
    [await call(h, 'commits', { name: 'not-managed' }), 404, 'NOT_FOUND'],
    [await call(h, 'agentDraft', { name: 'missing' }), 404, 'NOT_FOUND'],
  ];
  for (const [r, status, code] of cases) {
    assert.equal(r.status, status, JSON.stringify(r.json));
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error.code, code);
    assert.equal(typeof r.json.error.message, 'string');
    assert.equal(typeof r.json.error.details, 'object');
  }
});

test('authentication: refused without dsh auth, and the API fails closed when the check is missing', async () => {
  const denied = await call(handlerWith({ requestRejection: () => 401 }), 'state');
  assert.equal(denied.status, 401); assert.equal(denied.json.error.code, 'UNAUTHORIZED');
  const forbidden = await call(handlerWith({ requestRejection: () => 403 }), 'state');
  assert.equal(forbidden.status, 403); assert.equal(forbidden.json.error.code, 'FORBIDDEN');
  const throws = await call(handlerWith({ requestRejection() { throw new Error('boom'); } }), 'state');
  assert.equal(throws.status, 403, 'a throwing check counts as a refusal');
  for (const conn of [null, {}, { requestRejection: 'yes' }]) {
    const r = await call(handlerWith(conn), 'state');
    assert.equal(r.status, 503, 'no auth available -> nothing is served');
    assert.equal(r.json.error.code, 'UNAVAILABLE');
  }
  // an unauthenticated call must not have started anything
  assert.equal(ops.busy(), false);
});

test('oversized request bodies are rejected with 413', async () => {
  const big = [Buffer.alloc(600 * 1024, 97), Buffer.alloc(600 * 1024, 97)];
  const r = await call(handlerWith(), 'state', null, { raw: big });
  assert.equal(r.status, 413);
  assert.equal(r.json.error.code, 'BODY_TOO_LARGE');
});

test('state carries the API version; a malformed registry is reported through it', async () => {
  const h = handlerWith();
  const ok = await call(h, 'state');
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.value.apiVersion, API_VERSION);
  mkdirSync(w.env.root, { recursive: true });
  writeFileSync(w.env.registryFile, '{ broken');
  const broken = await call(h, 'state');
  assert.equal(broken.json.value.registryError.code, 'REGISTRY_CORRUPT');
});

test('mutations are single-flight: a second one is refused with BUSY and a hint, nothing half-starts', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  const h = handlerWith();
  const first = await call(h, 'apply', { name: 'lpm-npm' });
  assert.equal(first.json.ok, true);
  const second = await call(h, 'commit', { name: 'lpm-npm' });
  assert.equal(second.status, 409);
  assert.equal(second.json.error.code, 'BUSY');
  assert.equal(second.json.error.details.running.kind, 'apply');
  await ops.get(first.json.value.opId); // view only
});

test('stress: 12 mutations fired at once -> exactly one runs, the rest are BUSY, state stays valid', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  const h = handlerWith();
  const actions = ['apply', 'commit', 'restore', 'update', 'setDep', 'repair', 'check', 'reapplyAll', 'apply', 'commit', 'abort', 'trust'];
  const bodies = { setDep: { name: 'lpm-npm', dep: 'dep-x', range: '1.0.0' }, trust: { name: 'lpm-npm', trust: true } };
  const results = await Promise.all(actions.map((a) => call(h, a, bodies[a] ?? { name: 'lpm-npm' })));
  const accepted = results.filter((r) => r.json.ok);
  const busy = results.filter((r) => !r.json.ok && r.json.error.code === 'BUSY');
  assert.equal(accepted.length, 1);
  assert.equal(busy.length, actions.length - 1);
  while (ops.busy()) await new Promise((r) => setTimeout(r, 20));
  const reg = loadRegistry(w.env.registryFile); // parses and validates
  assert.ok(reg.plugins['lpm-npm']);
  assert.deepEqual(Object.keys(reg.quarantine), []);
});

test('operation status stays queryable after failure', async () => {
  const h = handlerWith();
  const r = await call(h, 'migrate', { name: 'does-not-exist-anywhere' });
  while (ops.busy()) await new Promise((x) => setTimeout(x, 20));
  const op = await call(h, 'op', { id: r.json.value.opId });
  assert.equal(op.json.value.status, 'error');
  assert.ok(op.json.value.error);
  assert.ok(Array.isArray(op.json.value.log));
});

test('apply and restore are idempotent: repeating them is a reported no-op', async () => {
  await w.mgr.migrate({ name: 'lpm-npm', origin: 'npm' }, w.log);
  writeFileSync(join(w.env.repoDir('lpm-npm'), 'index.js'), 'export const line = "x";\n');
  const a1 = await w.mgr.apply({ name: 'lpm-npm' }, w.log);
  assert.equal(a1.noop, undefined);
  const restartAfterFirst = loadRegistry(w.env.registryFile).restartNeeded;
  assert.equal(restartAfterFirst, true);
  w.mgr.boot(); // pretend dsh restarted
  const a2 = await w.mgr.apply({ name: 'lpm-npm' }, w.log);
  assert.equal(a2.noop, true);
  assert.equal(a2.deployedSha, a1.deployedSha);
  assert.equal(loadRegistry(w.env.registryFile).restartNeeded, false, 'a no-op does not ask for a restart');

  await w.mgr.restore({ name: 'lpm-npm' }, w.log);
  const r2 = await w.mgr.restore({ name: 'lpm-npm' }, w.log);
  assert.equal(r2.noop, true);
  assert.equal(loadRegistry(w.env.registryFile).plugins['lpm-npm'].applied, false);
  // commit with nothing to commit, update when current
  const c = await w.mgr.commit({ name: 'lpm-npm' }, w.log);
  assert.equal(c.sha, null);
});
