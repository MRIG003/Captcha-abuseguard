import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLASSES, DECISIONS, SPEC_VERSION, decide, explain, REASON_TEXT } from '../src/index.js';

export const golden = JSON.parse(readFileSync(new URL('../contracts/golden-vectors.json', import.meta.url), 'utf8'));

/** Shared by the conformance suite: assert one verdict against one vector's expectation. */
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

test('golden vector file is well formed', () => {
  assert.equal(golden.spec_version, SPEC_VERSION);
  assert.ok(golden.vectors.length >= 45, `only ${golden.vectors.length} vectors`);
  assert.equal(new Set(golden.vectors.map((v) => v.id)).size, golden.vectors.length, 'duplicate ids');
  for (const klass of CLASSES) assert.ok(golden.vectors.some((v) => v.expect.class === klass), `no vector for class ${klass}`);
  for (const decision of DECISIONS) assert.ok(golden.vectors.some((v) => v.expect.decision === decision), `no vector for ${decision}`);
});

for (const vector of golden.vectors) {
  test(`golden: ${vector.id}`, () => {
    const verdict = decide(vector.input);
    assertVector(verdict, vector.expect, vector.id);
    for (const code of verdict.reasons) assert.ok(code in REASON_TEXT, `unregistered reason code ${code}`);
    if (verdict.decision !== 'allow') {
      assert.ok(verdict.recovery?.appeal === true && verdict.recovery.paths.includes('appeal'), 'non-allow needs a recovery path');
      assert.ok(verdict.action, 'non-allow needs a bounded action');
    }
    if (verdict.class === 'inconclusive') assert.ok(['allow', 'step_up'].includes(verdict.decision), 'inconclusive must not block, slow or limit');
    if (verdict.action?.type === 'step_up') assert.ok(verdict.action.alternatives.length >= 1, 'step-up needs an alternative path');
    const text = explain(verdict);
    assert.ok(text.headline && text.reasons.every((r) => r.text && r.text !== r.code));
  });
}

test('decide is deterministic and does not mutate its input', () => {
  for (const vector of golden.vectors) {
    const before = JSON.stringify(vector.input);
    assert.deepEqual(decide(vector.input), decide(JSON.parse(before)));
    assert.equal(JSON.stringify(vector.input), before);
  }
});
