import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from '../fixtures/rig.js';
import { invalidateEvidence } from '../../src/storage/capabilities.js';
import { decode,update } from '../../src/storage/records.js';
import type { DeliveryRoute } from '../../src/domain/delivery.js';
test('revocation is checked before a new side effect and does not rewrite original execution facts',async()=>{
  const r=rig();try{
    await r.courier.accept(r.platform.inbound());const report=await r.harness.probe(r.config.harness.instanceId);
    invalidateEvidence(r.db,report.evidenceRefs[0]!.id,r.clock.now());
    assert.equal((await r.courier.accept(r.platform.inbound('supplement after revocation'))).status,'rejected');
    assert.equal(r.harness.count('steer'),0);assert.equal((r.db.prepare('SELECT status FROM runs').get() as {status:string}).status,'running');
  }finally{await r.dispose();}
});
test('changing a limit profile invalidates route evidence until new scoped evidence exists',async()=>{
  const r=rig();try{
    await r.courier.accept(r.platform.inbound());const route=decode<DeliveryRoute>(r.db.prepare('SELECT * FROM delivery_routes').get())!;
    const [ref,state]=[...r.harness.sessions][0]!;r.harness.message(ref,state.activeRun!,'final','synthetic');r.harness.complete(ref);
    const limits={...route.verifiedLimits,maxTextLength:500};update(r.db,'delivery_routes',route.id,{verifiedLimits:limits});
    await r.courier.flush();assert.equal(r.platform.attempts.length,0);
    r.setLimits(route,limits);await r.courier.flush();assert.equal(r.platform.visible.length,1);
  }finally{await r.dispose();}
});
