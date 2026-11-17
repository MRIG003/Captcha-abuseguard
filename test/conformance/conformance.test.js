// Shared conformance suite (contracts/CONFORMANCE.md).
// AG_CONFORMANCE_URL    test another server implementation instead of the reference mock (fault tests are skipped).
// AG_CONFORMANCE_CLIENT path to a module exporting `assess(baseUrl, input, opts)` to test a JS/TS SDK.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { golden, assertVector, assertShape } from '../helpers.js';
import { startMockServer } from './mockServer.js';

const external = process.env.AG_CONFORMANCE_URL;
const { assess } = process.env.AG_CONFORMANCE_CLIENT
  ? await import(pathToFileURL(process.env.AG_CONFORMANCE_CLIENT).href)
  : await import('./refClient.js');
let server, url;
before(async () => { if (external) url = external; else { server = await startMockServer(); url = server.url; } });
after(async () => { await server?.close(); });

const farm = golden.vectors.find((v) => v.id === 'farm-01-device-cluster-large').input;


test('C1+C2 shapes and decision parity on every golden vector over HTTP', async () => {
  for (const vector of golden.vectors) {
    const verdict = await assess(url, vector.input, { timeoutMs: 2000 });
    assertShape(verdict);
    assertVector(verdict, vector.expect, vector.id);
    assert.match(verdict.decision_id, /^dec_/);
  }
});

test('C3 timeout fails open: allow, ENGINE_UNAVAILABLE, not enforced', { skip: !!external }, async () => {
  const t0 = performance.now();
  const verdict = await assess(url, farm, { timeoutMs: 50, headers: { 'x-ag-test-delay': '500' } });
  assert.ok(performance.now() - t0 < 400, 'client must not wait for the slow server');
  assertShape(verdict);
  assert.deepEqual([verdict.decision, verdict.enforced, verdict.reasons], ['allow', false, ['ENGINE_UNAVAILABLE']]);
});

test('C4 fail-closed degrades to a step-up with a recovery path, never a block', { skip: !!external }, async () => {
  for (const headers of [{ 'x-ag-test-delay': '500' }, { 'x-ag-test-fail': '503' }]) {
    const verdict = await assess(url, farm, { timeoutMs: 50, failMode: 'closed', headers });
    assertShape(verdict);
    assert.equal(verdict.decision, 'step_up');
    assert.ok(verdict.action.alternatives.includes('manual_review'));
  }
});

test('C5 server error and unreachable host fall back without throwing', { skip: !!external }, async () => {
  assert.equal((await assess(url, farm, { headers: { 'x-ag-test-fail': '500' } })).decision, 'allow');
  assert.equal((await assess('http://127.0.0.1:9', farm, { timeoutMs: 200 })).reasons[0], 'ENGINE_UNAVAILABLE');
});

test('C6 signal-provider failure: decision still returned, PROVIDER_DEGRADED, block downgraded', async () => {
  const verdict = await assess(url, { ...farm, providers: { stripe_radar: 'timeout', verisoul: 'ok' } }, { timeoutMs: 2000 });
  assertShape(verdict);
  assert.ok(verdict.reasons.includes('PROVIDER_DEGRADED'));
  assert.deepEqual([verdict.class, verdict.decision], ['likely_farm', 'step_up']);
  assert.ok(verdict.confidence <= 0.7);
});

test('C7 error model: 4xx are problem+json and are surfaced, not swallowed', async () => {
  const bad = await assess(url, { behavior: {} }, { timeoutMs: 2000 });
  assert.equal(bad.status, 400);
  for (const key of ['type', 'title', 'status']) assert.ok(key in bad.error, `problem document needs ${key}`);
  const unauth = await assess(url, farm, { timeoutMs: 2000, apiKey: '' });
  assert.equal(unauth.status, 401);
});

test('C8 shadow mode over HTTP reports the decision but enforces nothing', async () => {
  const verdict = await assess(url, { ...farm, mode: 'shadow' }, { timeoutMs: 2000 });
  assert.deepEqual([verdict.decision, verdict.enforced, verdict.effective_decision], ['block', false, 'allow']);
});
