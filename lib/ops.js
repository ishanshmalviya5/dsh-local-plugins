// Single-flight operation queue: one mutating operation at a time, each with
// a streamed log the UI polls. A second request while busy is refused (409)
// rather than queued, so two git/pnpm runs never race on the same repo.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { redact } from './redact.js';
import { adviceFor, failureTitle } from './messages.js';

const LOG_MAX = 2 * 1024 * 1024;

/** One JSON line per finished operation: who, what, how long, how it ended. Never contains secrets. */
function appendOpLog(file, op) {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { if (statSync(file).size > LOG_MAX) renameSync(file, `${file}.1`); } catch { /* new file */ }
    appendFileSync(file, `${JSON.stringify({ id: op.id, kind: op.kind, plugin: op.target, action: op.request?.action ?? null, commit: op.result?.deployedSha ?? op.result?.sha ?? null, snapshot: op.result?.snapshot ?? null, status: op.status, startedAt: new Date(op.startedAt).toISOString(), durationMs: op.endedAt - op.startedAt, errorCode: op.errorCode, error: op.error })}\n`, { mode: 0o600 });
  } catch { /* logging must never break an operation */ }
}

export function createOps({ logFile = null } = {}) {
  let current = null;
  const history = [];
  let seq = 0;

  function view(op) {
    if (!op) return null;
    const { promise, ...rest } = op;
    return { ...rest, durationMs: (op.endedAt ?? Date.now()) - op.startedAt, log: op.log.slice(-400) };
  }

  return {
    current: () => view(current),
    last: () => view(history[0] ?? null),
    /** Newest first, without the (large) logs. */
    history: () => history.map((o) => { const { log, ...rest } = view(o); return { ...rest, lines: o.log.length }; }),
    get: (id) => view(current?.id === id ? current : history.find((o) => o.id === id)),
    busy: () => current !== null,

    /** Start `fn(log)` in the background; returns the op (await op.promise to join). */
    start(kind, target, fn, request = null) {
      if (current) {
        const err = new Error(`busy: ${current.kind}${current.target ? ` ${current.target}` : ''} is still running. Wait for it to finish; nothing was started.`);
        err.status = 409;
        err.code = 'BUSY';
        err.details = { running: { id: current.id, kind: current.kind, target: current.target } };
        throw err;
      }
      const op = { id: ++seq, kind, target, status: 'running', log: [], startedAt: Date.now(), endedAt: null, result: null, error: null, needsTrust: null, errorCode: null, title: null, advice: null, request };
      const log = (line) => {
        op.log.push(redact(String(line)));
        if (op.log.length > 4000) op.log.splice(0, 1000);
      };
      current = op;
      op.promise = Promise.resolve()
        .then(() => fn(log))
        .then((result) => { op.status = 'ok'; op.result = result ?? null; },
          (err) => { op.status = 'error'; op.error = redact(err?.message ?? String(err)); op.needsTrust = err?.needsTrust ?? null; op.errorCode = err?.code ?? null; const action = op.request?.action ?? op.kind; op.title = failureTitle(action); op.advice = adviceFor({ action, code: op.errorCode }); log(`ERROR: ${op.error}`); })
        .finally(() => {
          op.endedAt = Date.now();
          current = null;
          if (logFile) appendOpLog(logFile, op);
          history.unshift(op);
          if (history.length > 20) history.length = 20;
        });
      return op;
    },
  };
}
