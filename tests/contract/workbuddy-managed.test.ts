import test from 'node:test';
import assert from 'node:assert/strict';
import type { HarnessPort,ProbeReport,Receipt } from '../../src/adapters/harness/port.js';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';
import { requiredCapabilities,optionalCapabilities } from '../../src/domain/capabilities.js';
import { ManagedWorkBuddy,type ManagedEndpoint } from '../../src/adapters/workbuddy-experimental/managed.js';

function fixture(mode='normal',isolateRuntimes=false) {
  const data=new Map<string,unknown>(),calls:string[]=[],links:ManagedEndpoint[]=[],listeners=new Map<string,Set<(event:HarnessEvent)=>void>>();
  const writers=new Map<string,{tag:number;alive:()=>boolean}>(),runs=new Map<string,string>(),managementOwners:(string|undefined)[]=[];let connections=0,creations=0,starts=0,eventSequence=0;
  let releaseContext:(()=>void)|undefined;
  const store={get:(key:string)=>data.get(key),set:(key:string,value:unknown)=>{data.set(key,value);}};
  const emit=(session:string,type:HarnessEvent['eventType'],payload:unknown,runRef=runs.get(session)??'private-unknown')=>{
    const event={schemaVersion:1,eventKey:`private-event-${eventSequence++}`,sessionRef:session,runRef,eventType:type,payload} as HarnessEvent;
    for(const callback of listeners.get(session)??[])callback(event);
  };
  const open=async(ref?:string,courierSessionId?:string):Promise<ManagedEndpoint>=>{
    if(!ref)managementOwners.push(courierSessionId);
    const tag=++connections;let alive=true;calls.push(ref?`connect-${ref}`:'connect-management');
    if(ref&&mode==='delayed-context')await new Promise<void>(resolve=>{releaseContext=resolve;});
    const report=():ProbeReport=>({kind:'harness',product:'synthetic',productVersion:'synthetic',cliVersion:'synthetic',adapterVersion:'1',contextFingerprint:'synthetic-managed',
      authenticationStatus:alive?'authenticated':'unknown',evidenceRefs:[],limitations:[],capabilities:Object.fromEntries([...requiredCapabilities,...optionalCapabilities]
        .map(capability=>[capability,['typedVisibleOutput','messageAssembly','humanInteraction'].includes(capability)?'unverified':'supported'])) as ProbeReport['capabilities']});
    const accepted=(sessionRef:string,runRef?:string):Receipt=>({status:'accepted',sessionRef,...(runRef?{runRef}:{}),receiptEvidence:'synthetic-native'});
    const adapter:HarnessPort={
      probe:async()=>report(),
      createSession:input=>({operationId:input.operationId,receipt:(async()=>{
        assert.equal(ref,undefined);calls.push('create');creations++;
        if(mode==='unknown-create')return {status:'unknown' as const,errorCode:'state_unknown' as const};
        const session=`private-A${creations}`;store.set(`session:${session}`,{courierSessionId:input.courierSessionId});writers.set(session,{tag,alive:()=>alive});return accepted(session);
      })()}),
      resumeSession:input=>({operationId:input.operationId,receipt:(async()=>{
        calls.push(`load-${input.sessionRef}`);assert.equal(input.sessionRef,ref);
        const writer=writers.get(ref!);if(mode==='foreign-writer'||writer?.alive()&&writer.tag!==tag)return {status:'rejected' as const,errorCode:'writer_occupied' as const,definitelyNotAccepted:true as const};
        if(mode==='unknown-load')return {status:'unknown' as const,errorCode:'state_unknown' as const};
        writers.set(ref!,{tag,alive:()=>alive});return accepted(ref!);
      })()}),
      start:input=>{
        calls.push(`start-${input.sessionRef}`);starts++;const run=`private-run-${starts}`;runs.set(input.sessionRef,run);
        emit(input.sessionRef,'run.started',{clientRunId:input.clientRunId,runRef:run},run);
        if(mode==='early-completion')emit(input.sessionRef,'run.completed',{completionEvidence:'synthetic-complete',stopReason:'end_turn'},run);
        return {operationId:input.operationId,receipt:Promise.resolve(mode==='unknown-receipt'?{status:'unknown',errorCode:'state_unknown'}:accepted(input.sessionRef,run))};
      },
      steer:input=>{calls.push(`steer-${input.sessionRef}`);return {operationId:input.operationId,receipt:Promise.resolve(accepted(input.sessionRef,input.expectedRunRef))};},
      answer:input=>{calls.push(`answer-${input.sessionRef}`);return {operationId:input.operationId,receipt:Promise.resolve({...accepted(input.sessionRef,input.runRef),vendorRequestId:input.vendorRequestId})};},
      subscribe:(session,listener)=>{const set=listeners.get(session)??new Set();set.add(listener);listeners.set(session,set);return ()=>{set.delete(listener);};},
      inspect:async()=>({status:'unsupported'}),
      disconnect:async()=>{calls.push(ref?`close-${ref}`:'close-management');alive=false;
        if(mode==='close-failure'&&ref==='private-A1'||mode==='management-close-failure'&&!ref)throw new Error('private-error');},
    };
    const endpoint={adapter,connection:{get connected(){return alive;}}};links.push(endpoint);return endpoint;
  };
  const build=()=>new ManagedWorkBuddy({store,instanceId:'synthetic-instance',isolateRuntimes,connect:open});
  const finish=(ref:string)=>emit(ref,'run.completed',{completionEvidence:'synthetic-complete',stopReason:'end_turn'});
  return {data,calls,links,managementOwners,build,emit,finish,releaseContext(){releaseContext?.();},get starts(){return starts;},get creations(){return creations;}};
}
const start=(sessionRef:string,index:number)=>({operationId:`start-${index}`,sessionRef,inputId:`input-${index}`,text:'same synthetic body',clientRunId:`courier-run-${index}`});

