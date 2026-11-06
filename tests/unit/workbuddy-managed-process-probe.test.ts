import test from 'node:test';
import assert from 'node:assert/strict';
import { managedProcessExperiment,runManagedProcessWorker,type ManagedProcessServices,type ManagedProcessResult } from '../probes/workbuddy-managed-process.js';

function fixture(failure=''){
  const calls:string[]=[];let sequence=0;
  const services:ManagedProcessServices={
    worker:async input=>{
      sequence++;calls.push(input.phase);
      const replaced=input.phase==='replace',seed=input.phase==='seed';
      const result:ManagedProcessResult={status:'observed',targetFingerprint:'a'.repeat(64),contexts:[
        {sessionRef:'private-a',ownerRef:'private-owner-a',hostRef:replaced?'private-new-host-a':'private-host-a',identity:{pid:replaced?300:100,startTime:'1',bootId:'00000000-0000-4000-8000-000000000001'}},
        {sessionRef:'private-b',ownerRef:'private-owner-b',hostRef:'private-host-b',identity:{pid:200,startTime:'2',bootId:'00000000-0000-4000-8000-000000000001'}},
      ],summary:{bothExact:true,bothScoped:true,bothEndTurn:true,nativeEndTurn:true,noTools:true,completeTrace:true,requiredCapabilitiesUnverified:true,configuredTargetStable:true,
        actualUserCreates:seed?2:0,userContextCount:2,aHostOperations:replaced?2:1,bHostOperations:1,events:20,frames:100,cliVersion:'2.147.0'}};
      if(failure==='unknown-seed'&&seed)result.status='unverified';
      if(failure==='incomplete-reuse'&&input.phase==='reuse')result.summary.completeTrace=false;
      if(failure==='wrong-a'&&input.phase==='reuse')result.contexts![0].sessionRef='private-other-a';
      if(failure==='wrong-owner'&&input.phase==='reuse')result.contexts![0].ownerRef='private-other-owner';
      if(failure==='changed-b'&&input.phase==='reuse')result.contexts![1].identity.startTime='3';
      if(failure==='created-on-reuse'&&input.phase==='reuse')result.summary.actualUserCreates=1;
      if(failure==='changed-cli'&&input.phase==='reuse')result.summary.cliVersion='2.148.0';
      if(failure==='changed-target'&&input.phase==='reuse')result.summary.configuredTargetStable=false;
      if(failure==='changed-target-across-processes'&&input.phase==='reuse')result.targetFingerprint='b'.repeat(64);
      if(failure==='host-is-user-context'&&seed)result.contexts![0].hostRef=result.contexts![0].sessionRef;
      if(failure==='new-user-context'&&replaced)result.contexts![0].sessionRef='private-replacement-a';
      if(failure==='same-old-host'&&replaced)result.contexts![0].hostRef='private-host-a';
      if(failure==='same-old-process'&&replaced)result.contexts![0].identity.pid=100;
      if(failure==='peer-changed-on-replace'&&replaced)result.contexts![1].hostRef='private-other-b-host';
      if(failure==='extra-host'&&replaced)result.summary.aHostOperations=3;
      return {result,pid:failure==='reused-worker'?1000:1000+sequence,exitedNormally:failure!=='abnormal-exit'};
    },
    ready:async()=>{calls.push('ready');return failure!=='busy';},
    shutdown:async()=>{calls.push('shutdown');return failure!=='shutdown-unknown';},
    inspect:async identity=>{calls.push(identity.pid===200?'peer-alive':'old-state');return identity.pid===200?(failure==='peer-ended'?'ended':'alive'):
      failure==='old-death-unknown'?'unknown':failure==='old-alive'||!calls.includes('shutdown')?'alive':'ended';},
    pause:async()=>{calls.push('pause');},
  };
  return {calls,run:()=>managedProcessExperiment({evaluate:async()=>assert.fail()},'http://127.0.0.1:1','/synthetic/private/workspace',services)};
}
test('managed recovery proves three exited processes, both original contexts and only A backend replacement without exporting identities',async()=>{
  const f=fixture(),report=await f.run();assert.equal(report['status'],'observed');
  assert.equal(report['separateWorkerProcesses'],3);assert.equal(report['originalContextsAcrossProcesses'],true);assert.equal(report['peerBackendUnchanged'],true);
  assert.deepEqual(f.calls,['seed','reuse','ready','old-state','peer-alive','shutdown','old-state','peer-alive','replace']);
  assert.doesNotMatch(JSON.stringify(report),/private-|owner|hostRef|sessionRef|identity|startTime|bootId|127\.0\.0\.1|workspace/);
  assert.doesNotMatch(JSON.stringify(report),/[a-f0-9]{64}/);
});
test('unverified, foreign, changed, duplicated or non-exited process facts stop before any shutdown',async()=>{
  for(const failure of ['unknown-seed','incomplete-reuse','wrong-a','wrong-owner','changed-b','created-on-reuse','changed-cli','changed-target','changed-target-across-processes','host-is-user-context','reused-worker','abnormal-exit']){
    const f=fixture(failure),report=await f.run();assert.equal(report['status'],'unverified',failure);
    assert.equal(f.calls.includes('shutdown'),false,failure);assert.equal(f.calls.includes('replace'),false,failure);
    assert.equal(f.calls.filter(call=>call==='seed').length,1,failure);
  }
});
test('unknown death, a stopped peer or uncertain shutdown cannot trigger a replacement process',async()=>{
  for(const failure of ['busy','shutdown-unknown','peer-ended','old-death-unknown','old-alive']){
    const f=fixture(failure),report=await f.run();assert.equal(report['status'],'unverified',failure);assert.equal(f.calls.includes('replace'),false,failure);
    assert.ok(f.calls.filter(call=>call==='shutdown').length<=1);assert.ok(f.calls.filter(call=>call==='pause').length<=30);
  }
});
test('a new user context, a reused old A runtime, a changed B runtime or an extra activation cannot satisfy recovery',async()=>{
  for(const failure of ['new-user-context','same-old-host','same-old-process','peer-changed-on-replace','extra-host']){
    const f=fixture(failure),report=await f.run();assert.equal(report['status'],'unverified',failure);
    assert.equal(f.calls.filter(call=>call==='replace').length,1);assert.equal(f.calls.filter(call=>call==='shutdown').length,1);
  }
});
test('the managed worker rejects a remote diagnostic URL before opening a database or Harness',async()=>{
  const exit=await runManagedProcessWorker({enableIndependentManagedProcess:true,workspace:'/tmp/synthetic-uncreated-managed-worker',desktopDebugUrl:'http://example.invalid',phase:'seed'});
  assert.equal(exit.exitedNormally,false);assert.equal(exit.result.status,'unverified');assert.equal(exit.result.contexts,undefined);assert.equal(exit.result.summary.events,0);
});
