// @ts-check
/** Service entry point. All configuration comes from environment variables (see README). */
import { createServer } from 'node:http';
import { loadConfig, createMemoryStore, createPostgresStore } from '../src/index.js';
import { createApp } from './app.js';

const env = process.env;
const log = (level, msg, extra = {}) => console.log(JSON.stringify({ level, msg, ...extra }));

async function makeStore() {
  if (!env.DATABASE_URL) {
    log('warn', 'DATABASE_URL is not set: using the in-memory store; data is lost on restart');
    return createMemoryStore();
  }
  let pg;
  try { pg = await import('pg'); } catch { throw new Error('DATABASE_URL is set but the optional dependency "pg" is not installed (npm install pg)'); }
  const Pool = pg.default?.Pool ?? pg.Pool;
  return createPostgresStore(new Pool({
    connectionString: env.DATABASE_URL, max: Number(env.AG_PG_POOL_SIZE ?? 10),
    statement_timeout: Number(env.AG_PG_STATEMENT_TIMEOUT_MS ?? 2000),
  }));
}

if (!env.AG_API_KEYS) {
  log('error', 'AG_API_KEYS is required, for example AG_API_KEYS="acme:long-random-key"');
  process.exit(1);
}
const store = await makeStore();
const app = createApp({ store, config: loadConfig(env), apiKeys: env.AG_API_KEYS, allowPrivateWebhooks: env.AG_WEBHOOK_ALLOW_PRIVATE === '1' });
const server = createServer(app);
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
const port = Number(env.PORT ?? 8787);
server.listen(port, env.HOST ?? '0.0.0.0', () => log('info', 'abuseguard listening', { port, mode: loadConfig(env).mode }));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log('info', 'shutting down', { signal });
    server.close(async () => { await app.drain(); await store.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
