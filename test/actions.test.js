// What happens after a flag: step-up loop, appeals, trust, webhooks, presets, strictness, and SDK enforcement.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { createMemoryStore, loadConfig } from '../src/index.js';
import { createApp } from '../service/app.js';
import { createClient } from '../sdk/node/index.js';

let server, app, base, receiver, hookUrl;
const received = [];
before(async () => {
  app = createApp({ store: createMemoryStore(), config: loadConfig({}), apiKeys: 'acme:key-a,shop:key-s,tix:key-t,strict:key-x', allowPrivateWebhooks: true });
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  receiver = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { received.push({ signature: req.headers['ag-signature'], body: Buffer.concat(chunks).toString('utf8') }); res.end('ok'); });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  hookUrl = `http://127.0.0.1:${receiver.address().port}/hook`;
});
after(async () => {
  await app.drain();
  for (const s of [server, receiver]) await new Promise((resolve) => { s.closeAllConnections(); s.close(resolve); });
});

async function call(method, path, body, key = 'key-a') {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const acct = (id) => ({ kind: 'account', id });
const farm = { device_cluster: 40, signups_per_hour: 30, disposable_email: true };
const decide = (subject, extra = {}, key) => call('POST', '/v1/decisions', { subject, mode: 'enforce', context: { surface: 'signup' }, ...extra }, key).then((r) => r.body);

test('step-up loop: flagged, completes the step, next decision lets them in', async () => {
  const subject = acct('rush-1'), behavior = { ip_cluster: 300, signups_per_hour: 14, disposable_email: true };
  const first = await decide(subject, { behavior });
  assert.deepEqual([first.class, first.decision, first.action.step], ['inconclusive', 'step_up', 'email_confirm']);
  assert.equal((await call('POST', '/v1/subjects/account/rush-1/verifications', { step: 'email_confirm', result: 'fail' })).status, 200);
  assert.equal((await decide(subject, { behavior })).decision, 'step_up', 'a failed step changes nothing');
  assert.equal((await call('POST', '/v1/subjects/account/rush-1/verifications', { step: 'email_confirm', result: 'pass' })).status, 200);
  const second = await decide(subject, { behavior });
  assert.deepEqual([second.decision, second.reasons.includes('VERIFIED_CONTACT')], ['allow', true]);
  assert.equal((await call('POST', '/v1/subjects/account/rush-1/verifications', { step: 'dance', result: 'pass' })).status, 400);
});

test('a passed human check is remembered as a signal', async () => {
  const subject = acct('kiosk-1');
  assert.equal((await decide(subject, { behavior: { device_cluster: 10 } })).decision, 'step_up');
  await call('POST', '/v1/subjects/account/kiosk-1/verifications', { step: 'human_check', result: 'pass' });
  const after = await decide(subject, { behavior: { device_cluster: 10 } });
  assert.deepEqual([after.decision, after.reasons.includes('HUMAN_CHECK_PASSED')], ['allow', true]);
});

test('block -> appeal softens it -> overturned appeal clears the subject for 30 days', async () => {
  const subject = acct('lab-1');
  const blocked = await decide(subject, { behavior: farm });
  assert.equal(blocked.decision, 'block');
  const appeal = (await call('POST', `/v1/decisions/${blocked.decision_id}/appeal`, { note: 'university lab machine' })).body;
  const during = await decide(subject, { behavior: farm });
  assert.deepEqual([during.decision, during.reasons.includes('APPEAL_OPEN')], ['step_up', true]);
  const resolved = (await call('PATCH', `/v1/appeals/${appeal.id}`, { outcome: 'overturned' })).body;
  assert.equal(resolved.decision_id, blocked.decision_id);
  const cleared = await decide(subject, { behavior: farm });
  assert.deepEqual([cleared.decision, cleared.class, cleared.reasons.includes('OPERATOR_TRUSTED')], ['allow', 'likely_farm', true]);
  assert.deepEqual((await call('GET', '/v1/subjects/account/lab-1')).body.standing, { trusted: true, appeal_open: false });
});

test('upheld appeal restores the block; manual review pass also clears', async () => {
  const subject = acct('farm-9');
  const blocked = await decide(subject, { behavior: farm });
  const appeal = (await call('POST', `/v1/decisions/${blocked.decision_id}/appeal`, {})).body;
  await call('PATCH', `/v1/appeals/${appeal.id}`, { outcome: 'upheld' });
  assert.equal((await decide(subject, { behavior: farm })).decision, 'block');
  await call('POST', '/v1/subjects/account/farm-9/verifications', { step: 'manual_review', result: 'pass' });
  assert.equal((await decide(subject, { behavior: farm })).decision, 'allow');
});

test('webhooks: signed delivery on a flag, once per subject and decision; secret is never shown again', async () => {
  const hook = (await call('PUT', '/v1/webhook-endpoints', { url: hookUrl, events: ['subject.flagged', 'appeal.resolved'] })).body;
  assert.match(hook.secret, /^whsec_/);
  assert.ok(!JSON.stringify((await call('GET', '/v1/policy')).body).includes(hook.secret));
  received.length = 0;
  const v = await decide(acct('hooked-1'), { behavior: farm });
  await decide(acct('hooked-1'), { behavior: farm });
  await decide(acct('fine-1'), {});
  await app.drain();
  assert.equal(received.length, 1, 'one event: the repeat is de-duplicated and allow is not reported');
  const { signature, body } = received[0], event = JSON.parse(body);
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(signature);
  assert.equal(v1, createHmac('sha256', hook.secret).update(`${t}.${body}`).digest('hex'));
  assert.deepEqual([event.type, event.data.decision_id, event.data.decision, event.data.subject.id], ['subject.flagged', v.decision_id, 'block', 'hooked-1']);
});

test('webhook targets must be public https unless private targets are explicitly allowed', async () => {
  const strictApp = createServer(createApp({ store: createMemoryStore(), config: loadConfig({}), apiKeys: 'acme:key-a' }));
  await new Promise((resolve) => strictApp.listen(0, '127.0.0.1', resolve));
  const put = (url) => fetch(`http://127.0.0.1:${strictApp.address().port}/v1/webhook-endpoints`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer key-a' }, body: JSON.stringify({ url }) }).then((r) => r.status);
  for (const url of ['http://example.com/h', 'https://localhost/h', 'https://127.0.0.1/h', 'https://10.0.0.5/h', 'https://192.168.1.1/h', 'https://169.254.169.254/latest', 'not a url']) assert.equal(await put(url), 400, url);
  assert.equal(await put('https://hooks.example.com/abuseguard'), 200);
  await new Promise((resolve) => { strictApp.closeAllConnections(); strictApp.close(resolve); });
});

test('presets: one core, different settings per business', async () => {
  const presets = (await call('GET', '/v1/presets')).body;
  assert.deepEqual(Object.keys(presets).sort(), ['ai_app', 'anti_spying', 'attack_defence', 'general', 'online_store', 'publisher', 'rewards_app', 'scraper_blocking', 'ticketing']);
  for (const p of Object.values(presets)) assert.equal(p.strictness, 'watch', 'every preset starts in watch-only mode');
  assert.equal((await call('PUT', '/v1/policy', { preset: 'casino' }, 'key-t')).status, 400);

  // Ticketing: live check first, agents denied, no slow action. Watch-only until the customer says otherwise.
  await call('PUT', '/v1/policy', { preset: 'ticketing' }, 'key-t');
  const watch = (await call('POST', '/v1/decisions', { subject: acct('t1'), behavior: { device_cluster: 5, disposable_email: true } }, 'key-t')).body;
  assert.deepEqual([watch.decision, watch.action.step, watch.enforced], ['step_up', 'human_check', false]);
  await call('PUT', '/v1/policy', { preset: 'ticketing', strictness: 'gentle' }, 'key-t');
  const gentle = (await call('POST', '/v1/decisions', { subject: acct('t2'), behavior: farm }, 'key-t')).body;
  assert.deepEqual([gentle.class, gentle.decision, gentle.enforced], ['likely_farm', 'step_up', true], 'gentle enforces but never blocks');
  await call('PUT', '/v1/policy', { preset: 'ticketing', strictness: 'strict' }, 'key-t');
  assert.equal((await call('POST', '/v1/decisions', { subject: acct('t3'), behavior: farm }, 'key-t')).body.decision, 'block');

  // Online store: fair share counted in items, not dollars; block is not an allowed action.
  await call('PUT', '/v1/policy', { preset: 'online_store', strictness: 'strict' }, 'key-s');
  await call('POST', '/v1/events', { events: [{ type: 'usage', subject: acct('buyer-1'), usage: { amount: 3 } }] }, 'key-s');
  const buyer = (await call('POST', '/v1/decisions', { subject: acct('buyer-1') }, 'key-s')).body;
  assert.deepEqual([buyer.decision, buyer.cost.attributed_usd, buyer.cost.budget_usd], ['limit', 3, 2]);
  assert.equal((await call('GET', '/v1/subjects/account/buyer-1', undefined, 'key-s')).body.unit, 'items');
  const shopFarm = (await call('POST', '/v1/decisions', { subject: acct('s-farm'), behavior: farm }, 'key-s')).body;
  assert.deepEqual([shopFarm.decision, shopFarm.reasons.includes('ACTION_NOT_PERMITTED')], ['step_up', true]);
  assert.equal((await call('PUT', '/v1/policy', { allowed_actions: ['delete'] }, 'key-s')).status, 400);

  // Anti-spying: "ask to log in" is the first check, and the scraper threshold is lower than the default.
  await call('PUT', '/v1/policy', { preset: 'anti_spying', strictness: 'strict', allowed_actions: ['step_up', 'slow', 'limit'] }, 'key-s');
  const watcher = { subject: { kind: 'session', id: 'spy-1' }, context: { surface: 'content' }, behavior: { rpm: 130, ua: 'library' } };
  const spy = (await call('POST', '/v1/decisions', watcher, 'key-s')).body;
  assert.deepEqual([spy.class, spy.decision, spy.action.step], ['inconclusive', 'step_up', 'proof_of_work']);
  const hot = (await call('POST', '/v1/decisions', { ...watcher, behavior: { rpm: 130, ua: 'library', sequential_ratio: 0.8 } }, 'key-s')).body;
  assert.deepEqual([hot.class, hot.decision], ['suspected_scraper', 'slow'], 'lower threshold in this pack: 0.6 would be needed by default, 0.5 here');
  await call('PUT', '/v1/policy', { preset: 'ticketing', strictness: 'strict', step_up_order: ['login', 'human_check'] }, 'key-s');
  const queue = (await call('POST', '/v1/decisions', { subject: acct('q1'), behavior: { device_cluster: 5, disposable_email: true } }, 'key-s')).body;
  assert.deepEqual([queue.action.step, queue.action.alternatives], ['login', ['human_check', 'manual_review']], 'ask-to-log-in is a rung a company can put first');
});

test('SDK enforces a slow verdict with a rate budget and reports step-ups to a hook', async () => {
  const client = createClient({ baseUrl: base, apiKey: 'key-x', salt: 's', timeoutMs: 2000 });
  const res = () => ({ statusCode: 200, headers: {}, ended: false, setHeader(n, v) { this.headers[n.toLowerCase()] = v; }, end(b) { this.ended = true; this.body = b; } });
  const scraper = { subject: { kind: 'session', id: 'scr-1' }, mode: 'enforce', context: { surface: 'content' }, behavior: { rpm: 700, ua: 'library' } };
  let passed = 0, limited = 0;
  for (let i = 0; i < 12; i++) {
    const r = res();
    await client.middleware(() => scraper)({ headers: {} }, r, () => { passed++; });
    if (r.statusCode === 429) limited++;
  }
  assert.deepEqual([passed, limited], [5, 7], '30 requests a minute with a 10-second burst of 5');
  assert.equal(client.takeToken('k', 30, 0), true);
  assert.equal(client.takeToken('k', 30, 60_000), true, 'tokens refill over time');

  const cached = res();
  const refetcher = { ...scraper, subject: { kind: 'session', id: 'scr-2' }, behavior: { rpm: 700, refetch_unchanged: 0.8, ua: 'browser' } };
  await client.middleware(() => refetcher)({ headers: { 'if-none-match': '"abc"' } }, cached, () => {});
  assert.equal(cached.statusCode, 304, 'conditional re-fetch of unchanged content is answered from cache');

  let hooked = null;
  const input = { subject: { kind: 'account', id: 'su-1' }, mode: 'enforce', context: { surface: 'signup' }, behavior: { ip_cluster: 300, signups_per_hour: 14, disposable_email: true } };
  await client.middleware(() => input, { onStepUp: (req, r, verdict) => { hooked = verdict.action.step; r.end(); } })({ headers: {} }, res(), () => {});
  assert.equal(hooked, 'email_confirm');
  assert.equal(await client.verify(input.subject, 'email_confirm'), true);
  let through = false;
  await client.middleware(() => input)({ headers: {} }, res(), () => { through = true; });
  assert.equal(through, true, 'after the step is verified the same request passes');
});
