import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from '../fixtures/rig.js';
import { request } from '../fixtures/interaction.js';
import type { OutputKind } from '../../src/adapters/harness/events.js';
import { writeFileSync,unlinkSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { loadConfig } from '../../src/config/load.js';
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
test('the input boundary rereads configuration while keeping the active Run policy and applying changes to the next Run',async()=>{
  const r=rig(),file=join(dirname(r.config.storage.databasePath),'config.json');let reads=0;
  try {
    writeFileSync(file,JSON.stringify(r.config),{mode:0o600});
    r.courier.runtime.readConfig=()=>{reads++;return loadConfig(file);};
    await r.courier.accept(r.platform.inbound('first round'));
    const [ref,state]=[...r.harness.sessions][0]!,firstRun=state.activeRun!;
    const next=structuredClone(r.config);next.display.defaults.progress=false;next.display.defaults.revision=2;
    writeFileSync(file,JSON.stringify(next),{mode:0o600});
    await r.courier.accept(r.platform.inbound('steer after configuration edit'));
    assert.equal(r.courier.runtime.config.display.defaults.revision,2);
    r.harness.message(ref,firstRun,'progress','original-progress');r.harness.message(ref,firstRun,'final','original-final');r.harness.complete(ref);
    await r.courier.flush();
    await r.courier.accept(r.platform.inbound('next round'));
    const nextRun=state.activeRun!;
    r.harness.message(ref,nextRun,'progress','hidden-progress');r.harness.message(ref,nextRun,'final','next-final');r.harness.complete(ref);
    await r.courier.flush();
    assert.equal(reads,3);assert.equal(r.harness.count('steer'),1);assert.equal(r.harness.count('create'),1);
    assert.deepEqual(r.platform.visible.map(item=>item.payload),['original-progress','original-final','next-final']);
  }finally{await r.dispose();}
});
test('configuration read failures, invalid human settings and changed targets retain the last valid configuration with safe diagnostics',async()=>{
  const r=rig(),file=join(dirname(r.config.storage.databasePath),'config.json');let notifications=0;
  try {
    writeFileSync(file,JSON.stringify(r.config),{mode:0o600});r.courier.runtime.readConfig=()=>loadConfig(file);
    r.courier.runtime.onConfigReloadFailure=()=>{notifications++;throw new Error('SYNTHETIC_PRIVATE_LOGGER_DETAIL');};
    await r.courier.accept(r.platform.inbound('first round'));
    const changedTarget=structuredClone(r.config);changedTarget.harness.instanceId='synthetic-other-target';
    for(const content of ['SYNTHETIC_PRIVATE_CONFIG_DETAIL',JSON.stringify({...r.config,display:{defaults:{question:false}}}),JSON.stringify(changedTarget),undefined]) {
      if(content===undefined)unlinkSync(file);else writeFileSync(file,content,{mode:0o600});
      assert.equal((await r.courier.accept(r.platform.inbound('steer with failed reload'))).status,'accepted');
      assert.equal(r.courier.runtime.config.harness.instanceId,r.config.harness.instanceId);
      assert.equal(r.courier.runtime.config.display.defaults.question,true);
    }
    assert.equal(r.harness.count('create'),1);assert.equal(r.harness.count('steer'),4);
    assert.equal(notifications,4);
    assert.deepEqual(r.courier.runtime.diagnostics,[{code:'configuration_invalid'},{code:'configuration_invalid'},{code:'configuration_invalid'},{code:'configuration_invalid'}]);
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
