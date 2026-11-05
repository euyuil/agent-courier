import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAdmission } from '../../src/adapters/harness/admission.js';
import { contextFingerprint, evidenceValid } from '../../src/domain/capabilities.js';
import { FakeHarness } from '../fixtures/harness/fake-harness.js';
import { VirtualClock } from '../fixtures/clock.js';

test('canonical context treats authorization collections as sets and excludes unrelated settings', () => {
  const context = { targetRef: 'synthetic', cliVersion: '1', transportKind: 'synthetic', authorizationScope: ['b', 'a', 'a'], limitProfile: { b: 2, a: 1 } };
  assert.equal(contextFingerprint(context), contextFingerprint({ ...context, authorizationScope: ['a', 'b'], limitProfile: { a: 1, b: 2 } }));
  assert.notEqual(contextFingerprint(context), contextFingerprint({ ...context, cliVersion: '2' }));
});
test('admission checks expiry boundaries, future checks, revocation, scope, kind and context on every call', async () => {
  const clock = new VirtualClock(), harness = new FakeHarness({ clock }); const report = await harness.probe('synthetic');
  const evidence = report.evidenceRefs[0]!;
  assertAdmission(report, clock.now()); clock.advance(100000000000); assertAdmission(report, clock.now());
  for (const change of [{ expiresAt: clock.now() }, { checkedAt: clock.now() + 1 },
    { expiresAt: evidence.checkedAt }, { invalidatedAt: clock.now() }, { outcome: 'failed' as const },
    { adapterVersion: 'changed' }, { productVersion: 'changed' }, { contextFingerprint: 'changed' },
    { kind: 'harness' as const }, { scope: {} }]) {
    assert.throws(() => assertAdmission({ ...report, evidenceRefs: [{ ...evidence, ...change }] }, clock.now()));
  }
  assert.equal(evidenceValid({ ...evidence, expiresAt: clock.now() + 1 }, report, clock.now(), 'timelySteer', ['running', 'waiting_input']), true);
  assert.throws(() => assertAdmission({ ...report, kind: 'harness' }, clock.now()));
  assert.throws(() => assertAdmission({ ...report, contextFingerprint: '' }, clock.now()));
  const partial = { ...evidence, scope: { timelySteer: { states: ['running'], limitations: [] } } };
  assert.throws(() => assertAdmission({ ...report, evidenceRefs: [partial] }, clock.now(), ['timelySteer']));
  const renewed = { ...evidence, scope: { timelySteer: evidence.scope.timelySteer! } };
  assertAdmission({ ...report, evidenceRefs: [renewed] }, clock.now(), ['timelySteer']);
  assert.throws(() => assertAdmission({ ...report, evidenceRefs: [renewed] }, clock.now()));
});
test('queued, late and absent steer cannot pass; probe has no modifying calls', async () => {
  for (const steerMode of ['queued', 'late', 'unsupported'] as const) {
    const harness = new FakeHarness({ steerMode });
    const report = await harness.probe('synthetic');
    assert.throws(() => assertAdmission(report, Date.now()), { message: 'steer_unsupported' });
    assert.equal(harness.calls.length, 0);
  }
});
