// Checks the exact calls that docs/INTEGRATION-CAPTCHAME.md tells the CaptchaMe backend to make.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createMemoryStore, loadConfig } from '../src/index.js';
import { createApp } from '../service/app.js';
import { createClient } from '../sdk/node/index.js';

let server, app, base, ag;
before(async () => {
  app = createApp({ store: createMemoryStore(), config: loadConfig({}), apiKeys: 'captchame-key' });
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  ag = createClient({ baseUrl: base, apiKey: 'captchame-key', salt: 'captchame-salt', timeoutMs: 2000 });
  const put = await fetch(`${base}/v1/policy`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer captchame-key' },
    body: JSON.stringify({ preset: 'ai_app', strictness: 'strict', trap_paths: ['/trap'],
      endpoint_costs: [], budgets: [{ match: { plan: 'anonymous' }, budget_usd: 0.5 }, { match: { plan: 'human' }, budget_usd: 2 }, { match: { plan: 'agent' }, budget_usd: 1 }] }) });
  assert.equal(put.status, 200);
});
after(async () => { await app.drain(); await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }); });

// Step 1: map the CaptchaMe actor to an abuseguard subject (hashed by the SDK). Mirrors the doc's helper.
const subjectOf = (actor) => ag.subject('session', actor);
const quoteCost = { requests: 1, direct_usd: 0.10 };

test('step 3: a verified human pass is sent as a human.liveness signal from the server', async () => {
  const subject = subjectOf('human:abc123');
  const first = await ag.assess({ subject, mode: 'enforce', context: { surface: 'api', plan: 'anonymous' },
    signals: [{ type: 'human.liveness', value: 'pass', confidence: 0.9, freshness_s: 5, provenance: 'captchame' }] });
  assert.ok(first.reasons.includes('HUMAN_CHECK_PASSED'));
  const bare = await ag.assess({ subject: subjectOf('human:none'), mode: 'enforce', context: { surface: 'api', plan: 'anonymous' } });
  assert.ok(!bare.reasons.includes('HUMAN_CHECK_PASSED'), 'no pass means no human evidence');
});

test('step 4: each /quote call is reported as usage, with the $0.10 cost', async () => {
  const subject = subjectOf('human:quoter');
  await ag.track({ type: 'usage', subject, usage: quoteCost });
  await ag.flush();
  const decision = await ag.assess({ subject, mode: 'enforce', context: { surface: 'api', plan: 'human' } });
  assert.equal(decision.cost.attributed_usd, 0.1);
  assert.equal(decision.cost.budget_usd, 2, 'budget comes from the plan match');
  assert.equal(decision.decision, 'allow');
});

test('step 4: a budget that is used up gives a limit with a retry time and an appeal path', async () => {
  const subject = subjectOf('anon:spender');
  for (let i = 0; i < 6; i++) await ag.track({ type: 'usage', subject, usage: quoteCost });
  await ag.flush();
  const decision = await ag.assess({ subject, mode: 'enforce', context: { surface: 'api', plan: 'anonymous' } });
  assert.equal(decision.decision, 'limit');
  assert.equal(decision.action.status, 429);
  assert.ok(decision.recovery.paths.includes('appeal'));
  assert.ok(decision.decision_id, 'keep decision_id: CaptchaMe needs it to file an appeal');
});

