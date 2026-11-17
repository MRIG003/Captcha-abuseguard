import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createMemoryStore, loadConfig, hashId, fallbackDecision } from '../src/index.js';
import { createApp } from '../service/app.js';
import { createClient, assess, toHttp, hashId as sdkHash, fallbackVerdict } from '../sdk/node/index.js';
import { golden, assertVector, assertShape } from './helpers.js';

let server, base;
before(async () => {
  server = createServer(createApp({ store: createMemoryStore(), config: loadConfig({}), apiKeys: 'acme:key-a' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

const fakeRes = () => ({ statusCode: 200, headers: {}, body: undefined, ended: false,
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, end(body) { this.ended = true; this.body = body; } });

test('SDK hash and fallback are identical to the core', () => {
  for (const raw of ['sk_live_abc', 'user@example.com', '203.0.113.9|curl/8.5', '', 'ünïcode']) assert.equal(sdkHash('salt-1', raw), hashId('salt-1', raw));
  for (const mode of ['open', 'closed']) {
    const core = fallbackDecision({ kind: 'account', id: 'x' }, { failMode: mode }), sdk = fallbackVerdict({ kind: 'account', id: 'x' }, mode);
    for (const key of ['class', 'decision', 'enforced', 'effective_decision', 'reasons', 'action', 'recovery']) assert.deepEqual(sdk[key], core[key], `${mode} ${key}`);
  }
});

test('SDK against the real service: parity on all golden vectors', async () => {
  const client = createClient({ baseUrl: base, apiKey: 'key-a', salt: 's', timeoutMs: 2000 });
  for (const vector of golden.vectors) {
    const verdict = await client.assess(vector.input);
    assertShape(verdict);
    assertVector(verdict, vector.expect, vector.id);
  }
});

test('SDK never throws: unreachable host, bad key, bad input', async () => {
  const subject = { kind: 'account', id: 'x' };
  assert.deepEqual((await assess('http://127.0.0.1:9', { subject }, { timeoutMs: 200 })).reasons, ['ENGINE_UNAVAILABLE']);
  assert.equal((await assess('http://127.0.0.1:9', { subject }, { timeoutMs: 200, failMode: 'closed' })).decision, 'step_up');
  assert.equal((await assess(base, { subject }, { apiKey: 'nope', timeoutMs: 2000 })).status, 401);
  assert.equal((await assess(base, {}, { apiKey: 'key-a', timeoutMs: 2000 })).status, 400);
  assert.throws(() => createClient({ baseUrl: base }), /needs baseUrl, apiKey and salt/);
});

test('toHttp maps enforced verdicts and leaves shadow verdicts alone', () => {
  const v = (decision, action, enforced = true) => ({ decision, action, enforced, reasons: [], recovery: { paths: ['appeal'] } });
  assert.equal(toHttp(v('block', { type: 'block' }, false)), null, 'shadow never changes the response');
  assert.equal(toHttp(v('allow', null)), null);
  assert.equal(toHttp({ error: {}, status: 400 }), null);
  assert.deepEqual([toHttp(v('limit', { retry_after_s: 86400 })).status, toHttp(v('limit', { retry_after_s: 86400 })).headers['retry-after']], [429, '86400']);
  assert.equal(toHttp(v('slow', { mode: 'cached' })).status, 304);
  assert.equal(toHttp(v('slow', { mode: 'rate_budget', retry_after_s: 2 })).status, 429);
  assert.equal(toHttp(v('step_up', { step: 'email_confirm' })).status, 403);
  assert.equal(toHttp(v('block', { type: 'block' })).status, 403);
});

test('middleware: tracked usage drives a per-human limit; shadow passes through with a header', async () => {
  const client = createClient({ baseUrl: base, apiKey: 'key-a', salt: 'tenant-salt', timeoutMs: 2000 });
  const users = ['u1', 'u2', 'u3'].map((id) => client.subject('account', id));
  for (const subject of users) {
    client.track({ type: 'link', subject, link: { link_type: 'device', value_hash: client.hash('laptop-1') } });
    client.track({ type: 'usage', subject, usage: { requests: 5, direct_usd: 2 } });
  }
  await client.flush();
  assert.ok(!JSON.stringify(users).includes('u1'), 'raw ids never leave the process');

  const run = async (mode) => {
    const res = fakeRes(); let nexted = false; const req = {};
    await client.middleware(() => ({ subject: users[0], mode }))(req, res, () => { nexted = true; });
    return { res, nexted, req };
  };
  const shadow = await run('shadow');
  assert.equal(shadow.nexted, true);
  assert.match(shadow.res.headers['ag-decision'], /^limit; class=legitimate_heavy_user; enforced=false$/);
  const enforce = await run('enforce');
  assert.deepEqual([enforce.nexted, enforce.res.statusCode, enforce.res.headers['retry-after']], [false, 429, '86400']);
  assert.ok(JSON.parse(enforce.res.body).recovery.paths.includes('appeal'));

  const skipped = fakeRes(); let passed = false;
  await client.middleware(() => { throw new Error('identify failed'); })({}, skipped, () => { passed = true; });
  assert.equal(passed, true, 'a failing identify function must not break the request');
});
