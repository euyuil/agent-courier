import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from '../fixtures/rig.js';
import { decode } from '../../src/storage/records.js';
import type { DeliveryRoute } from '../../src/domain/delivery.js';
import { textLength } from '../../src/delivery/limits.js';
test('merge exceeding the verified limit keeps original messages; rate windows defer without truncation',async()=>{
  const r=rig();try{
    r.courier.runtime.config.display.defaults.mergeAdjacentProgress=true;await r.courier.accept(r.platform.inbound());
    const route=decode<DeliveryRoute>(r.db.prepare('SELECT * FROM delivery_routes').get())!;
    r.setLimits(route,{...route.verifiedLimits,maxTextLength:5,rates:[{scope:'robot',count:1,windowMs:1000}]});
    const [ref,state]=[...r.harness.sessions][0]!,run=state.activeRun!;
    r.harness.message(ref,run,'progress','first');r.harness.message(ref,run,'progress','two');r.harness.message(ref,run,'final','final');r.harness.complete(ref);
    await r.courier.flush();assert.deepEqual(r.platform.visible.map(x=>x.payload),['first']);
    r.clock.advance(1000);await r.courier.flush();r.clock.advance(1000);await r.courier.flush();assert.deepEqual(r.platform.visible.map(x=>x.payload),['first','two','final']);
    assert.equal(textLength('中😀','utf8_bytes'),7);assert.equal(textLength('中😀','codepoints'),2);assert.equal(textLength('中😀','utf16'),3);
  }finally{await r.dispose();}
});
test('oversize single output fails without truncation and cannot create recursive failure messages',async()=>{
  const r=rig();try{
    await r.courier.accept(r.platform.inbound());const route=decode<DeliveryRoute>(r.db.prepare('SELECT * FROM delivery_routes').get())!;
    r.setLimits(route,{...route.verifiedLimits,maxTextLength:2});
    const [ref,state]=[...r.harness.sessions][0]!;r.harness.message(ref,state.activeRun!,'final','oversized synthetic answer');r.harness.complete(ref);
    await r.courier.flush();assert.equal(r.platform.attempts.length,0);assert.equal(r.count('outbound_deliveries'),2);assert.equal(r.count('failure_notices'),1);
    await r.courier.flush();assert.equal(r.count('outbound_deliveries'),2);
  }finally{await r.dispose();}
});