test('ordinary managed routing releases the creator before loading each original A and keeps outputs and controls with their own context',async()=>{
  const f=fixture(),managed=f.build();await managed.connect();
  const a=await managed.createSession({operationId:'create-a',courierSessionId:'courier-a'}).receipt;
  assert.equal(a.status,'accepted');assert.deepEqual(f.calls.slice(0,4),['connect-management','create','close-management','connect-private-A1']);
  const b=await managed.createSession({operationId:'create-b',courierSessionId:'courier-b'}).receipt;assert.equal(b.status,'accepted');
  const aEvents:HarnessEvent[]=[],bEvents:HarnessEvent[]=[];
  managed.subscribe('private-A1',event=>aEvents.push(event));managed.subscribe('private-A2',event=>bEvents.push(event));
  try {
    const one=await managed.start(start('private-A1',1)).receipt,two=await managed.start(start('private-A2',2)).receipt;
    assert.equal(one.status,'accepted');assert.equal(two.status,'accepted');
    assert.equal((await managed.steer({operationId:'steer-a',sessionRef:'private-A1',inputId:'steer-input-a',text:'same synthetic body',expectedRunRef:'private-run-1'}).receipt).status,'accepted');
    assert.equal((await managed.answer({operationId:'answer-b',sessionRef:'private-A2',inputId:'answer-input-b',runRef:'private-run-2',vendorRequestId:'private-question',answer:{kind:'text',text:'synthetic'}}).receipt).status,'accepted');
    f.finish('private-A1');f.finish('private-A2');
    assert.ok(aEvents.every(event=>event.sessionRef==='private-A1'));assert.ok(bEvents.every(event=>event.sessionRef==='private-A2'));
    assert.equal(aEvents.length,2);assert.equal(bEvents.length,2);
    const report=await managed.probe('synthetic-instance');assert.equal(report.authenticationStatus,'authenticated');assert.equal(report.capabilities.typedVisibleOutput,'unverified');
    assert.equal(report.capabilities.createAndResume,'supported');
  }finally{await managed.disconnect('synthetic-instance');}
});
test('unknown creation and changed reuse of its operation cannot create another context after manager reconstruction',async()=>{
  const f=fixture('unknown-create'),one=f.build();await one.connect();
  assert.equal((await one.createSession({operationId:'create',courierSessionId:'courier-a'}).receipt).status,'unknown');await one.disconnect('synthetic-instance');
  const two=f.build();await two.connect();
  try {
    assert.equal((await two.createSession({operationId:'create',courierSessionId:'courier-a'}).receipt).status,'unknown');
    assert.equal((await two.createSession({operationId:'create',courierSessionId:'courier-b'}).receipt).status,'unknown');
    assert.equal(f.creations,1);
  }finally{await two.disconnect('synthetic-instance');}
});

