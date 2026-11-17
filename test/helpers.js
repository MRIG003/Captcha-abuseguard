// Shared test helpers: golden vectors, vector assertion (C2) and response-shape assertion (C1).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLASSES, DECISIONS, SPEC_VERSION, REASON_TEXT } from '../src/index.js';

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
