import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeHarness } from '../fixtures/harness/fake-harness.js';

test('quick handles separate receipt, applied evidence and completion; wrong expected run is rejected', async () => {
  const harness = new FakeHarness();
  const created = await harness.createSession({ operationId: 'op-create', courierSessionId: 'courier-a' }).receipt;
  assert.equal(created.status, 'accepted'); if (created.status !== 'accepted') return;
  const loaded = await harness.resumeSession({ operationId: 'op-load', sessionRef: created.sessionRef }).receipt;
  assert.equal(loaded.status, 'accepted');
  const started = await harness.start({ operationId: 'op-start', inputId: 'input-a', sessionRef: created.sessionRef, text: 'synthetic', clientRunId: 'run-local-a' }).receipt;
  assert.equal(started.status, 'accepted'); if (started.status !== 'accepted') return;
  const rejected = await harness.steer({ operationId: 'op-steer', inputId: 'input-b', sessionRef: created.sessionRef, expectedRunRef: 'wrong-run', text: 'synthetic' }).receipt;
  assert.deepEqual(rejected, { status: 'rejected', definitelyNotAccepted: true, errorCode: 'stale_run' });
  const steer = harness.steer({ operationId: 'op-steer-2', inputId: 'input-c', sessionRef: created.sessionRef, expectedRunRef: started.runRef!, text: 'changed-work' });
  assert.ok(steer.receipt instanceof Promise); assert.equal((await steer.receipt).status, 'accepted');
  assert.equal(harness.applied[0]!.runRef, started.runRef);
  assert.equal(harness.sessions.get(created.sessionRef)!.activeRun, started.runRef);
});