test('automatic runtime selection persists each Courier owner before opening its separate backend and preserves corrupted routing as unknown',async()=>{
  const f=fixture('normal',true),managed=f.build();await managed.connect();
  try{
    assert.equal((await managed.createSession({operationId:'create-a',courierSessionId:'courier-a'}).receipt).status,'accepted');
    assert.equal((await managed.createSession({operationId:'create-b',courierSessionId:'courier-b'}).receipt).status,'accepted');
    assert.deepEqual(f.managementOwners,[undefined,'courier-a','courier-b']);
    assert.deepEqual(f.data.get('managed-host-scope:courier-a'),{mode:'isolated'});
    assert.equal((f.data.get('managed-owner:courier-b') as {runtimeIsolation:boolean}).runtimeIsolation,true);
    f.data.set('managed-host-scope:courier-c',{mode:'corrupted'});const before=f.managementOwners.length;
    assert.equal((await managed.createSession({operationId:'create-c',courierSessionId:'courier-c'}).receipt).status,'unknown');
    assert.equal(f.managementOwners.length,before);assert.equal(f.creations,2);
  }finally{await managed.disconnect('synthetic-instance');}
});

test('an idle isolated original context activates only its saved owner backend before loading, without creating another user context',async()=>{
  const f=fixture('normal',true),first=f.build();await first.connect();
  await first.createSession({operationId:'create',courierSessionId:'courier-a'}).receipt;await first.disconnect('synthetic-instance');
  const second=f.build();await second.connect();
  try{
    assert.equal((await second.resumeSession({sessionRef:'private-A1',operationId:'restore-original'}).receipt).status,'accepted');
    assert.deepEqual(f.managementOwners,[undefined,'courier-a',undefined,'courier-a']);assert.equal(f.creations,1);
    await second.disconnect('synthetic-instance');f.data.delete('managed-host-scope:courier-a');
    const third=f.build();await third.connect();const before=f.calls.length;
    try{assert.equal((await third.resumeSession({sessionRef:'private-A1',operationId:'damaged-original'}).receipt).status,'unknown');assert.equal(f.calls.length,before);}
    finally{await third.disconnect('synthetic-instance');}
  }finally{await second.disconnect('synthetic-instance');}
});
test('an early source completion is not overwritten by the later start receipt, and repeated commands cannot re-execute the task',async()=>{
  const f=fixture('early-completion'),managed=f.build();await managed.connect();
  await managed.createSession({operationId:'create-a',courierSessionId:'courier-a'}).receipt;
  try {
    const input=start('private-A1',1);assert.equal((await managed.start(input).receipt).status,'accepted');
    assert.equal((await managed.start(input).receipt).status,'accepted');assert.equal(f.starts,1);
    assert.equal((await managed.start({...input,text:'changed'}).receipt).status,'unknown');assert.equal(f.starts,1);
    assert.equal((await managed.start(start('private-A1',2)).receipt).status,'accepted');assert.equal(f.starts,2);
  }finally{await managed.disconnect('synthetic-instance');}
});
test('native source acceptance survives a lost early receipt, and distinct same-text steer inputs stay distinct',async()=>{
  const f=fixture('unknown-receipt'),managed=f.build();await managed.connect();await managed.createSession({operationId:'create',courierSessionId:'courier-a'}).receipt;
  try {
    const input=start('private-A1',1);assert.equal((await managed.start(input).receipt).status,'accepted');
    for(const index of [1,2])assert.equal((await managed.steer({operationId:`s-${index}`,sessionRef:'private-A1',expectedRunRef:'private-run-1',inputId:`si-${index}`,text:'identical text'}).receipt).status,'accepted');
    assert.equal(f.calls.filter(call=>call==='steer-private-A1').length,2);
    assert.equal((await managed.start(input).receipt).status,'accepted');assert.equal(f.starts,1);
    f.finish('private-A1');
  }finally{await managed.disconnect('synthetic-instance');}
});

