// Single-flight operation queue: one mutating operation at a time, each with
// a streamed log the UI polls. A second request while busy is refused (409)
// rather than queued, so two git/pnpm runs never race on the same repo.
export function createOps() {
  let current = null;
  const history = [];
  let seq = 0;

  function view(op) {
    if (!op) return null;
    const { promise, ...rest } = op;
    return { ...rest, log: op.log.slice(-400) };
  }

  return {
    current: () => view(current),
    last: () => view(history[0] ?? null),
    get: (id) => view(current?.id === id ? current : history.find((o) => o.id === id)),
    busy: () => current !== null,

    /** Start `fn(log)` in the background; returns the op (await op.promise to join). */
    start(kind, target, fn) {
      if (current) {
        const err = new Error(`busy: ${current.kind}${current.target ? ` ${current.target}` : ''} is running`);
        err.status = 409;
        throw err;
      }
      const op = { id: ++seq, kind, target, status: 'running', log: [], startedAt: Date.now(), endedAt: null, result: null, error: null };
      const log = (line) => {
        op.log.push(String(line));
        if (op.log.length > 4000) op.log.splice(0, 1000);
      };
      current = op;
      op.promise = Promise.resolve()
        .then(() => fn(log))
        .then((result) => { op.status = 'ok'; op.result = result ?? null; },
          (err) => { op.status = 'error'; op.error = err?.message ?? String(err); log(`ERROR: ${op.error}`); })
        .finally(() => {
          op.endedAt = Date.now();
          current = null;
          history.unshift(op);
          if (history.length > 20) history.length = 20;
        });
      return op;
    },
  };
}
