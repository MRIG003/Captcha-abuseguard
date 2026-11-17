// Runs the store adapter contract against a real PostgreSQL when AG_TEST_DATABASE_URL is set (needs `pg`):
//   npm install --no-save pg && AG_TEST_DATABASE_URL=postgres://ag:ag@localhost:5432/ag_test npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPostgresStore } from '../src/index.js';
import { storeContract } from './helpers.js';

const url = process.env.AG_TEST_DATABASE_URL;
const TABLES = ['outcomes', 'appeals', 'decisions', 'signals', 'usage_windows', 'subject_links', 'subjects', 'tenants'];

test('postgres store passes the adapter contract on a live database', { skip: url ? false : 'AG_TEST_DATABASE_URL is not set' }, async () => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const schema = readFileSync(new URL('../contracts/schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // the schema must be idempotent
  await pool.query(`TRUNCATE ${TABLES.join(', ')}`);
  const age = async (ms) => {
    for (const [table, column] of [['decisions', 'created_at'], ['appeals', 'created_at'], ['usage_windows', 'window_start']]) {
      await pool.query(`UPDATE ${table} SET ${column} = ${column} - ($1 || ' milliseconds')::interval`, [String(ms)]);
    }
  };
  await storeContract(() => createPostgresStore(pool), age);

  // clusterSize must use the per-subject index, not a sequential scan of the join driver.
  const pool2 = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await pool2.query('SET enable_seqscan = off');
    const plan = await pool2.query(`EXPLAIN SELECT count(DISTINCT b.subject_key) FROM subject_links a
      JOIN subject_links b ON b.tenant_id = a.tenant_id AND b.link_type = a.link_type AND b.value_hash = a.value_hash
      WHERE a.tenant_id = 't1' AND a.subject_key = 'account:a' AND a.link_type = 'device'`);
    assert.match(plan.rows.map((r) => r['QUERY PLAN']).join('\n'), /subject_links_by_subject|subject_links_pkey/);
  } finally { await pool2.end(); }
});
