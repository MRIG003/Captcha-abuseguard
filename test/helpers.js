// Shared test helpers: golden vectors, vector assertion (C2) and response-shape assertion (C1).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLASSES, DECISIONS, SPEC_VERSION, REASON_TEXT, decide } from '../src/index.js';

export const golden = JSON.parse(readFileSync(new URL('../contracts/golden-vectors.json', import.meta.url), 'utf8'));

/** Assert one verdict against one vector's expectation. */
export function assertVector(verdict, expect, id) {
  assert.equal(verdict.class, expect.class, `${id}: class`);
  assert.equal(verdict.decision, expect.decision, `${id}: decision`);
  for (const code of expect.reasons_include ?? []) assert.ok(verdict.reasons.includes(code), `${id}: missing reason ${code} in ${verdict.reasons}`);
  if (expect.step) assert.equal(verdict.action?.step, expect.step, `${id}: step`);
  if (expect.slow_mode) assert.equal(verdict.action?.mode, expect.slow_mode, `${id}: slow mode`);
  if ('enforced' in expect) assert.equal(verdict.enforced, expect.enforced, `${id}: enforced`);
  if (expect.effective_decision) assert.equal(verdict.effective_decision, expect.effective_decision, `${id}: effective`);
  for (const path of expect.recovery_includes ?? []) assert.ok(verdict.recovery?.paths.includes(path), `${id}: missing recovery ${path}`);
}

/** C1: response shape. */
export function assertShape(v) {
  assert.equal(v.spec_version, SPEC_VERSION);
  assert.ok(CLASSES.includes(v.class), `class ${v.class}`);
  assert.ok(DECISIONS.includes(v.decision), `decision ${v.decision}`);
  assert.ok(DECISIONS.includes(v.effective_decision));
  assert.equal(typeof v.enforced, 'boolean');
  assert.ok(typeof v.confidence === 'number' && v.confidence >= 0 && v.confidence <= 1);
  assert.ok(Array.isArray(v.reasons) && v.reasons.length >= 1 && v.reasons.every((code) => code in REASON_TEXT));
  for (const key of ['farm', 'scraper', 'legit', 'cost_ratio']) assert.equal(typeof v.scores[key], 'number');
  assert.equal(typeof v.cost.attributed_usd, 'number');
  if (v.decision === 'allow') assert.equal(v.recovery, null);
  else {
    assert.ok(v.action && typeof v.action.type === 'string');
    assert.ok(v.recovery.appeal === true && v.recovery.paths.includes('appeal') && v.recovery.sla_hours > 0);
  }
  if (!v.enforced) assert.equal(v.effective_decision, 'allow');
}

/**
 * Store adapter contract (C10). `makeStore(now)` returns the adapter; `age(ms)` makes existing rows older
 * for adapters that use the database clock.
 */
export async function storeContract(makeStore, age) {
  let clock = 1_000_000;
  const store = await makeStore(() => clock);
  const w = age ? Math.floor(Date.now() / 1000) * 1000 : clock; // current budget window start
  const a = { kind: 'account', id: 'a' }, b = { kind: 'account', id: 'b' }, c = { kind: 'account', id: 'c' };
  for (const s of [a, b, c]) await store.upsertSubject('t1', s, { plan: 'free' });
  await store.linkAttribute('t1', a, 'device', 'dev1');
  await store.linkAttribute('t1', b, 'device', 'dev1');
  await store.linkAttribute('t1', c, 'device', 'dev2');
  await store.linkAttribute('t2', c, 'device', 'dev1');
  assert.equal(await store.clusterSize('t1', a, 'device'), 2);
  assert.equal(await store.clusterSize('t1', c, 'device'), 1);
  assert.equal(await store.clusterSize('t1', a, 'payment'), 1);

  await store.addUsage('t1', a, w, { requests: 2, cost_usd: 1.5 });
  assert.deepEqual(await store.addUsage('t1', a, w, { requests: 1, cost_usd: 0.5 }), { requests: 3, cost_usd: 2 });
  assert.deepEqual(await store.getUsage('t1', b, w), { requests: 0, cost_usd: 0 });
  await store.addUsage('t1', b, w, { requests: 4, cost_usd: 2 });
  await store.addUsage('t1', c, w, { requests: 9, cost_usd: 9 });
  assert.deepEqual(await store.clusterUsage('t1', a, w, ['device', 'payment']), { requests: 7, cost_usd: 4 }, 'cluster cost is the sum over linked subjects');
  assert.deepEqual(await store.clusterUsage('t1', c, w, ['device']), { requests: 9, cost_usd: 9 });
  assert.equal((await store.getSubject('t1', a)).attrs.plan, 'free');
  assert.equal(await store.getSubject('t1', { kind: 'account', id: 'zz' }), null);
  assert.equal(await store.getPolicy('t1'), null);
  await store.putPolicy('t1', { mode: 'enforce', budget_usd: 3 });
  assert.equal((await store.getPolicy('t1')).budget_usd, 3);

  const verdict = decide({ subject: a, behavior: { device_cluster: 40, disposable_email: true, signups_per_hour: 20 } });
  const id = await store.saveDecision('t1', verdict);
  assert.equal((await store.getDecision('t1', id)).class, 'likely_farm');
  assert.equal(await store.getDecision('t2', id), null, 'tenants are isolated');
  await assert.rejects(store.saveAppeal('t2', id, {}));
  const appeal = await store.saveAppeal('t1', id, { channel: 'api', note: 'shared lab machine' });
  await store.resolveAppeal('t1', appeal, 'overturned');
  await assert.rejects(store.saveOutcome('t2', id, 'abusive'));
  await store.saveOutcome('t1', id, 'abusive');
  assert.deepEqual(await store.accuracy('t1'), { decisions: 1, non_allow: 1, appeals: 1, overturned: 1, labelled: 1, labelled_abusive: 1 });

  if (age) await age(10_000); else clock += 10_000; // make existing rows 10 s old
  assert.equal(await store.purge('t1', 60_000), 0);
  assert.ok((await store.purge('t1', 5_000)) >= 2);
  assert.equal(await store.getDecision('t1', id), null);

  await store.eraseSubject('t1', a);
  assert.equal(await store.clusterSize('t1', b, 'device'), 1);
  await store.close();
}
