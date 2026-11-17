import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STORE_METHODS, assertStore, createMemoryStore, createPostgresStore, decide } from '../src/index.js';

/** Adapter contract. Any new store adapter must pass this with its own factory. */
export async function storeContract(makeStore) {
  let clock = 1_000_000;
  const store = makeStore(() => clock);
  const a = { kind: 'account', id: 'a' }, b = { kind: 'account', id: 'b' }, c = { kind: 'account', id: 'c' };
  for (const s of [a, b, c]) await store.upsertSubject('t1', s, { plan: 'free' });
  await store.linkAttribute('t1', a, 'device', 'dev1');
  await store.linkAttribute('t1', b, 'device', 'dev1');
  await store.linkAttribute('t1', c, 'device', 'dev2');
  await store.linkAttribute('t2', c, 'device', 'dev1');
  assert.equal(await store.clusterSize('t1', a, 'device'), 2);
  assert.equal(await store.clusterSize('t1', c, 'device'), 1);
  assert.equal(await store.clusterSize('t1', a, 'payment'), 1);

  await store.addUsage('t1', a, 0, { requests: 2, cost_usd: 1.5 });
  assert.deepEqual(await store.addUsage('t1', a, 0, { requests: 1, cost_usd: 0.5 }), { requests: 3, cost_usd: 2 });
  assert.deepEqual(await store.getUsage('t1', b, 0), { requests: 0, cost_usd: 0 });

  const verdict = decide({ subject: a, behavior: { device_cluster: 40, disposable_email: true, signups_per_hour: 20 } });
  const id = await store.saveDecision('t1', verdict);
  assert.equal((await store.getDecision('t1', id)).class, 'likely_farm');
  assert.equal(await store.getDecision('t2', id), null, 'tenants are isolated');
  await assert.rejects(store.saveAppeal('t2', id, {}));
  const appeal = await store.saveAppeal('t1', id, { channel: 'api', note: 'shared lab machine' });
  await store.resolveAppeal('t1', appeal, 'overturned');
  assert.deepEqual(await store.accuracy('t1'), { decisions: 1, non_allow: 1, appeals: 1, overturned: 1 });

  clock += 10_000;
  assert.equal(await store.purge('t1', 60_000), 0);
  assert.ok((await store.purge('t1', 5_000)) >= 2);
  assert.equal(await store.getDecision('t1', id), null);

  await store.eraseSubject('t1', a);
  assert.equal(await store.clusterSize('t1', b, 'device'), 1);
  await store.close();
}

test('memory store passes the adapter contract', () => storeContract(createMemoryStore));

test('assertStore rejects incomplete adapters', () => {
  assert.throws(() => assertStore({ upsertSubject() {} }), /missing/);
  assert.equal(STORE_METHODS.length, 13);
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
