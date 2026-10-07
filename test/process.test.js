import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, RunError } from '../lib/run.js';
import { redact, redactUrl } from '../lib/redact.js';
import { createOps } from '../lib/ops.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'lpm-proc-'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

test('run: normal exit, captured stdout and stderr', async () => {
  const r = await run('sh', ['-c', 'echo out; echo err >&2']);
  assert.equal(r.code, 0); assert.equal(r.signal, null); assert.equal(r.timedOut, false);
  assert.equal(r.stdout.trim(), 'out'); assert.equal(r.stderr.trim(), 'err');
});

test('run: non-zero exit rejects with the exit code and the tail of stderr; allowFail resolves instead', async () => {
  await assert.rejects(run('sh', ['-c', 'echo useful diagnostics >&2; exit 7']), (e) => e instanceof RunError && e.exitCode === 7 && e.timedOut === false && e.code === 'COMMAND_FAILED' && /exited 7/.test(e.message) && /useful diagnostics/.test(e.message) && /useful diagnostics/.test(e.result.stderr));
  const r = await run('sh', ['-c', 'exit 3'], { allowFail: true });
  assert.equal(r.code, 3);
});

test('run: timeout is reported as a timeout, distinct from failure', async () => {
  await assert.rejects(run('sleep', ['30'], { timeoutMs: 150, killGraceMs: 100 }), (e) => e.timedOut === true && e.code === 'COMMAND_TIMEOUT' && /timed out/.test(e.message));
});

test('run: a child that ignores SIGTERM is SIGKILLed after the grace period, with its own children', async () => {
  const dir = tmp(); const pidFile = join(dir, 'pids');
  const script = `trap '' TERM; sleep 60 & echo $! >> ${pidFile}; echo $$ >> ${pidFile}; while true; do sleep 1; done`;
  const t0 = Date.now();
  await assert.rejects(run('sh', ['-c', script], { timeoutMs: 200, killGraceMs: 300 }), (e) => e.timedOut);
  assert.ok(Date.now() - t0 < 5000, 'did not hang');
  await sleepMs(200);
  for (const pid of readFileSync(pidFile, 'utf8').trim().split('\n').map(Number)) assert.equal(alive(pid), false, `pid ${pid} is gone`);
  rmSync(dir, { recursive: true, force: true });
});

test('run: killed by an external signal is reported as a signal', async () => {
  await assert.rejects(run('sh', ['-c', 'kill -KILL $$']), (e) => e.signal === 'SIGKILL' && /killed by SIGKILL/.test(e.message));
  const r = await run('sh', ['-c', 'kill -TERM $$'], { allowFail: true });
  assert.equal(r.signal, 'SIGTERM'); assert.equal(r.code, null);
});

test('run: a child process (grandchild) does not outlive a normal exit of the parent', async () => {
  const dir = tmp(); const pidFile = join(dir, 'pid');
  await run('sh', ['-c', `sleep 60 & echo $! > ${pidFile}`]);
  await sleepMs(150);
  assert.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false);
  rmSync(dir, { recursive: true, force: true });
});

test('run: large output is capped to the newest 8 MB and flagged; memory stays bounded', async () => {
  const r = await run(process.execPath, ['-e', "for (let i = 0; i < 40; i++) process.stdout.write('x'.repeat(1024 * 1024)); process.stdout.write('THE-END')"]);
  assert.equal(r.code, 0);
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.length <= 8 * 1024 * 1024);
  assert.ok(r.stdout.endsWith('THE-END'), 'the tail (where errors are) is what survives');
});

test('run: a missing program is a clear error, and an endless line cannot grow the log buffer forever', async () => {
  await assert.rejects(run('definitely-not-a-program-xyz', []), (e) => e instanceof RunError && /definitely-not-a-program-xyz/.test(e.message));
  const lines = [];
  await run(process.execPath, ['-e', "process.stdout.write('y'.repeat(200000))"], { log: (l) => lines.push(l) });
  assert.ok(lines.length >= 1 && lines.every((l) => l.length <= 200000));
});

test('redact: tokens, credentials in URLs, auth headers and key=value secrets are masked', () => {
  const samples = [
    ['clone https://user:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/a/b.git', /ghp_|user:/],
    ['git+https://x-access-token:abcDEF123@github.com/a/b', /abcDEF123/],
    ['Authorization: Bearer eyJhbGciOi.payload.sig', /eyJhbGciOi/],
    ['//registry.npmjs.org/:_authToken=npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaa', /npm_a/],
    ['npm_token=npm_bbbbbbbbbbbbbbbbbbbbbbbbbbbb', /npm_b/],
    ['password=hunter22 other=fine', /hunter22/],
    ['{"apiKey": "sk-abcdefghijklmnopqrstuvwxyz123"}', /sk-abc/],
    ['key AKIAABCDEFGHIJKLMNOP leaked', /AKIAABCDEF/],
    ['github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', /github_pat_11/],
  ];
  for (const [input, leaked] of samples) {
    const out = redact(input);
    assert.doesNotMatch(out, leaked, `${input} -> ${out}`);
    assert.match(out, /\*\*\*/);
  }
  assert.equal(redact('plain text with no secrets: build ok in 3s'), 'plain text with no secrets: build ok in 3s');
  assert.equal(redactUrl('https://github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.equal(redactUrl('https://tok:en@github.com/a/b.git'), 'https://***@github.com/a/b.git');
  assert.equal(redact(undefined), undefined);
});

test('run: secrets printed by a child never reach the log callback or the error text', async () => {
  const lines = [];
  await assert.rejects(run('sh', ['-c', 'echo "fetching https://u:supersecrettoken@example.com/x"; echo "password=hunter22" >&2; exit 2'], { log: (l) => lines.push(l) }), (e) => !/supersecrettoken|hunter22/.test(e.message));
  assert.ok(lines.length >= 2);
  assert.ok(lines.every((l) => !/supersecrettoken|hunter22/.test(l)));
});

test('ops: logs are redacted, durations recorded, and a JSONL line is written per operation', async () => {
  const dir = tmp(); const logFile = join(dir, 'logs', 'operations.jsonl');
  const ops = createOps({ logFile });
  const ok = ops.start('apply', 'p1', async (log) => { log('using token=abcdef123456'); return 1; });
  await ok.promise;
  const bad = ops.start('update', 'p2', async () => { throw Object.assign(new Error('failed for https://a:b@host/x'), { code: 'SOME_CODE' }); });
  await bad.promise;
  assert.doesNotMatch(ops.get(ok.id).log.join('\n'), /abcdef123456/);
  assert.equal(typeof ops.get(ok.id).durationMs, 'number');
  assert.doesNotMatch(ops.get(bad.id).error, /a:b@/);
  const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.kind, l.plugin, l.status]), [['apply', 'p1', 'ok'], ['update', 'p2', 'error']]);
  assert.equal(lines[1].errorCode, 'SOME_CODE');
  assert.ok(!JSON.stringify(lines).includes('a:b@'));
  assert.ok((await import('node:fs')).statSync(logFile).mode % 0o1000 === 0o600);
  rmSync(dir, { recursive: true, force: true });
  void existsSync; void writeFileSync;
});
