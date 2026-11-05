import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from '../fixtures/rig.js';

test('Q-01 three rounds retain the original Harness context across normal restart', async () => {
  const r = rig();
  try {
    for (let round = 0; round < 3; round++) {
      const result = await r.courier.accept(r.platform.inbound(round === 0 ? 'synthetic-marker-a' : 'recall prior marker'));
      assert.equal(result.status, 'accepted');
      const [ref, state] = [...r.harness.sessions.entries()][0]!;
      assert.equal(state.history[0], 'synthetic-marker-a');
      r.harness.message(ref, state.activeRun!, 'final', state.history[0]!); r.harness.complete(ref);
      await r.courier.flush();
      if (round === 0) await r.restart();
    }
    assert.equal(r.harness.count('create'), 1); assert.equal(r.harness.count('start'), 3);
    assert.equal(r.platform.visible.length, 3); assert.equal(r.count('courier_sessions'), 1);
  } finally { await r.dispose(); }
});
test('Q-02 two interleaved private conversations have separate context and recipients', async () => {
  const r = rig();
  try {
    await r.courier.accept(r.platform.inbound('marker-a', 'synthetic-private-a'));
    await r.courier.accept(r.platform.inbound('marker-b', 'synthetic-private-b'));
    assert.equal(r.harness.sessions.size, 2);
    for (const [ref, state] of r.harness.sessions) {
      assert.equal(state.history.length, 1);
      r.harness.message(ref, state.activeRun!, 'final', state.history[0]!); r.harness.complete(ref);
    }
    await r.courier.flush();
    for (const message of r.platform.visible) assert.equal(message.payload, message.recipient.platformConversationId.endsWith('-a') ? 'marker-a' : 'marker-b');
  } finally { await r.dispose(); }
});
test('Q-04 two same-text new messages actually change the original running task before completion', async () => {
  const r = rig();
  try {
    await r.courier.accept(r.platform.inbound('original'));
    const [ref, state] = [...r.harness.sessions.entries()][0]!, runRef = state.activeRun;
    await r.courier.accept(r.platform.inbound('change work')); await r.courier.accept(r.platform.inbound('change work'));
    assert.equal(r.harness.count('start'), 1); assert.equal(r.harness.count('steer'), 2);
    assert.equal(r.harness.applied.length, 2); assert.ok(r.harness.applied.every(item => item.runRef === runRef));
    assert.deepEqual(state.history, ['original', 'change work', 'change work']); assert.equal(state.activeRun, runRef);
    assert.equal(r.platform.visible.length, 0);
    r.harness.message(ref, runRef!, 'final', state.history.join('|')); r.harness.complete(ref); await r.courier.flush();
    assert.equal(r.platform.visible.length, 1); assert.match(r.platform.visible[0]!.payload, /change work\|change work/);
  } finally { await r.dispose(); }
});
test('Q-05 non-timely targets are rejected before creating a Harness session', async () => {
  for (const steerMode of ['queued', 'late', 'unsupported'] as const) {
    const r = rig(); r.harness.options.steerMode = steerMode;
    try { assert.equal((await r.courier.accept(r.platform.inbound())).status, 'rejected'); assert.equal(r.harness.count('create'), 0); }
    finally { await r.dispose(); }
  }
});
test('concurrent first inputs reserve only one Harness binding without a fallback queue', async () => {
  const r=rig();
  try {
    await Promise.all([r.courier.accept(r.platform.inbound('first')),r.courier.accept(r.platform.inbound('racing first'))]);
    assert.equal(r.harness.count('create'),1);assert.equal(r.count('harness_bindings'),1);
    assert.equal(r.harness.count('start'),1);assert.equal(r.harness.count('steer'),0);
  } finally {await r.dispose();}
});
test('explicit steer rejection and unknown receipt never become another start', async () => {
  for (const status of ['rejected','unknown'] as const) {
    const r=rig();
    try {
      await r.courier.accept(r.platform.inbound('first'));
      r.harness.options.receiptStatus=status;
      assert.equal((await r.courier.accept(r.platform.inbound('supplement'))).status,status);
      assert.equal(r.harness.count('start'),1);assert.equal(r.harness.count('steer'),1);
    } finally {await r.dispose();}
  }
});
