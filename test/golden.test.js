import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLASSES, DECISIONS, SPEC_VERSION, decide, explain, REASON_TEXT } from '../src/index.js';
import { golden, assertVector } from './helpers.js';


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
