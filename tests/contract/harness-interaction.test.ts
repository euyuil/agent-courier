import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from '../fixtures/rig.js';
import { request } from '../fixtures/interaction.js';
test('request/body arrival order yields one numbered delivery and persists the original schema',async()=>{
  for(const messageFirst of [false,true]){const r=rig();try{
    await r.courier.accept(r.platform.inbound());request(r,'question',{messageFirst});await r.courier.flush();
    assert.equal(r.platform.visible.length,1);assert.match(r.platform.visible[0]!.payload,/\/答复 Q/);
    const row=r.db.prepare('SELECT sourceMessageId,answerSchema FROM pending_inputs').get() as {sourceMessageId:string;answerSchema:string};
    assert.equal(row.sourceMessageId,'message-synthetic-request');assert.deepEqual(JSON.parse(row.answerSchema),{mode:'text'});
  }finally{await r.dispose();}}
});
test('same request cannot be remapped to another message, and conflicting bodies are not sent',async()=>{
  const r=rig();try{
    await r.courier.accept(r.platform.inbound());const {ref,runRef}=request(r);await r.courier.flush();
    r.harness.emit(ref,runRef,'input.requested',{vendorRequestId:'synthetic-request',kind:'question',messageId:'other-message',answerSchema:{mode:'text'},adapterMappingRef:'mapping-synthetic-request'});
    r.harness.message(ref,runRef,'question','conflicting secret body','other-message');await r.courier.flush();
    assert.equal(r.platform.visible.length,1);assert.ok(r.courier.runtime.diagnostics.some(x=>x.code==='protocol_conflict'));
  }finally{await r.dispose();}
});
test('request/message kind conflicts block the original body in either arrival order',async()=>{
  for(const messageFirst of [false,true]){const r=rig();try{
    await r.courier.accept(r.platform.inbound());const [ref,state]=[...r.harness.sessions][0]!,run=state.activeRun!;
    const body=()=>r.harness.message(ref,run,'final','NEVER_SEND_CONFLICTING_BODY','mismatch');
    if(messageFirst)body();
    r.harness.emit(ref,run,'input.requested',{vendorRequestId:'kind-conflict',kind:'question',messageId:'mismatch',answerSchema:{mode:'text'},adapterMappingRef:'original-map'});
    if(!messageFirst)body();await r.courier.flush();
    assert.ok(r.platform.visible.every(item=>!item.payload.includes('NEVER_SEND_CONFLICTING_BODY')));
    assert.equal((r.db.prepare('SELECT status FROM harness_bindings').get() as {status:string}).status,'unknown');
  }finally{await r.dispose();}}
});
