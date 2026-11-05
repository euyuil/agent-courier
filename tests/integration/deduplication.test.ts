import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from '../fixtures/rig.js';

test('Q-06 ten concurrent original-message retries submit one start; a new ID with same text is a steer', async () => {
  const r=rig();
  try {
    const event=r.platform.inbound('same text');
    await Promise.all(Array.from({length:10},(_,index)=>r.courier.accept({...event,transportMessageId:`synthetic-transport-${index}`})));
    assert.equal(r.harness.count('start'),1);assert.equal(r.count('inputs'),1);
    const steer=r.platform.inbound('same text');await r.courier.accept(steer);
    for(let i=0;i<10;i++) await r.courier.accept({...steer,transportMessageId:`synthetic-steer-${i}`});
    assert.equal(r.harness.count('steer'),1);assert.equal(r.count('inputs'),2);
    const [ref]=[...r.harness.sessions][0]!;r.harness.message(ref,r.harness.sessions.get(ref)!.activeRun!,'final','synthetic');r.harness.complete(ref);
    await r.restart();await r.courier.accept(event);assert.equal(r.harness.count('start'),1);
    await r.courier.accept(r.platform.inbound('same text'));assert.equal(r.harness.count('start'),2);
  } finally {await r.dispose();}
});
test('conflicting text for an original identity preserves the original body and emits only a safe diagnostic', async () => {
  const r=rig();
  try {
    const event=r.platform.inbound('original synthetic text');await r.courier.accept(event);
    assert.equal((await r.courier.accept({...event,text:'conflicting synthetic body'})).status,'duplicate');
    assert.equal(r.harness.count('start'),1);assert.deepEqual(r.courier.runtime.diagnostics.at(-1)?.code,'protocol_conflict');
  } finally {await r.dispose();}
});
