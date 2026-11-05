import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from '../fixtures/rig.js';
import { reconcile } from '../../src/application/reconcile.js';
import { decode,insert,update } from '../../src/storage/records.js';
import type { DeliveryRoute } from '../../src/adapters/dingtalk/port.js';

async function threeMessages(r:ReturnType<typeof rig>) {
  await r.courier.accept(r.platform.inbound('synthetic initial'));const [ref,state]=[...r.harness.sessions][0]!;
  for(const [kind,text] of [['progress','one'],['progress','two'],['final','three']] as const)r.harness.message(ref,state.activeRun!,kind,text);
  r.harness.complete(ref);
}
test('Q-07 second delivery alone retries, respects Retry-After, and keeps ordered output',async()=>{
  const r=rig();try{
    await threeMessages(r);r.platform.plans.push({result:{status:'confirmed',acceptedAt:1,evidence:'synthetic'}},{result:{status:'not_sent',code:'synthetic-rate',retryable:true,retryAfter:5000}});
    await r.courier.flush();assert.deepEqual(r.platform.visible.map(x=>x.payload),['one']);
    r.clock.advance(4999);await r.courier.flush();assert.equal(r.platform.attempts.length,2);
    r.clock.advance(1);await r.courier.flush();assert.deepEqual(r.platform.visible.map(x=>x.payload),['one','two','three']);
    assert.equal(r.platform.attempts.length,4);assert.equal(r.harness.count('start'),1);
  }finally{await r.dispose();}
});
test('Q-08 three failed attempts stop; final continues and one bounded missing-content notice is sent',async()=>{
  const r=rig();try{
    await threeMessages(r);r.platform.plans.push({result:{status:'confirmed',acceptedAt:1,evidence:'synthetic'}},
      ...Array.from({length:3},()=>({result:{status:'not_sent' as const,code:'synthetic-temp',retryable:true}})));
    await r.courier.flush();r.clock.advance(1000);await r.courier.flush();r.clock.advance(2000);await r.courier.flush();
    const failed=r.db.prepare("SELECT attemptCount FROM outbound_deliveries WHERE status='failed'").get() as {attemptCount:number};
    assert.equal(failed.attemptCount,3);assert.equal(r.platform.visible[1]!.payload,'three');assert.equal(r.count('failure_notices'),1);
    assert.equal(r.harness.count('start'),1);
  }finally{await r.dispose();}
});
test('Q-20 unknown blocks one private conversation; confirmed/not_sent/unsupported query results preserve budgets',async()=>{
  for(const outcome of ['confirmed','not_sent','unsupported'] as const){
    const r=rig();try{
      await threeMessages(r);r.platform.plans.push({result:{status:'unknown',safeReason:'lost-response'},visible:outcome==='confirmed'});await r.courier.flush();
      const delivery=r.platform.attempts[0]!.deliveryId;const before=r.platform.attempts.length;
      await r.courier.flush();assert.equal(r.platform.attempts.length,before);
      await r.courier.accept(r.platform.inbound('other','synthetic-private-b'));const [ref,state]=[...r.harness.sessions][1]!;
      r.harness.message(ref,state.activeRun!,'final','other-answer');r.harness.complete(ref);await r.courier.flush();
      assert.equal(r.platform.visible.at(-1)!.payload,'other-answer');
      r.platform.inspections.set(delivery,outcome==='confirmed'?{status:'confirmed',acceptedAt:1,evidence:'synthetic',authoritative:true,evidenceRef:'synthetic-query'}:
        outcome==='not_sent'?{status:'not_sent',code:'synthetic',retryable:true,authoritative:true,evidenceRef:'synthetic-query'}:{status:'unsupported'});
      const sent=r.platform.attempts.length;assert.equal(await reconcile(r.courier.runtime,{delivery}),outcome!=='unsupported');assert.equal(r.platform.attempts.length,sent);
      const row=r.db.prepare('SELECT status,attemptCount FROM outbound_deliveries WHERE id=?').get(delivery) as {status:string;attemptCount:number};
      assert.equal(row.attemptCount,1);assert.equal(row.status,outcome==='confirmed'?'delivered':outcome==='not_sent'?'retry_wait':'unknown');
      if(outcome==='confirmed'){await r.courier.flush();assert.deepEqual(r.platform.visible.filter(x=>x.recipient.platformConversationId==='synthetic-private-a').map(x=>x.payload),['one','two','three']);}
    }finally{await r.dispose();}
  }
});
test('Q-10 route expiry, text length and switched routes never change recipient or reset attempts',async()=>{
  const r=rig();try{
    await threeMessages(r);const route=decode<DeliveryRoute>(r.db.prepare('SELECT * FROM delivery_routes').get())!;
    update(r.db,'delivery_routes',route.id,{expiresAt:r.clock.now()});await r.courier.flush();assert.equal(r.platform.attempts.length,0);
    insert(r.db,'delivery_routes',{...route,id:'synthetic-new-route'});
    r.platform.plans.push({result:{status:'not_sent',code:'synthetic',retryable:true}});await r.courier.flush();r.clock.advance(1000);
    update(r.db,'delivery_routes','synthetic-new-route',{expiresAt:r.clock.now()});insert(r.db,'delivery_routes',{...route,id:'synthetic-third-route'});
    await r.courier.flush();assert.equal(r.platform.attempts[1]!.deliveryId,r.platform.attempts[0]!.deliveryId);
    assert.equal(r.platform.attempts[1]!.route.id,'synthetic-third-route');
    assert.equal(new Set(r.platform.attempts.map(x=>x.recipient.id)).size,1);
  }finally{await r.dispose();}
});
test('Q-19 send crash after remote acceptance becomes unknown; committed success is never resent',async()=>{
  for(const phase of ['before_call','after_remote','after_commit'] as const){const r=rig();try{
    await threeMessages(r);r.boundary((point,kind)=>{if(point===phase&&kind==='send')throw new Error('synthetic-send-crash');});
    await assert.rejects(r.courier.flush(),{message:'synthetic-send-crash'});r.boundary(undefined);const count=r.platform.attempts.length;
    await r.restart();await r.courier.flush();
    assert.equal(r.platform.attempts.length,phase==='after_commit'?count+2:count);
    const row=r.db.prepare('SELECT status FROM outbound_deliveries ORDER BY deliverySequence LIMIT 1').get() as {status:string};
    assert.equal(row.status,phase==='after_commit'?'delivered':'unknown');
  }finally{await r.dispose();}}
});
test('not_sent reconciliation after the third attempt exhausts the original budget and only prepares one notice',async()=>{
  const r=rig();try{
    await r.courier.accept(r.platform.inbound());const [ref,state]=[...r.harness.sessions][0]!;
    r.harness.message(ref,state.activeRun!,'final','synthetic final');r.harness.complete(ref);
    r.platform.plans.push({result:{status:'not_sent',code:'synthetic',retryable:true}},{result:{status:'not_sent',code:'synthetic',retryable:true}},{result:{status:'unknown',safeReason:'synthetic'}});
    await r.courier.flush();r.clock.advance(1000);await r.courier.flush();r.clock.advance(2000);await r.courier.flush();
    const delivery=r.platform.attempts[0]!.deliveryId;r.platform.inspections.set(delivery,{status:'not_sent',code:'synthetic',retryable:true,authoritative:true,evidenceRef:'synthetic-query'});
    assert.equal(await reconcile(r.courier.runtime,{delivery}),true);assert.equal(r.platform.attempts.length,3);
    assert.deepEqual(r.db.prepare('SELECT status,attemptCount FROM outbound_deliveries WHERE id=?').get(delivery),{status:'failed',attemptCount:3});
    assert.equal(r.count('failure_notices'),1);await r.courier.flush();assert.equal(r.platform.attempts.filter(x=>x.deliveryId===delivery).length,3);assert.equal(r.harness.count('start'),1);
  }finally{await r.dispose();}
});
