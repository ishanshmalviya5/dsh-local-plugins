// dsh-local-plugins host entry: mounts the API route and runs the boot checks
// (dsh upgrade / lost links, then a quiet update check in the background).
import { join } from 'node:path';
import { assertSupportedPlatform } from './platform.js';
import { createEnv } from './env.js';
import { createManager } from './actions.js';
import { createOps } from './ops.js';
import { API, createHandler } from './routes.js';
import { HEALTH_MS } from './health.js';

export const name = 'dsh-local-plugins';
export const inject = ['webServer', 'connection'];

export function apply(ctx, config = {}) {
  const logger = ctx.logger?.(name) ?? console;
  try { assertSupportedPlatform(); } catch (err) { logger.error('%s', err.message); return; } // dsh keeps running; this plugin stays inert
  const env = createEnv(config);
  const mgr = createManager(env);
  const ops = createOps({ logFile: join(env.root, 'logs', 'operations.jsonl') });
  let healthTimer;

  // Recovery runs first, inside the single-flight queue, so no user click can race it.
  ops.start('startup recovery', null, async (log) => {
    const result = await mgr.startup(log);
    if (result.upgrade) logger.warn('dsh changed %s -> %s; %d applied plugin link(s) lost — use Reapply all', result.upgrade.from, result.upgrade.to, result.upgrade.lost);
    for (const r of result.recovered) logger.warn('recovered interrupted %s of %s: %s', r.op, r.plugin, r.message);
    // surviving the health window ends the probation of freshly applied code
    if (result.health.watching.length) {
      const t = setTimeout(() => { try { mgr.healthy(result.health.watching); } catch (err) { logger.warn('health mark failed: %s', err.message); } }, HEALTH_MS());
      t.unref?.();
      healthTimer = t;
    }
    for (const r of result.health.reverted) logger.warn('%s crashed dsh; %s', r.plugin, r.mode);
    return result;
  });
  ctx.effect(() => () => { clearTimeout(healthTimer); mgr.cleanExit(); }, 'dsh-local-plugins: clean shutdown marker');
  process.once('exit', (code) => { if (code === 0) mgr.cleanExit(); });

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