test('step 5: an appeal is filed on the decision id, and an overturn trusts the subject', async () => {
  const subject = subjectOf('anon:spender');
  const decision = await ag.assess({ subject, mode: 'enforce', context: { surface: 'api', plan: 'anonymous' } });
  const appeal = await fetch(`${base}/v1/decisions/${decision.decision_id}/appeal`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer captchame-key' }, body: JSON.stringify({ note: 'my real use' }) }).then((r) => r.json());
  assert.equal(appeal.status, 'open');
  const resolved = await fetch(`${base}/v1/appeals/${appeal.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer captchame-key' }, body: JSON.stringify({ outcome: 'overturned' }) }).then((r) => r.json());
  assert.equal(resolved.status, 'resolved');
  // By design an overturned appeal clears blocks and challenges, but NOT the fair-share limit.
  // CaptchaMe's appeal grant (+$1) has no abuseguard equivalent yet: see docs/INTEGRATION-CAPTCHAME.md, gap G1.
  const after = await ag.assess({ subject, mode: 'enforce', context: { surface: 'api', plan: 'anonymous' } });
  assert.equal(after.decision, 'limit');
  const state = await fetch(`${base}/v1/subjects/session/${subject.id}`, { headers: { authorization: 'Bearer captchame-key' } }).then((r) => r.json());
  assert.deepEqual(state.standing, { trusted: true, appeal_open: false });
});

test('step 6: a failed check is sent as a step-up; a passed check moves the next decision on', async () => {
  const subject = subjectOf('session:nudged');
  const flagged = await ag.assess({ subject, mode: 'enforce', context: { surface: 'signup', plan: 'anonymous' }, behavior: { device_cluster: 10 } });
  assert.equal(flagged.decision, 'step_up');
  assert.equal(await ag.verify(subject, 'human_check', 'fail'), true);
  assert.equal((await ag.assess({ subject, mode: 'enforce', context: { surface: 'signup', plan: 'anonymous' }, behavior: { device_cluster: 10 } })).decision, 'step_up');
  assert.equal(await ag.verify(subject, 'human_check', 'pass'), true);
  const passed = await ag.assess({ subject, mode: 'enforce', context: { surface: 'signup', plan: 'anonymous' }, behavior: { device_cluster: 10 } });
  assert.deepEqual([passed.decision, passed.reasons.includes('HUMAN_CHECK_PASSED')], ['allow', true]);
});

test('step 7: a declared agent is sent as an agent.credential signal, and its budget is the agent plan', async () => {
  const subject = subjectOf('agent:4f2a9c');
  const verdict = await ag.assess({ subject, mode: 'enforce', context: { surface: 'api', plan: 'agent' },
    signals: [{ type: 'agent.credential', value: { scheme: 'captchame-ed25519', agent_id: '4f2a9c', verified: true, user_bound: false }, confidence: 0.95, freshness_s: 60, provenance: 'captchame' }] });
  assert.equal(verdict.class, 'delegated_agent');
  assert.equal(verdict.cost.budget_usd, 1);
  const stale = await ag.assess({ subject, mode: 'enforce', context: { surface: 'api', plan: 'agent' },
    signals: [{ type: 'agent.credential', value: { scheme: 'captchame-ed25519', agent_id: '4f2a9c', verified: true, user_bound: false }, confidence: 0.95, freshness_s: 900, provenance: 'captchame' }] });
  assert.ok(stale.reasons.includes('STALE_SIGNAL_IGNORED'), 'older than 300 s: ignored, so the agent is treated as unverified');
});

test('step 8: a visit to the trap path is counted as a trap hit from the middleware report', async () => {
  const subject = subjectOf('session:trapped');
  await ag.track({ type: 'response', subject, response: { path: '/trap', status: 200, bytes: 0, rt: 0.001 } });
  await ag.flush();
  const state = await fetch(`${base}/v1/subjects/session/${subject.id}`, { headers: { authorization: 'Bearer captchame-key' } }).then((r) => r.json());
  assert.equal(state.live?.trap_hits ?? 0, 0, 'a response alone is not a request; the request must be reported first');
  await ag.track({ type: 'request', subject, request: { path: '/trap', ua: 'python-requests/2.32', status: 200 } });
  await ag.flush();
  const verdict = await ag.assess({ subject, mode: 'enforce', context: { surface: 'content' } });
  assert.ok(verdict.reasons.includes('TRAP_LINK'));
});

test('step 2: a key that is not a tenant key gets a 401, and the subject comes back hashed', async () => {
  const bad = createClient({ baseUrl: base, apiKey: 'wrong', salt: 'captchame-salt', timeoutMs: 2000 });
  assert.equal((await bad.assess({ subject: subjectOf('x'), mode: 'enforce' })).status, 401);
  assert.match(subjectOf('human:abc123').id, /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(subjectOf('human:abc123')).includes('abc123'), 'the raw actor never leaves the server');
});
