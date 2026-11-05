import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from '../fixtures/rig.js';
import { request } from '../fixtures/interaction.js';

test('Q-19 answer crash windows preserve original request and never replay a decision',async()=>{
  for(const phase of ['before_call','after_remote','after_commit'] as const){const r=rig();try{
    await r.courier.accept(r.platform.inbound());request(r,'permission');
    const pending=r.db.prepare('SELECT publicCode,vendorRequestId FROM pending_inputs').get() as {publicCode:string;vendorRequestId:string};
    r.boundary((point,kind)=>{if(point===phase&&kind==='answer')throw new Error('synthetic-answer-crash');});
    await assert.rejects(r.courier.accept(r.platform.inbound(`/批准 ${pending.publicCode}`)),{message:'synthetic-answer-crash'});
    r.boundary(undefined);const count=r.harness.count('answer');await r.restart();
    assert.equal(r.harness.count('answer'),count);
    const restored=r.db.prepare('SELECT answerStatus,vendorRequestId FROM pending_inputs').get() as {answerStatus:string;vendorRequestId:string};
    assert.equal(restored.vendorRequestId,pending.vendorRequestId);assert.equal(restored.answerStatus,phase==='after_commit'?'accepted':'unknown');
    await r.courier.accept(r.platform.inbound(`/批准 ${pending.publicCode}`));assert.equal(r.harness.count('answer'),count);
  }finally{await r.dispose();}}
});
test('request mapping survives restart before its body; reliable completion keeps code and one delivery',async()=>{
  const r=rig();try{
    await r.courier.accept(r.platform.inbound());const [ref,state]=[...r.harness.sessions][0]!,runRef=state.activeRun!;
    r.harness.emit(ref,runRef,'input.requested',{vendorRequestId:'incomplete-request',kind:'question',messageId:'incomplete-message',answerSchema:{mode:'text'},adapterMappingRef:'original-mapping'});
    const before=r.db.prepare('SELECT id,publicCode FROM pending_inputs').get() as {id:string;publicCode:string};
    await r.restart();r.harness.message(ref,runRef,'question','restored synthetic body','incomplete-message');await r.courier.flush();
    assert.equal(r.platform.visible.length,1);assert.match(r.platform.visible[0]!.payload,new RegExp(before.publicCode));
    const after=r.db.prepare('SELECT id,publicCode FROM pending_inputs').get();assert.deepEqual(after,before);
    r.harness.emit(ref,runRef,'input.requested',{vendorRequestId:'incomplete-request',kind:'question',messageId:'incomplete-message',answerSchema:{mode:'text'},adapterMappingRef:'original-mapping'});
    await r.courier.flush();assert.equal(r.platform.visible.length,1);
  }finally{await r.dispose();}
});
test('Q-14/Q-21 unknown answers are not repeated and accepted after withdrawal does not reopen a request',async()=>{
  const r=rig();try{
    await r.courier.accept(r.platform.inbound());const original=request(r,'permission');
    const code=(r.db.prepare('SELECT publicCode FROM pending_inputs').get() as {publicCode:string}).publicCode;
    r.harness.options.deferReceipts=true;
    const answer=r.courier.accept(r.platform.inbound(`/批准 ${code}`));
    for(let i=0;i<20 && !r.harness.count('answer');i++)await Promise.resolve();
    const operation=r.db.prepare("SELECT id FROM harness_operations WHERE kind='answer'").get() as {id:string};
    r.harness.emit(original.ref,original.runRef,'input.invalidated',{vendorRequestId:original.id,reason:'withdrawn'});
    r.harness.pendingReceipts.get(operation.id)!({status:'accepted',sessionRef:original.ref,runRef:original.runRef,vendorRequestId:original.id,receiptEvidence:'synthetic-late-answer'});
    assert.equal((await answer).status,'accepted');
    const row=r.db.prepare('SELECT validity,answerStatus FROM pending_inputs').get();assert.deepEqual(row,{validity:'withdrawn',answerStatus:'accepted'});
  }finally{await r.dispose();}
});
test('a valid answer is submitted before an ordinary input which has not yet reached its side effect',async()=>{
  const r=rig();try{
    await r.courier.accept(r.platform.inbound());request(r,'question');
    const code=(r.db.prepare('SELECT publicCode FROM pending_inputs').get() as {publicCode:string}).publicCode;
    await Promise.all([r.courier.accept(r.platform.inbound('ordinary supplement')),r.courier.accept(r.platform.inbound(`/答复 ${code} explicit answer`))]);
    const order=r.harness.calls.filter(x=>['answer','steer'].includes(x.kind)).map(x=>x.kind);assert.deepEqual(order,['answer','steer']);
  }finally{await r.dispose();}
});
