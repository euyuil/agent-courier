import test from 'node:test';
import assert from 'node:assert/strict';
import type { HarnessPort } from '../../src/adapters/harness/port.js';
import { ownedIsolationExperiment } from '../probes/workbuddy-isolation.js';

function fixture(failure='') {
  const calls:string[]=[],prompts:string[]=[];
  const adapter={createSession:()=>{calls.push('create-peer');return {operationId:'private-op',receipt:Promise.resolve(failure==='create-unknown'?
    {status:'unknown' as const,errorCode:'state_unknown' as const}:{status:'accepted' as const,sessionRef:failure==='same-session'?'private-original':'private-peer',receiptEvidence:'private-receipt'})};},
    resumeSession:({sessionRef}:{sessionRef:string})=>{calls.push(`load-${sessionRef}`);return {operationId:'private-load',receipt:Promise.resolve(failure==='load-unknown'?
      {status:'unknown' as const,errorCode:'state_unknown' as const}:{status:'accepted' as const,sessionRef,receiptEvidence:'private-resume'})};},
    disconnect:async()=>{calls.push('disconnect');},
  } satisfies Pick<HarnessPort,'createSession'|'resumeSession'|'disconnect'>;
  let runs=0;
  const run=async(_adapter:typeof adapter,session:string,text:string,_marker:string,other?:string)=>{
    calls.push(`run-${session}`);prompts.push(text);runs++;
    return {status:failure==='run-unknown'&&runs===1?'unknown':'accepted',completion:'completed',rawPromptStop:'end_turn',
      markerExact:failure!=='wrong-marker',foreignMarkerObserved:failure==='foreign-marker'&&other!==undefined,traceComplete:failure!=='truncated',toolCallFrames:0};
  };
  const experiment=()=>ownedIsolationExperiment(adapter,{sessionRef:'private-original',marker:'private-original-marker',bootstrap:'private-bootstrap'},
    async()=>{calls.push('reopen');return {...adapter};},()=>{calls.push('register-peer');},run);
  return {calls,prompts,experiment};
}
test('owned isolation creates one distinct peer and recalls each original context without repeating markers or publishing identities',async()=>{
  const f=fixture(),report=await f.experiment();assert.equal(report['status'],'observed');
  assert.deepEqual(f.calls.filter(call=>call.startsWith('load-')),['load-private-original','load-private-peer']);
  assert.deepEqual(f.calls.filter(call=>call.startsWith('run-')),['run-private-peer','run-private-original','run-private-peer']);
  assert.equal(f.prompts.length,3);assert.doesNotMatch(f.prompts[1]!,/private-original-marker|CourierIsolatedContext-/);
  assert.doesNotMatch(f.prompts[2]!,/private-original-marker|CourierIsolatedContext-/);
  assert.doesNotMatch(JSON.stringify(report),/private-original|private-peer|private-bootstrap|private-receipt/);
});
test('uncertain, reused, foreign, incomplete or incorrect isolation observations stop before subsequent tasks and never retry',async()=>{
  for(const failure of ['create-unknown','same-session','run-unknown','wrong-marker','foreign-marker','truncated','load-unknown']) {
    const f=fixture(failure),report=await f.experiment();assert.equal(report['status'],'unverified',failure);
    assert.equal(f.calls.filter(call=>call==='create-peer').length,1,failure);
    assert.equal(f.calls.filter(call=>call==='reopen').length,failure==='load-unknown'?1:0,failure);
    assert.equal(f.prompts.length,['create-unknown','same-session'].includes(failure)?0:1,failure);
    assert.equal(f.calls.filter(call=>call==='load-private-peer').length,0,failure);
  }
});
