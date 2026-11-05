import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from '../fixtures/rig.js';

test('groups and unknown scopes have no stored body, conversation, Harness action or chat reply', async () => {
  const r = rig();
  try {
    for (const event of [{ ...r.platform.inbound('group-private-body'), conversationType: 'group' as const },
      { ...r.platform.inbound(), platformScope: 'other-scope' }, { ...r.platform.inbound(), conversationType: 'unknown' as const }]) {
      assert.equal((await r.courier.accept(event)).status, 'ignored');
    }
    assert.equal(r.harness.calls.length, 0); assert.equal(r.count('platform_conversations'), 0); assert.equal(r.count('inputs'), 0);
    assert.equal(r.platform.acknowledgements.length, 3); assert.equal(r.platform.visible.length, 0);
  } finally { await r.dispose(); }
});
test('unsupported private content gets one limitation; missing identity never executes', async () => {
  const r = rig();
  try {
    const empty = r.platform.inbound('   ');
    await r.courier.accept(empty); await r.courier.accept({ ...empty, transportMessageId: 'redelivery' });
    await r.courier.accept({ ...r.platform.inbound(), contentType: 'image' });
    const missing = r.platform.inbound(); delete missing.originalMessageId;
    assert.equal((await r.courier.accept(missing)).status, 'rejected');
    await r.courier.flush();
    assert.equal(r.harness.count('start'), 0); assert.equal(r.platform.visible.length, 2);
  } finally { await r.dispose(); }
});
test('ACK follows durable ledger registration and precedes every Harness modifying call',async()=>{
  const r=rig();try{
    const ack=r.platform.ack.bind(r.platform);
    r.platform.ack=async id=>{assert.equal(r.count('inputs'),1);assert.equal(r.harness.calls.length,0);await ack(id);};
    assert.equal((await r.courier.accept(r.platform.inbound())).status,'accepted');
  }finally{await r.dispose();}
});
