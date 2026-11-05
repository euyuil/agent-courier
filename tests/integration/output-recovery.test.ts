import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from '../fixtures/rig.js';
import { confirmMissingOutput } from '../../src/application/output-projector.js';
test('T4 before/after commit crashes replay a reliable event without duplicate outbox or successful resend',async()=>{
  for(const phase of ['before_commit','after_commit'] as const){const r=rig();try{
    await r.courier.accept(r.platform.inbound());const [ref,state]=[...r.harness.sessions][0]!,run=state.activeRun!;
    r.harness.emit(ref,run,'message.started',{messageId:'crash-final',kind:'final',userVisible:true,logicalOrder:1});
    r.harness.emit(ref,run,'message.fragment',{messageId:'crash-final',fragmentKey:'key-0',fragmentIndex:0,text:'synthetic recovered final'});
    r.eventBoundary(point=>{if(point===phase)throw new Error('synthetic-event-crash');});
    assert.throws(()=>r.harness.emit(ref,run,'message.completed',{messageId:'crash-final',finalFragmentIndex:0},'reliable-completion-key'),{message:'synthetic-event-crash'});
    r.eventBoundary(undefined);await r.restart();
    r.harness.emit(ref,run,'message.completed',{messageId:'crash-final',finalFragmentIndex:0},'reliable-completion-key');
    assert.equal(r.count('outbound_deliveries'),1);await r.courier.flush();
    await r.restart();r.harness.emit(ref,run,'message.completed',{messageId:'crash-final',finalFragmentIndex:0},'reliable-completion-key');await r.courier.flush();
    assert.equal(r.platform.visible.length,1);assert.equal(r.platform.attempts.length,1);
  }finally{await r.dispose();}}
});
test('only confirmed unrecoverable gaps release later complete output; partial text is never delivered',async()=>{
  const r=rig();try{
    await r.courier.accept(r.platform.inbound());const [ref,state]=[...r.harness.sessions][0]!,run=state.activeRun!;
    r.harness.emit(ref,run,'message.started',{messageId:'gap',kind:'progress',userVisible:true,logicalOrder:1});
    r.harness.emit(ref,run,'message.fragment',{messageId:'gap',fragmentKey:'key-1',fragmentIndex:1,text:'never-send-partial'});
    r.harness.emit(ref,run,'message.completed',{messageId:'gap',finalFragmentIndex:1});
    r.harness.message(ref,run,'final','complete final');r.harness.complete(ref);await r.courier.flush();assert.equal(r.platform.visible.length,0);
    const message=(r.db.prepare("SELECT id FROM output_messages WHERE sourceMessageId='gap'").get() as {id:string}).id;
    confirmMissingOutput(r.courier.runtime,message,{authoritative:true,evidenceRef:'synthetic-proven-gap'});await r.courier.flush();
    assert.ok(r.platform.visible.some(x=>x.payload==='complete final'));assert.ok(r.platform.visible.every(x=>!x.payload.includes('never-send-partial')));
  }finally{await r.dispose();}
});
