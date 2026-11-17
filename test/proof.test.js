// Measurable proof tests for the advantages claimed in docs/GAP-ANALYSIS.md (P1..P8).
// Synthetic data only: these prove the mechanism, not real-world accuracy. Pilot targets are in the same doc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, analyzeLines } from '../src/index.js';
import { genSubjects, genLogs, demoAuditOptions } from './synth.js';

const N = 10000;
const subjects = genSubjects(42, N);
const THIRD_PARTY = new Set(['risk.multi_account', 'network.shared_env', 'network.proxy', 'human.liveness']);
const pct = (x) => `${(x * 100).toFixed(2)}%`;

/** Friction or worse that is not a plain budget limit. A budget limit on an over-budget free user is policy, not an error. */
const flagged = (v) => v.decision !== 'allow' && v.decision !== 'limit';
const hard = (v) => v.decision === 'block' || v.decision === 'slow';

function run(transform = (input) => input) {
  const rows = subjects.map((s) => ({ ...s, v: decide(transform(s.input)) }));
  const of = (group) => rows.filter((r) => r.truth.group === group);
  const rate = (list, pred) => (list.length ? list.filter(pred).length / list.length : 0);
  const legit = rows.filter((r) => !r.truth.abusive), abusive = rows.filter((r) => r.truth.abusive);
  const flaggedRows = rows.filter((r) => flagged(r.v));
  const farm = of('farm'), farmCost = farm.reduce((a, r) => a + r.truth.ownCostUsd, 0);
  return {
    rows, of, rate, legit, abusive,
    precision: flaggedRows.filter((r) => r.truth.abusive).length / flaggedRows.length,
    recall: rate(abusive, (r) => r.v.decision !== 'allow'),
    farmRecall: rate(farm, (r) => r.v.decision !== 'allow'),
    farmCost,
    farmCaught: farm.filter((r) => r.v.decision !== 'allow').reduce((a, r) => a + r.truth.ownCostUsd, 0),
    perKeyCaught: farm.filter((r) => r.truth.ownCostUsd >= r.input.cost.budget_usd).reduce((a, r) => a + r.truth.ownCostUsd, 0),
  };
}
const base = run();

test('P1 paying users: under 1% flagged, none blocked or slowed', (t) => {
  const paying = base.of('legit_paying');
  const fp = base.rate(paying, (r) => flagged(r.v));
  t.diagnostic(`paying n=${paying.length} flagged=${pct(fp)}`);
  assert.ok(paying.length > 500);
  assert.ok(fp < 0.01);
  assert.equal(paying.filter((r) => hard(r.v)).length, 0);
});

test('P2 shared-IP legitimate users: no block or slow, friction under 5%; an IP limiter flags them all', (t) => {
  const shared = base.legit.filter((r) => r.truth.sharedIp);
  const friction = base.rate(shared, (r) => flagged(r.v));
  const ipLimiter = base.rate(shared, (r) => (r.input.behavior.ip_cluster ?? 0) >= 20); // baseline: limit by subjects per IP
  t.diagnostic(`shared-IP legit n=${shared.length} hard=0 friction=${pct(friction)} ip-limiter baseline=${pct(ipLimiter)}`);
  assert.ok(shared.length > 300);
  assert.equal(shared.filter((r) => hard(r.v)).length, 0);
  assert.ok(friction < 0.05);
  assert.ok(ipLimiter > 0.5);
});

test('P3 cluster budgets catch farm cost that per-identifier budgets miss', (t) => {
  const share = base.farmCaught / base.farmCost, perKey = base.perKeyCaught / base.farmCost;
  t.diagnostic(`farm cost $${base.farmCost.toFixed(0)}: caught ${pct(share)} vs per-identifier budget ${pct(perKey)}; ` +
    `$${((base.farmCaught / N) * 1000).toFixed(0)} per 1,000 subjects vs $${((base.perKeyCaught / N) * 1000).toFixed(0)}`);
  assert.ok(share >= 0.8);
  assert.ok(perKey < 0.1);
});

test('P4 recovery invariants hold for every decision', () => {
  for (const { v, truth } of base.rows) {
    if (v.decision !== 'allow') assert.ok(v.recovery?.paths.includes('appeal') && v.action, 'non-allow without recovery or action');
    if (v.class === 'inconclusive') assert.ok(['allow', 'step_up'].includes(v.decision));
    if (v.action?.type === 'step_up') assert.ok(v.action.alternatives.includes('manual_review'), 'step-up without non-visual alternative');
    if (v.class === 'search_engine') assert.equal(v.decision, 'allow');
    if (v.class === 'assistive_tool') assert.ok(['allow', 'limit'].includes(v.decision));
    if (['search_engine', 'assistive', 'agent'].includes(truth.group)) assert.ok(!hard(v) && v.decision !== 'step_up', `${truth.group} got ${v.decision}`);
  }
});

test('P5 without third-party fraud signals: precision >= 0.95, farm recall >= 0.6, paying flagged < 1%', (t) => {
  const own = run((input) => ({ ...input, signals: (input.signals ?? []).filter((s) => !THIRD_PARTY.has(s.type)) }));
  const fp = own.rate(own.of('legit_paying'), (r) => flagged(r.v));
  t.diagnostic(`own signals only: precision=${pct(own.precision)} farm recall=${pct(own.farmRecall)} paying flagged=${pct(fp)} ` +
    `(with signals: precision=${pct(base.precision)} farm recall=${pct(base.farmRecall)})`);
  assert.ok(own.precision >= 0.95);
  assert.ok(own.farmRecall >= 0.6);
  assert.ok(fp < 0.01);
});

test('P6 time to first decision: 10k decisions and a 30-minute log audit', (t) => {
  let t0 = performance.now();
  for (const s of subjects) decide(s.input);
  const perDecisionMs = (performance.now() - t0) / N;
  const lines = genLogs(1, 30);
  t0 = performance.now();
  const report = analyzeLines(lines, demoAuditOptions);
  const auditMs = performance.now() - t0;
  t.diagnostic(`decide ${perDecisionMs.toFixed(4)} ms avg; audit of ${lines.length} lines in ${auditMs.toFixed(0)} ms`);
  assert.ok(perDecisionMs < 0.5);
  assert.ok(auditMs < 5000);
  assert.ok(report.estimated_savings_usd > 0);
});

test('P7 provider outage: no blocks, confidence capped', () => {
  const down = run((input) => ({ ...input, providers: { provider_x: 'down' } }));
  for (const { v } of down.rows) {
    if (v.class === 'likely_farm') assert.notEqual(v.decision, 'block');
    if (v.class !== 'delegated_agent') assert.ok(v.confidence <= 0.7 || v.decision === 'allow');
    assert.ok(v.reasons.includes('PROVIDER_DEGRADED'));
  }
});

test('P8 overall: precision >= 0.95, legitimate free users flagged < 1.5%', (t) => {
  const free = base.of('legit_free');
  const friction = base.rate(free, (r) => flagged(r.v));
  t.diagnostic(`precision=${pct(base.precision)} abusive recall=${pct(base.recall)} legit-free flagged=${pct(friction)} ` +
    `scraper recall=${pct(base.rate(base.of('scraper'), (r) => r.v.decision !== 'allow'))}`);
  assert.ok(base.precision >= 0.95);
  assert.ok(friction < 0.015);
});
