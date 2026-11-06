import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from '../fixtures/rig.js';
import { decodeWebhookResult } from '../../src/adapters/dingtalk/results.js';

test('HTTP 200 still requires an explicit business success; missing or lost results remain unknown',()=>{
  assert.equal(decodeWebhookResult(200,{errcode:0},1).status,'confirmed');
  assert.equal(decodeWebhookResult(200,{errcode:12345,errmsg:'SYNTHETIC_SECRET'},1).status,'unknown');
  for(const [status,body] of [[200,{}],[500,{errcode:0}],[200,null]] as const)assert.equal(decodeWebhookResult(status,body,1).status,'unknown');
  assert.doesNotMatch(JSON.stringify(decodeWebhookResult(200,{errcode:123,errmsg:'SYNTHETIC_SECRET'},1)),/SYNTHETIC_SECRET/);
});

test('send confirmation, explicit rejection, unavailable route and lost response stay distinct', async () => {
  const results=[{status:'confirmed' as const,acceptedAt:1,evidence:'synthetic'},
    {status:'not_sent' as const,code:'synthetic-business-rejection',retryable:false},
    {status:'unknown' as const,safeReason:'synthetic-timeout'}, {status:'route_unavailable' as const,code:'auth' as const}];
  for (const result of results) {
    const r=rig();
    try {
      await r.courier.accept(r.platform.inbound());const [ref,state]=[...r.harness.sessions][0]!;
      r.harness.message(ref,state.activeRun!,'final','synthetic answer');r.harness.complete(ref);
      r.platform.plans.push({result});await r.courier.flush();
      const row=r.db.prepare('SELECT status FROM outbound_deliveries').get() as {status:string};
      assert.equal(row.status,result.status==='confirmed'?'delivered':result.status==='unknown'?'unknown':'failed');
      assert.equal(r.harness.count('start'),1);assert.equal(r.platform.attempts.filter(item=>item.deliveryId===r.platform.attempts[0]!.deliveryId).length,1);
    } finally {await r.dispose();}
  }
});
