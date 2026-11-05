import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from '../fixtures/rig.js';
import { request } from '../fixtures/interaction.js';
import type { OutputKind } from '../../src/adapters/harness/events.js';
test('Q-15 the four progress/final policies produce 3/1/2/0 ordinary outputs with the same completion',async()=>{
  for(const [progress,final,count] of [[true,true,3],[false,true,1],[true,false,2],[false,false,0]] as const){const r=rig();try{
    r.courier.runtime.config.display.defaults.progress=progress;r.courier.runtime.config.display.defaults.final=final;
    await r.courier.accept(r.platform.inbound());const [ref,state]=[...r.harness.sessions][0]!,run=state.activeRun!;
    r.harness.message(ref,run,'progress','p1');r.harness.message(ref,run,'progress','p2');r.harness.message(ref,run,'final','f');r.harness.complete(ref);await r.courier.flush();
    assert.equal(r.platform.visible.length,count);assert.equal((r.db.prepare('SELECT status FROM runs').get() as {status:string}).status,'completed');
  }finally{await r.dispose();}}
});
test('Q-17 merge only adjacent unattempted progress; the active Run keeps its policy after reload',async()=>{
  const r=rig();try{
    r.courier.runtime.config.display.defaults.mergeAdjacentProgress=true;
    await r.courier.accept(r.platform.inbound());const [ref,state]=[...r.harness.sessions][0]!,run=state.activeRun!;
    const next=structuredClone(r.config);next.display.defaults.progress=false;next.display.defaults.final=false;
    assert.equal(r.courier.reload(next),true);await r.courier.accept(r.platform.inbound('steer'));
    r.harness.message(ref,run,'progress','one');r.harness.message(ref,run,'progress','two');r.harness.message(ref,run,'final','final');r.harness.complete(ref);await r.courier.flush();
    assert.deepEqual(r.platform.visible.map(x=>x.payload),['one\ntwo','final']);
    await r.courier.accept(r.platform.inbound('next round'));const nextRun=state.activeRun!;
    r.harness.message(ref,nextRun,'final','hidden final');r.harness.complete(ref);await r.courier.flush();assert.equal(r.platform.visible.length,2);
    assert.equal(r.courier.reload({...next,display:{defaults:{question:false}}}),false);
  }finally{await r.dispose();}
});
test('Q-18 hidden ordinary output still permits questions, permissions, errors and real control states',async()=>{
  const r=rig();try{
    r.courier.runtime.config.display.defaults.progress=false;r.courier.runtime.config.display.defaults.final=false;
    await r.courier.accept(r.platform.inbound());request(r);const [ref,state]=[...r.harness.sessions][0]!;
    r.harness.message(ref,state.activeRun!,'error','synthetic user-visible error');await r.courier.flush();
    assert.equal(r.platform.visible.length,2);assert.match(r.platform.visible[0]!.payload,/\/答复/);
    assert.equal((r.db.prepare('SELECT status FROM runs').get() as {status:string}).status,'waiting_input');
  }finally{await r.dispose();}
});
test('unknown thought types never disclose their body or imply completion',async()=>{
  const r=rig();try{
    await r.courier.accept(r.platform.inbound());const [ref,state]=[...r.harness.sessions][0]!,run=state.activeRun!;
    r.harness.message(ref,run,'thought' as OutputKind,'SYNTHETIC_INTERNAL_THOUGHT');await r.courier.flush();
    assert.ok(r.platform.visible.length>0);assert.ok(r.platform.visible.every(item=>!item.payload.includes('SYNTHETIC_INTERNAL_THOUGHT')));
    assert.equal((r.db.prepare('SELECT status FROM runs').get() as {status:string}).status,'running');
  }finally{await r.dispose();}
});
test('a request whose body cannot be shown produces a safe interaction blockage instead of silent waiting',async()=>{
  const r=rig();try{
    await r.courier.accept(r.platform.inbound());const [ref,state]=[...r.harness.sessions][0]!,run=state.activeRun!;
    r.harness.emit(ref,run,'input.requested',{vendorRequestId:'not-visible-request',kind:'question',messageId:'not-visible-body',answerSchema:{mode:'text'},adapterMappingRef:'original-map'});
    r.harness.emit(ref,run,'message.started',{messageId:'not-visible-body',kind:'question',userVisible:false,logicalOrder:1});
    r.harness.emit(ref,run,'message.fragment',{messageId:'not-visible-body',fragmentKey:'p0',fragmentIndex:0,text:'SYNTHETIC_INTERNAL_QUESTION'});
    r.harness.emit(ref,run,'message.completed',{messageId:'not-visible-body',finalFragmentIndex:0});await r.courier.flush();
    assert.equal(r.harness.count('answer'),0);assert.equal(r.platform.visible.length,1);assert.match(r.platform.visible[0]!.payload,/人工交互/);
    assert.doesNotMatch(r.platform.visible[0]!.payload,/SYNTHETIC_INTERNAL_QUESTION/);
  }finally{await r.dispose();}
});
