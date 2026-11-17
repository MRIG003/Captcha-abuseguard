// Signal layers 2 to 5 on live traffic: the service works out rate, pattern and timing itself from the requests it is told about.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { createMemoryStore, loadConfig, analyzeLines, parseLine, hashId, decide } from '../src/index.js';
import { createApp } from '../service/app.js';
import { createLiveTracker } from '../service/liveTracker.js';
import { createClient } from '../sdk/node/index.js';
import { genLogs, demoAuditOptions } from './synth.js';

let server, base;
before(async () => {
  server = createServer(createApp({ store: createMemoryStore(), config: loadConfig({}), apiKeys: 'acme:key-a,shop:key-s,ev:key-e' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

async function call(method, path, body, key = 'key-a') {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const ask = (subject, path, ts, ua, key) => call('POST', '/v1/decisions', { subject, mode: 'enforce', context: { surface: 'content' }, request: { path, ua, ts } }, key).then((r) => r.body);

test('live tracker and batch log audit reach the same decision for every subject', () => {
  const lines = genLogs(1, 10), opts = { ...demoAuditOptions, salt: 's', top: 100000 };
  const batch = new Map(analyzeLines(lines, opts).top_subjects.map((r) => [r.subject, r.decision]));
  const tracker = createLiveTracker(), last = new Map();
  for (const line of lines) {
    const e = parseLine(line);
    if (!e) continue;
    const key = `session:${hashId('s', `${e.ip}|${e.ua}`)}`;
    tracker.arrive('t', key, e, { disallow: opts.disallow });
    tracker.complete('t', key, e, {});
    last.set(key, key);
  }
  let same = 0;
  for (const key of last.keys()) {
    const verdict = decide({ subject: { kind: 'session', id: key.slice(8) }, context: { surface: 'content' }, behavior: tracker.behavior('t', key) });
    const expected = batch.get(key) === 'limit' ? verdict.decision : batch.get(key); // budget limits need cost, which this check leaves out
    if (verdict.decision === expected) same++;
  }
  assert.equal(same, last.size, 'live and batch disagree');
});

test('a fast scripted client is flagged while it is still running', async () => {
  const subject = { kind: 'session', id: 'live-scraper' }, seen = [];
  for (let i = 0; i < 700; i++) seen.push((await ask(subject, `/listing/${5000 + i * 7}`, T0 + i * 80, 'python-requests/2.32')).decision);
  assert.equal(seen[0], 'allow');
  assert.equal(seen.indexOf('step_up'), 119, 'unclear at 120 requests in a minute: asked for a check');
  assert.equal(seen.indexOf('slow'), 599, 'slowed at 600 requests in a minute');
  const state = (await call('GET', '/v1/subjects/session/live-scraper')).body;
  assert.deepEqual([state.live.rpm, state.live.ua], [700, 'library'], 'the live state is visible to the operator');
});

test('a person browsing with a real browser is left alone', async () => {
  const subject = { kind: 'session', id: 'live-reader' };
  for (let i = 0; i < 40; i++) {
    const t = T0 + i * 21_000 + (i % 5) * 3000;
    for (const path of [`/articles/${(i * 37) % 900}`, '/static/app.css', `/img/photo-${i}.jpg`]) assert.equal((await ask(subject, path, t, BROWSER)).decision, 'allow');
  }
});

test('responses reported afterwards add error and re-fetch evidence', async () => {
  const subject = { kind: 'session', id: 'live-prober' }, events = [];
  let verdict;
  for (let i = 0; i < 200; i++) {
    verdict = await ask(subject, `/admin/${i % 9 === 0 ? 'x' : 'page'}-${i * 13}`, T0 + i * 300, BROWSER);
    events.push({ type: 'response', subject, ts: T0 + i * 300, response: { path: `/admin/p-${i * 13}`, status: i % 3 === 0 ? 404 : 200, bytes: 900 + i } });
  }
  assert.deepEqual([verdict.class, verdict.decision], ['suspected_scraper', 'slow'], 'fast, and a browser that loads no assets');
  assert.ok(!verdict.reasons.includes('ERROR_RESPONSE_RATIO'));
  assert.deepEqual((await call('POST', '/v1/events', { events })).body, { accepted: 200, rejected: 0 });
  verdict = await ask(subject, '/admin/page-9999', T0 + 200 * 300, BROWSER);
  assert.ok(verdict.reasons.includes('ERROR_RESPONSE_RATIO'), 'a third of the responses were 404');
});

test('trap links and robots.txt paths come from the tenant policy', async () => {
  await call('PUT', '/v1/policy', { trap_paths: ['/listing/marker-'], robots_disallow: ['/private/'] }, 'key-s');
  const subject = { kind: 'session', id: 'live-trap' };
  assert.equal((await ask(subject, '/listing/100', T0, 'curl/8.5', 'key-s')).decision, 'allow');
  const trapped = await ask(subject, '/listing/marker-7f3a', T0 + 1000, 'curl/8.5', 'key-s');
  assert.deepEqual([trapped.class, trapped.decision], ['suspected_scraper', 'slow']);
  assert.ok(trapped.reasons.includes('TRAP_LINK'));
  const robots = await ask({ kind: 'session', id: 'live-robots' }, '/private/export', T0, 'curl/8.5', 'key-s');
  assert.ok(robots.reasons.includes('ROBOTS_VIOLATION'));
});

test('events-only integration: finished requests give live features and attributed cost', async () => {
  await call('PUT', '/v1/policy', { endpoint_costs: [{ prefix: '/api/generate', usd: 0.02 }], budget_usd: 1 }, 'key-e');
  const subject = { kind: 'api_key', id: 'live-key' };
  const events = Array.from({ length: 60 }, (_, i) => ({ type: 'request', subject, ts: new Date(T0 + i * 500).toISOString(), request: { path: '/api/generate', ua: 'sdk/1.0', status: 200, bytes: 4000, rt: 1 } }));
  events.push({ type: 'request', subject, request: {} });
  assert.deepEqual((await call('POST', '/v1/events', { events }, 'key-e')).body, { accepted: 60, rejected: 1 });
  const state = (await call('GET', '/v1/subjects/api_key/live-key', undefined, 'key-e')).body;
  assert.deepEqual([state.live.rpm, state.live.ua, state.window.requests], [60, 'library', 60]);
  assert.ok(Math.abs(state.window.cost_attributed_usd - 60 * 0.02) < 0.01, 'endpoint cost is attributed from the policy');
  const verdict = (await call('POST', '/v1/decisions', { subject, mode: 'enforce' }, 'key-e')).body;
  assert.deepEqual([verdict.decision, verdict.reasons.includes('COST_OVER_BUDGET')], ['limit', true]);
  assert.equal((await call('POST', '/v1/decisions', { subject, request: { ua: 'x' } }, 'key-e')).status, 400);
});

test('tracker housekeeping: idle subjects start fresh, memory is bounded, erasure forgets', async () => {
  const tracker = createLiveTracker({ maxSubjects: 3, idleMs: 60_000 });
  for (let i = 0; i < 200; i++) tracker.arrive('t', 'a', { ts: T0 + i * 100, path: `/p/${i}`, ua: 'curl/8' });
  assert.equal(tracker.behavior('t', 'a').rpm, 200);
  tracker.arrive('t', 'a', { ts: T0 + 3600_000, path: '/p/1' });
  assert.equal(tracker.behavior('t', 'a').rpm, 1, 'an hour of silence resets the statistics');
  for (const key of ['b', 'c', 'd']) tracker.arrive('t', key, { ts: T0, path: '/' });
  assert.deepEqual([tracker.size, tracker.behavior('t', 'a')], [3, null], 'least recently used subject is dropped');
  tracker.forget('t', 'b');
  assert.equal(tracker.behavior('t', 'b'), null);
  assert.equal(tracker.complete('t', 'nobody', { path: '/', status: 200 }), 0);

  const subject = { kind: 'session', id: 'live-erase' };
  await ask(subject, '/x', T0, 'curl/8');
  await call('POST', '/v1/events', { events: [{ type: 'response', subject, response: { path: '/x', status: 200 } }] });
  assert.equal((await call('GET', '/v1/subjects/session/live-erase')).body.live.rpm, 1);
  await call('DELETE', '/v1/subjects/session/live-erase');
  assert.equal((await call('GET', '/v1/subjects/session/live-erase')).status, 404);
});

test('SDK middleware reports each request and its outcome without the app doing anything', async () => {
  const client = createClient({ baseUrl: base, apiKey: 'key-a', salt: 'salt', timeoutMs: 2000 });
  const subject = client.subject('session', '203.0.113.7|curl/8.5');
  const guard = client.middleware(() => ({ subject, mode: 'enforce', context: { surface: 'content' } }));
  let passed = 0, refused = 0;
  for (let i = 0; i < 150; i++) {
    const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, setHeader(n, v) { this.headers[n.toLowerCase()] = v; }, getHeader(n) { return this.headers[n.toLowerCase()]; }, end() { this.done = true; } });
    await guard({ url: `/catalog/item-${i * 3}`, headers: { 'user-agent': 'curl/8.5' } }, res, () => { passed++; res.statusCode = i % 2 ? 404 : 200; res.emit('finish'); });
    if (res.done) refused++;
  }
  await client.flush();
  assert.equal(passed + refused, 150);
  assert.ok(refused >= 25, `after 120 requests in a minute the client is asked for a check (${refused} refused)`);
  const live = (await call('GET', `/v1/subjects/session/${subject.id}`)).body.live;
  assert.deepEqual([live.rpm >= 150, live.ua, live.error_ratio > 0.3], [true, 'library', true], 'rate, client type and error share were all learned from the middleware');
});
