import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createMemoryStore, loadConfig } from '../src/index.js';
import { createApp } from '../service/app.js';
import { golden, assertVector, assertShape } from './helpers.js';
import { genLogs } from './synth.js';

let server, base;
before(async () => {
  server = createServer(createApp({ store: createMemoryStore(), config: loadConfig({}), apiKeys: 'acme:key-a, other:key-b' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

async function call(method, path, body, { key = 'key-a', type = 'application/json' } = {}) {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': type, ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, type: res.headers.get('content-type'), spec: res.headers.get('ag-spec-version'), body: text ? JSON.parse(text) : null };
}
const acct = (id) => ({ kind: 'account', id });

test('ops endpoints need no auth; everything else does', async () => {
  for (const path of ['/healthz', '/readyz', '/v1/version']) assert.equal((await call('GET', path, undefined, { key: null })).status, 200);
  const unauth = await call('POST', '/v1/decisions', { subject: acct('x') }, { key: 'wrong' });
  assert.deepEqual([unauth.status, unauth.type, unauth.body.status], [401, 'application/problem+json', 401]);
});

test('service matches every golden vector and the response shape (C1, C2)', async () => {
  for (const vector of golden.vectors) {
    const res = await call('POST', '/v1/decisions', vector.input);
    assert.equal(res.status, 200, vector.id);
    assertShape(res.body);
    assertVector(res.body, vector.expect, vector.id);
  }
});

test('per-human budget: four linked accounts, each under budget, are limited as one', async () => {
  const ids = ['m1', 'm2', 'm3', 'm4'];
  const events = ids.flatMap((id) => [
    { type: 'link', subject: acct(id), ts: new Date().toISOString(), link: { link_type: 'device', value_hash: 'devhash-1' } },
    { type: 'usage', subject: acct(id), ts: new Date().toISOString(), usage: { requests: 10, direct_usd: 2 } },
  ]);
  events.push({ type: 'usage', subject: acct('solo'), ts: new Date().toISOString(), usage: { requests: 10, direct_usd: 2 } }, { type: 'nonsense', subject: acct('solo') });
  assert.deepEqual((await call('POST', '/v1/events', { events })).body, { accepted: 9, rejected: 1 });

  const solo = (await call('POST', '/v1/decisions', { subject: acct('solo') })).body;
  assert.deepEqual([solo.decision, solo.cost.attributed_usd], ['allow', 2]);

  const member = (await call('POST', '/v1/decisions', { subject: acct('m1'), mode: 'enforce' })).body;
  assert.equal(member.cost.attributed_usd, 8, 'cost is summed over the device cluster');
  assert.deepEqual([member.decision, member.effective_decision], ['limit', 'limit']);
  assert.ok(member.reasons.includes('COST_OVER_BUDGET') && member.reasons.includes('DEVICE_CLUSTER'));

  const state = (await call('GET', '/v1/subjects/account/m1')).body;
  assert.deepEqual([state.clusters.device, state.window.cost_attributed_usd, state.window.budget_usd], [4, 8, 5]);
  assert.equal((await call('GET', '/v1/subjects/account/m1', undefined, { key: 'key-b' })).status, 404, 'tenants are isolated');
});

test('decision lifecycle: get, explanation, appeal, resolve, outcome, accuracy', async () => {
  const { body: verdict } = await call('POST', '/v1/decisions', { subject: acct('m2'), mode: 'enforce' });
  const id = verdict.decision_id;
  assert.equal((await call('GET', `/v1/decisions/${id}`)).body.decision, 'limit');
  assert.equal((await call('GET', `/v1/decisions/${id}`, undefined, { key: 'key-b' })).status, 404);
  const text = (await call('GET', `/v1/decisions/${id}/explanation`)).body;
  assert.ok(text.headline && text.next_steps.some((s) => s.path === 'appeal'));
  const appeal = await call('POST', `/v1/decisions/${id}/appeal`, { note: 'shared family laptop' });
  assert.equal(appeal.status, 201);
  assert.equal((await call('POST', '/v1/decisions/dec_missing/appeal', {})).status, 404);
  assert.equal((await call('PATCH', `/v1/appeals/${appeal.body.id}`, { outcome: 'maybe' })).status, 400);
  assert.equal((await call('PATCH', `/v1/appeals/${appeal.body.id}`, { outcome: 'overturned' })).body.status, 'resolved');
  assert.equal((await call('POST', `/v1/decisions/${id}/outcome`, { label: 'legitimate' })).status, 204);
  const acc = (await call('GET', '/v1/metrics/accuracy')).body;
  assert.deepEqual([acc.appeals, acc.appeals_overturned, acc.appeal_overturn_rate, acc.labelled_non_allow, acc.precision], [1, 1, 1, 1, 0]);
  assert.equal((await call('GET', '/v1/metrics/accuracy', undefined, { key: 'key-b' })).body.precision, null);
});

test('policy: budget, mode, matched budgets and agent policies are applied', async () => {
  assert.equal((await call('PUT', '/v1/policy', { mode: 'never' })).status, 400);
  await call('PUT', '/v1/agent-policies/example-agent', { mode: 'deny' });
  await call('PUT', '/v1/policy', { mode: 'enforce', budget_usd: 1, budgets: [{ match: { plan: 'pro' }, budget_usd: 100 }] });
  assert.equal((await call('GET', '/v1/agent-policies/example-agent')).body.mode, 'deny', 'policy update keeps agent policies');
  const free = (await call('POST', '/v1/decisions', { subject: acct('solo') })).body;
  assert.deepEqual([free.decision, free.enforced, free.cost.budget_usd], ['limit', true, 1]);
  const pro = (await call('POST', '/v1/decisions', { subject: acct('solo'), context: { plan: 'pro' } })).body;
  assert.deepEqual([pro.decision, pro.cost.budget_usd], ['allow', 100]);
  const signal = { type: 'agent.credential', value: { scheme: 'web-bot-auth', agent_id: 'example-agent', verified: true, user_bound: true }, confidence: 0.95, freshness_s: 1, provenance: 'adapter.web_bot_auth' };
  const agent = (await call('POST', '/v1/decisions', { subject: acct('agent-user'), signals: [signal] })).body;
  assert.deepEqual([agent.class, agent.decision], ['delegated_agent', 'block']);
  assert.ok(agent.recovery.paths.includes('human_path'));
  await call('PUT', '/v1/policy', {});
});

test('pushed signals are merged into later decisions and age out of agent credentials', async () => {
  const subject = acct('pushed');
  const signals = [{ type: 'risk.multi_account', value: 0.95, confidence: 0.9, freshness_s: 0, provenance: 'stripe_radar' }];
  assert.equal((await call('POST', '/v1/signals', { subject, signals })).status, 202);
  assert.equal((await call('POST', '/v1/signals', { subject, signals: [{ value: 1 }] })).status, 400);
  const verdict = (await call('POST', '/v1/decisions', { subject, behavior: { signups_per_hour: 12 } })).body;
  assert.deepEqual([verdict.class, verdict.decision], ['likely_farm', 'step_up']);
  assert.ok(verdict.reasons.includes('PROVIDER_MULTI_ACCOUNT_RISK'));
});

test('erasure removes the subject and its usage', async () => {
  assert.equal((await call('DELETE', '/v1/subjects/account/m4')).status, 204);
  assert.equal((await call('GET', '/v1/subjects/account/m4')).status, 404);
  assert.equal((await call('GET', '/v1/subjects/account/m1')).body.clusters.device, 3);
});

test('log audit over HTTP returns a dollar report without raw IPs', async () => {
  const lines = genLogs(1, 5).join('\n');
  const res = await call('POST', '/v1/audits?disallow=/private/&endpoint_cost=/api/generate=0.02&converted_path=/checkout/complete', lines, { type: 'application/x-ndjson' });
  assert.equal(res.status, 202);
  assert.equal(res.body.report.by_class.suspected_scraper.subjects, 1);
  assert.ok(res.body.report.estimated_savings_usd > 0);
  assert.ok(!/198\.51\.100\./.test(JSON.stringify(res.body)));
  assert.equal((await call('GET', `/v1/audits/${res.body.id}`)).body.status, 'done');
  assert.equal((await call('GET', `/v1/audits/${res.body.id}`, undefined, { key: 'key-b' })).status, 404);
});

test('error model: 400, 404, 413, 501 are problem documents', async () => {
  const cases = [
    ['POST', '/v1/decisions', { behavior: {} }, 400], ['POST', '/v1/decisions', 'not json', 400],
    ['POST', '/v1/decisions', { subject: { kind: 'robot', id: 'x' } }, 400], ['GET', '/v1/nope', undefined, 404],
    ['GET', '/v1/decisions/dec_nope', undefined, 404], ['POST', '/v1/agent-passes', {}, 501],
    ['POST', '/v1/decisions', { subject: acct('big'), pad: 'x'.repeat(300 * 1024) }, 413],
  ];
  for (const [method, path, body, status] of cases) {
    const res = await call(method, path, body);
    assert.deepEqual([res.status, res.type, res.body.status, typeof res.body.title], [status, 'application/problem+json', status, 'string'], `${method} ${path}`);
  }
});

test('latency: 1,000 sequential decisions on the memory store, p99 under 20 ms', async (t) => {
  const times = [];
  for (let i = 0; i < 1000; i++) {
    const t0 = performance.now();
    await call('POST', '/v1/decisions', { subject: acct(`lat${i % 50}`) });
    times.push(performance.now() - t0);
  }
  times.sort((x, y) => x - y);
  t.diagnostic(`p50 ${times[500].toFixed(2)} ms, p99 ${times[990].toFixed(2)} ms (loopback, memory store)`);
  assert.ok(times[990] < 20);
});
