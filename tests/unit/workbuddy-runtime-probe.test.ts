import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticRuntimeExperiment,runRuntimeWorker,type RuntimeWorkerResult,type RuntimeExperimentServices } from '../probes/workbuddy-runtime.js';
import { workbuddyCapabilityProbe } from '../probes/workbuddy-capabilities.js';

function fixture(failure='') {
  const calls:string[]=[];let sequence=0;
  const services:RuntimeExperimentServices={
    worker:async input=>{
      sequence++;calls.push(input.phase);
      const result:RuntimeWorkerResult={status:'observed',hostRef:input.phase==='replace'?'private-new-host':'private-host',
        processIdentity:{pid:input.phase==='replace'?200:100,startTime:'1000',bootId:'00000000-0000-4000-8000-000000000001'},
        summary:{accepted:true,completed:true,endTurn:true,exactContext:true,scoped:true,completeTrace:true,noTools:true,sameOriginalContext:true,
          sameBootstrap:input.phase!=='replace',distinctReplacement:input.phase==='replace',events:10,hostCreations:input.phase==='replace'?2:1,
          requiredCapabilitiesUnverified:true,cliVersion:'2.147.0'}};
      if(failure==='unknown'&&input.phase==='seed')result.status='unverified';
      if(failure==='truncated'&&input.phase==='reuse')result.summary.completeTrace=false;
      if(failure==='wrong-context'&&input.phase==='reuse')result.summary.sameOriginalContext=false;
      if(failure==='extra-create'&&input.phase==='reuse')result.summary.hostCreations=2;
      if(failure==='changed-host'&&input.phase==='reuse')result.hostRef='private-foreign-host';
      if(failure==='changed-process'&&input.phase==='reuse')result.processIdentity!.startTime='2000';
      if(failure==='reused-host'&&input.phase==='replace')result.hostRef='private-host';
      if(failure==='tools'&&input.phase==='seed')result.summary.noTools=false;
      if(failure==='permissions'&&input.phase==='reuse')result.summary.requiredCapabilitiesUnverified=false;
      if(failure==='same-worker')sequence=1;
      return {result,pid:sequence+1000,exitedNormally:failure!=='not-exited'};
    },
    ready:async()=>{calls.push('ready');return failure!=='busy';},
    shutdown:async()=>{calls.push('shutdown');return failure!=='shutdown-unknown';},
    inspect:async()=>{calls.push('inspect');return failure==='death-unknown'?'unknown':failure==='still-live'?'alive':'ended';},
    pause:async()=>{calls.push('pause');},
  };
  return {calls,services,run:()=>automaticRuntimeExperiment({evaluate:async()=>assert.fail()},'http://127.0.0.1:1','/synthetic/private/workspace',services)};
}
test('automatic runtime observation proves three exited processes, retained original context and a distinct post-death startup host without exporting identities',async()=>{
  const f=fixture(),report=await f.run();assert.equal(report['status'],'observed');
  assert.equal(report['separateProcessOriginalContextRestored'],true);assert.equal(report['separateWorkerProcesses'],3);
  assert.deepEqual(f.calls,['seed','reuse','ready','shutdown','inspect','replace']);
  assert.doesNotMatch(JSON.stringify(report),/private-|1000|startTime|bootId|127\.0\.0\.1|workspace/);
});
test('unknown, incomplete, foreign, repeated or non-exited worker evidence stops before shutdown or replacement and never retries',async()=>{
  for(const failure of ['unknown','truncated','wrong-context','extra-create','changed-host','changed-process','tools','permissions','same-worker','not-exited']){
    const f=fixture(failure),report=await f.run();assert.equal(report['status'],'unverified',failure);
    assert.equal(f.calls.includes('shutdown'),false,failure);assert.equal(f.calls.includes('replace'),false,failure);
    assert.equal(f.calls.filter(call=>call==='seed').length,1,failure);
  }
});
test('idle confirmation and proven old process death are required before a replacement worker can run',async()=>{
  for(const failure of ['busy','shutdown-unknown','death-unknown','still-live','reused-host']){
    const f=fixture(failure),report=await f.run();assert.equal(report['status'],'unverified',failure);
    assert.equal(f.calls.filter(call=>call==='shutdown').length,failure==='busy'?0:1,failure);
    assert.equal(f.calls.includes('replace'),failure==='reused-host',failure);
    assert.ok(f.calls.filter(call=>call==='pause').length<=30,failure);
  }
});
test('runtime worker rejects a remote diagnostic target before creating state or calling a Harness',async()=>{
  const exit=await runRuntimeWorker({enableIndependentRuntimeProbe:true,workspace:'/tmp/synthetic-uncreated-runtime-probe',desktopDebugUrl:'http://example.invalid',phase:'seed'});
  assert.equal(exit.exitedNormally,false);assert.equal(exit.result.status,'unverified');assert.equal(exit.result.hostRef,undefined);
  assert.equal(exit.result.summary.events,0);
});
test('automatic runtime live mode requires explicit enablement and cannot be combined with another experiment',async()=>{
  for(const args of [[],['--acp-automatic-runtime'],['--enable-live','--launch-profile','never-read','--output','never-write','--acp-automatic-runtime','--question']]){
    assert.equal(await workbuddyCapabilityProbe(args),2);
  }
  assert.equal(await workbuddyCapabilityProbe(['--enable-live','--launch-profile','never-read','--output','never-write','--acp-automatic-runtime']),3);
});
