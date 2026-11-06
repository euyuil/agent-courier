import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverManagedBackend,type ManagedRecoveryServices } from '../probes/workbuddy-managed-recovery.js';

function fixture(failure=''){
  const calls:string[]=[];let polls=0;
  const services:ManagedRecoveryServices={
    ownIdle:async()=>{calls.push('idle');return failure!=='busy';},
    peerPending:async()=>{calls.push('peer');return failure!=='peer-ended';},
    shutdown:async()=>{calls.push('shutdown');return failure!=='shutdown-unknown';},
    inspectOld:async()=>{calls.push('inspect');polls++;return failure==='death-unknown'?'unknown':failure==='still-live'||failure==='delayed-death'&&polls<3?'alive':'ended';},
    pause:async()=>{calls.push('pause');},
    restore:async()=>{calls.push('restore');return failure==='restore-unknown'?{status:'unknown',errorCode:'state_unknown'}:
      {status:'accepted',sessionRef:failure==='foreign-context'?'private-other':'private-original',receiptEvidence:'synthetic-native'};},
    replacementMatches:async()=>{calls.push('replacement');return failure!=='bad-replacement';},
    recall:async()=>{calls.push('recall');return failure!=='wrong-context';},
  };
  return {calls,run:()=>recoverManagedBackend('private-original',services)};
}
test('isolated recovery waits for proven old process death and retains the original context while its peer is pending',async()=>{
  for(const mode of ['','delayed-death']){
    const f=fixture(mode),report=await f.run();assert.equal(report['status'],'observed');
    assert.equal(report['oldProcessDeathProven'],true);assert.equal(report['originalContextRestored'],true);assert.equal(report['peerPendingAfterRecall'],true);
    assert.equal(f.calls.filter(call=>call==='shutdown').length,1);assert.equal(f.calls.filter(call=>call==='restore').length,1);
    assert.doesNotMatch(JSON.stringify(report),/private-|synthetic-native/);
  }
});
test('busy, ended peer, uncertain shutdown or uncertain process death cannot activate or replay recovery',async()=>{
  for(const mode of ['busy','peer-ended','shutdown-unknown','death-unknown','still-live']){
    const f=fixture(mode),report=await f.run();assert.equal(report['status'],'unverified',mode);
    assert.equal(f.calls.includes('restore'),false,mode);assert.ok(f.calls.filter(call=>call==='shutdown').length<=1);
    assert.ok(f.calls.filter(call=>call==='pause').length<=30);
  }
});
test('unknown restore, foreign context, wrong replacement or wrong recalled context cannot become observed and never retry',async()=>{
  for(const mode of ['restore-unknown','foreign-context','bad-replacement','wrong-context']){
    const f=fixture(mode),report=await f.run();assert.equal(report['status'],'unverified',mode);
    assert.equal(f.calls.filter(call=>call==='restore').length,1);assert.equal(f.calls.filter(call=>call==='shutdown').length,1);
    if(['restore-unknown','foreign-context','bad-replacement'].includes(mode))assert.equal(f.calls.includes('recall'),false);
  }
});
