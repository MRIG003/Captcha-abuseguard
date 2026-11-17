import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STORE_METHODS, assertStore, createMemoryStore, createPostgresStore, decide } from '../src/index.js';
import { storeContract } from './helpers.js';


test('memory store passes the adapter contract', () => storeContract(createMemoryStore));

test('assertStore rejects incomplete adapters', () => {
  assert.throws(() => assertStore({ upsertSubject() {} }), /missing/);
  assert.equal(STORE_METHODS.length, 18);
});

test('postgres adapter: statement shapes against a recording pool (no live database in this run)', async () => {
  const calls = [];
  const pool = { query: async (text, params) => { calls.push({ text, params }); return { rows: /clusterSize|count\(DISTINCT/.test(text) ? [{ n: 3 }] : [{ id: 'x', requests: 1, cost_usd: 1 }] }; } };
  const store = createPostgresStore(pool);
  const s = { kind: 'api_key', id: 'k' };
  await store.upsertSubject('t', s);
  await store.linkAttribute('t', s, 'device', 'h');
  assert.equal(await store.clusterSize('t', s, 'device'), 3);
  await store.addUsage('t', s, 0, { requests: 1, cost_usd: 1 });
  await store.saveDecision('t', decide({ subject: s }));
  await store.eraseSubject('t', s);
  assert.ok(calls.length >= 10);
  for (const { text, params } of calls) {
    assert.ok(params.includes('t'), 'every statement is tenant-scoped');
    assert.ok(!/\$\{/.test(text) && (text.match(/\$\d/g) ?? []).length >= 1, 'parameterised SQL only');
  }
});