test('a duplicate start event for the completed original Run cannot occupy its context again',async()=>{
  const f=fixture('early-completion'),managed=f.build();await managed.connect();
  await managed.createSession({operationId:'create',courierSessionId:'courier-a'}).receipt;
  try{
    assert.equal((await managed.start(start('private-A1',1)).receipt).status,'accepted');
    f.emit('private-A1','run.started',{clientRunId:'courier-run-1',runRef:'private-run-1'},'private-run-1');
    assert.equal((await managed.start(start('private-A1',2)).receipt).status,'accepted');assert.equal(f.starts,2);
  }finally{await managed.disconnect('synthetic-instance');}
});
test('control loss persists unknown across manager reconstruction and cannot reload or restart the original in-flight Run',async()=>{
  const f=fixture(),one=f.build();await one.connect();await one.createSession({operationId:'create',courierSessionId:'courier-a'}).receipt;
  await one.start(start('private-A1',1)).receipt;
  f.emit('private-A1','connection.lost',{unresolvedOperationIds:['start-1']});await one.disconnect('synthetic-instance');
  const two=f.build();await two.connect();const before=f.calls.length;
  try {
    assert.equal((await two.resumeSession({operationId:'resume-original',sessionRef:'private-A1'}).receipt).status,'unknown');
    assert.equal((await two.start(start('private-A1',2)).receipt).status,'unknown');
    assert.equal(f.calls.length,before);assert.equal(f.creations,1);assert.equal(f.starts,1);
  }finally{await two.disconnect('synthetic-instance');}
});
test('a known creation is preserved when releasing its management connection fails and cannot be replaced by another create',async()=>{
  const f=fixture('management-close-failure'),managed=f.build();await managed.connect();
  try {
    assert.equal((await managed.createSession({operationId:'create',courierSessionId:'courier-a'}).receipt).status,'unknown');
    const owner=f.data.get('managed-owner:courier-a') as Record<string,unknown>;assert.equal(owner['sessionRef'],'private-A1');
    assert.equal((await managed.createSession({operationId:'replacement',courierSessionId:'courier-a'}).receipt).status,'unknown');
    assert.equal(f.creations,1);assert.equal(f.calls.some(call=>call==='connect-private-A1'),false);
  }finally{await managed.disconnect('synthetic-instance');}
});
test('shutdown attempts every owned context even if one close fails and never accepts later work',async()=>{
  const f=fixture('close-failure'),managed=f.build();await managed.connect();
  await managed.createSession({operationId:'create-a',courierSessionId:'courier-a'}).receipt;
  await managed.createSession({operationId:'create-b',courierSessionId:'courier-b'}).receipt;
  await assert.rejects(managed.disconnect('synthetic-instance'),{message:'state_unknown'});
  assert.ok(f.calls.includes('close-private-A1'));assert.ok(f.calls.includes('close-private-A2'));
  const count=f.calls.length;assert.equal((await managed.start(start('private-A1',1)).receipt).status,'unknown');assert.equal(f.calls.length,count);
});
test('foreign writer or uncertain load cannot turn a known A into a usable context or trigger a replacement',async()=>{
  for(const mode of ['foreign-writer','unknown-load']){
    const f=fixture(mode),managed=f.build();await managed.connect();
    try {
      assert.equal((await managed.createSession({operationId:'create',courierSessionId:'courier-a'}).receipt).status,'unknown');
      assert.equal((await managed.createSession({operationId:'retry-new',courierSessionId:'courier-a'}).receipt).status,'unknown');
      assert.equal(f.creations,1);assert.equal(f.starts,0);
      const count=f.calls.length;assert.equal((await managed.resumeSession({operationId:'foreign',sessionRef:'external-context'}).receipt).status,'rejected');assert.equal(f.calls.length,count);
    }finally{await managed.disconnect('synthetic-instance');}
  }
});
test('a context connection completing during shutdown is closed before it can load or execute a task',async()=>{
  const f=fixture('delayed-context'),managed=f.build();await managed.connect();
  const created=managed.createSession({operationId:'create',courierSessionId:'courier-a'}).receipt;
  for(let i=0;i<10&&!f.calls.includes('connect-private-A1');i++)await new Promise(resolve=>setImmediate(resolve));
  assert.ok(f.calls.includes('connect-private-A1'));const closing=managed.disconnect('synthetic-instance');f.releaseContext();
  await closing;assert.equal((await created).status,'unknown');
  assert.equal(f.calls.includes('load-private-A1'),false);assert.equal(f.starts,0);assert.ok(f.links.every(link=>!link.connection.connected));
});
test('damaged persisted Run state cannot authorize another start or restore on the same context',async()=>{
  const f=fixture(),managed=f.build();await managed.connect();await managed.createSession({operationId:'create',courierSessionId:'courier-a'}).receipt;
  f.data.set('managed-run:private-A1',{status:'idle'});const before=f.calls.length;
  try {
    assert.equal((await managed.start(start('private-A1',1)).receipt).status,'unknown');
    assert.equal((await managed.resumeSession({operationId:'resume',sessionRef:'private-A1'}).receipt).status,'unknown');assert.equal(f.calls.length,before);
  }finally{await managed.disconnect('synthetic-instance');}
});
