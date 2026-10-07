// dsh-local-plugins host entry: mounts the API route and runs the boot checks
// (dsh upgrade / lost links, then a quiet update check in the background).
import { createEnv } from './env.js';
import { createManager } from './actions.js';
import { createOps } from './ops.js';
import { API, createHandler } from './routes.js';

export const name = 'dsh-local-plugins';
export const inject = ['webServer', 'connection'];

export function apply(ctx, config = {}) {
  const logger = ctx.logger?.(name) ?? console;
  const env = createEnv(config);
  const mgr = createManager(env);
  const ops = createOps();

  // Recovery runs first, inside the single-flight queue, so no user click can race it.
  ops.start('startup recovery', null, async (log) => {
    const result = await mgr.startup(log);
    if (result.upgrade) logger.warn('dsh changed %s -> %s; %d applied plugin link(s) lost — use Reapply all', result.upgrade.from, result.upgrade.to, result.upgrade.lost);
    for (const r of result.recovered) logger.warn('recovered interrupted %s of %s: %s', r.op, r.plugin, r.message);
    return result;
  });

  const handler = createHandler({ mgr, ops, env, port: () => ctx.webServer.port, connection: ctx.connection, logger });
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API, handler }), 'dsh-local-plugins: api route');

  // Quiet update check shortly after boot; nothing is pulled. It runs outside
  // the exclusive ops queue so it never makes a user's click wait or fail.
  ctx.effect(() => {
    const timer = setTimeout(() => {
      mgr.checkUpdates({}).catch((err) => logger.warn('startup update check failed: %s', err.message));
    }, 5000);
    return () => clearTimeout(timer);
  }, 'dsh-local-plugins: startup update check');
}
