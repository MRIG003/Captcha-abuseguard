// @ts-check
/** Applies contracts/schema.sql (idempotent). Usage: DATABASE_URL=postgres://... node service/migrate.js */
import { readFileSync } from 'node:fs';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
let pg;
try { pg = await import('pg'); } catch { console.error('the optional dependency "pg" is not installed (npm install pg)'); process.exit(1); }
const Client = pg.default?.Client ?? pg.Client;
const client = new Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  await client.query(readFileSync(new URL('../contracts/schema.sql', import.meta.url), 'utf8'));
  const { rows } = await client.query('SELECT max(version) AS version FROM schema_version');
  console.log(JSON.stringify({ level: 'info', msg: 'schema applied', version: rows[0].version }));
} catch (err) {
  console.error(JSON.stringify({ level: 'error', msg: `migration failed: ${err.message}` }));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
