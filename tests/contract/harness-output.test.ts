import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from '../fixtures/rig.js';
test('Q-16 out-of-order fragments and duplicate identities retain normal repeated text, including terminal tails',async()=>{
  const r=rig();try{
    await r.courier.accept(r.platform.inbound());const [ref,state]=[...r.harness.sessions][0]!,run=state.activeRun!;
    r.harness.emit(ref,run,'message.started',{messageId:'fragmented-final',kind:'final',userVisible:true,logicalOrder:1});
    r.harness.emit(ref,run,'message.fragment',{messageId:'fragmented-final',fragmentKey:'key-1',fragmentIndex:1,text:'repeat'});
    r.harness.emit(ref,run,'message.fragment',{messageId:'fragmented-final',fragmentKey:'key-1',fragmentIndex:1,text:'repeat'});
    r.harness.emit(ref,run,'message.completed',{messageId:'fragmented-final',finalFragmentIndex:1});
    await r.courier.flush();assert.equal(r.platform.visible.length,0);r.harness.complete(ref);
    r.harness.emit(ref,run,'message.fragment',{messageId:'fragmented-final',fragmentKey:'key-0',fragmentIndex:0,text:'repeat'});
    await r.courier.flush();assert.equal(r.platform.visible.length,1);assert.equal(r.platform.visible[0]!.payload,'repeatrepeat');
    assert.equal((r.db.prepare('SELECT status FROM runs').get() as {status:string}).status,'completed');
  }finally{await r.dispose();}
});
test('unsealed earlier output blocks later output, and final text alone never completes a Run',async()=>{
  const r=rig();try{
    await r.courier.accept(r.platform.inbound());const [ref,state]=[...r.harness.sessions][0]!,run=state.activeRun!;
    r.harness.emit(ref,run,'message.started',{messageId:'earlier',kind:'progress',userVisible:true,logicalOrder:1});
    r.harness.message(ref,run,'final','later final');await r.courier.flush();assert.equal(r.platform.visible.length,0);
    r.harness.emit(ref,run,'message.fragment',{messageId:'earlier',fragmentKey:'p0',fragmentIndex:0,text:'earlier progress'});
    r.harness.emit(ref,run,'message.completed',{messageId:'earlier',finalFragmentIndex:0});await r.courier.flush();
    assert.deepEqual(r.platform.visible.map(x=>x.payload),['earlier progress','later final']);
    assert.equal((r.db.prepare('SELECT status FROM runs').get() as {status:string}).status,'running');
  }finally{await r.dispose();}
});
test('fragment identity/index/content conflicts are invalid; empty messages require the explicit -1 boundary',async()=>{
  for(const conflict of ['index','key','content']){const r=rig();try{
    await r.courier.accept(r.platform.inbound());const [ref,state]=[...r.harness.sessions][0]!,run=state.activeRun!;
    r.harness.emit(ref,run,'message.started',{messageId:'conflict',kind:'progress',userVisible:true,logicalOrder:1});
    r.harness.emit(ref,run,'message.fragment',{messageId:'conflict',fragmentKey:'k0',fragmentIndex:0,text:'same'});
    r.harness.emit(ref,run,'message.fragment',{messageId:'conflict',fragmentKey:conflict==='key'?'k1':'k0',fragmentIndex:conflict==='index'?1:0,text:conflict==='content'?'changed':'same'});
    assert.equal((r.db.prepare("SELECT completeness FROM output_messages WHERE sourceMessageId='conflict'").get() as {completeness:string}).completeness,'invalid');
    r.harness.emit(ref,run,'message.started',{messageId:'empty',kind:'message',userVisible:true,logicalOrder:2});
    r.harness.emit(ref,run,'message.completed',{messageId:'empty',finalFragmentIndex:-1});
    assert.equal((r.db.prepare("SELECT completeness FROM output_messages WHERE sourceMessageId='empty'").get() as {completeness:string}).completeness,'complete');
  }finally{await r.dispose();}}
});
