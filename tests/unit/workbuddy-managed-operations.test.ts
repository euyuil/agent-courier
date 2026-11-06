import test from 'node:test';
import assert from 'node:assert/strict';
import type { Receipt } from '../../src/adapters/harness/port.js';
import { ManagedOperations } from '../../src/adapters/workbuddy-experimental/managed-operations.js';
import { managedRuntimeStore } from '../../src/adapters/workbuddy-experimental/managed-runtime.js';

function fixture(){const values=new Map<string,unknown>();return {values,journal:new ManagedOperations({get:key=>values.get(key),set:(key,value)=>{values.set(key,value);}})};}
const accepted:Receipt={status:'accepted',sessionRef:'private-A',runRef:'private-run',receiptEvidence:'synthetic-native'};
test('isolated backend records retain distinct hosts while sharing original Harness ownership and bootstrap provenance',()=>{
  const values=new Map<string,unknown>(),store={get:(key:string)=>values.get(key),set:(key:string,value:unknown)=>{values.set(key,value);}};
  store.set('desktop-host',{sessionRef:'probe-only-host'});
  for(const owner of ['courier-a','courier-b'])store.set(`managed-host-scope:${owner}`,{mode:'isolated'});
  const a=managedRuntimeStore(store,'courier-a',true),b=managedRuntimeStore(store,'courier-b',true);
  a.set('desktop-host',{sessionRef:'host-a'});b.set('desktop-host',{sessionRef:'host-b'});
  a.set('desktop-host-operation:operation',{status:'unknown'});b.set('desktop-host-operation:operation',{status:'ready'});
  assert.deepEqual(a.get('desktop-host'),{sessionRef:'host-a'});assert.deepEqual(b.get('desktop-host'),{sessionRef:'host-b'});
  assert.deepEqual(store.get('desktop-host'),{sessionRef:'probe-only-host'});
  assert.deepEqual(a.get('desktop-host-operation:operation'),{status:'unknown'});
  a.set('session:original-a',{courierSessionId:'courier-a'});a.set('bootstrap-provenance:host-a',{status:'verified'});
  assert.deepEqual(b.get('session:original-a'),{courierSessionId:'courier-a'});
  assert.deepEqual(store.get('bootstrap-provenance:host-a'),{status:'verified'});
  assert.equal(managedRuntimeStore(store,'legacy-owner'),store);
  assert.throws(()=>managedRuntimeStore(store,'missing-owner',true),{message:'state_unknown'});
  store.set('managed-host-scope:courier-a',{mode:'corrupt'});assert.throws(()=>managedRuntimeStore(store,'courier-a'),{message:'state_unknown'});
});
test('managed operation correlation ignores object key order while keeping different same-text inputs separate',async()=>{
  const f=fixture();let calls=0;
  const first={operationId:'one',sessionRef:'private-A',inputId:'input-one',text:'identical',expectedRunRef:'private-run'};
  const work=async()=>{calls++;return accepted;};
  assert.equal((await f.journal.execute('steer',first,work).receipt).status,'accepted');
  assert.equal((await f.journal.execute('steer',{text:'identical',expectedRunRef:'private-run',inputId:'input-one',sessionRef:'private-A',operationId:'one'},work).receipt).status,'accepted');
  assert.equal(calls,1);
  assert.equal((await f.journal.execute('steer',{...first,operationId:'two',inputId:'input-two'},work).receipt).status,'accepted');assert.equal(calls,2);
  assert.equal((await f.journal.execute('steer',{...first,operationId:'three'},work).receipt).status,'unknown');assert.equal(calls,2);
  assert.doesNotMatch(JSON.stringify([...f.values]),/identical/);
});
test('managed operation dispatch and an unknown result never replay across object reconstruction',async()=>{
  const f=fixture(),input={operationId:'one',sessionRef:'private-A',inputId:'input',text:'private-body'};let calls=0;
  await f.journal.execute('start',input,async()=>{calls++;return {status:'unknown',errorCode:'state_unknown'};}).receipt;
  const next=new ManagedOperations({get:key=>f.values.get(key),set:(key,value)=>{f.values.set(key,value);}});
  assert.equal((await next.execute('start',input,async()=>{calls++;return accepted;}).receipt).status,'unknown');assert.equal(calls,1);
  assert.equal(next.accepted('one',accepted),true);
  assert.equal((await next.execute('start',input,async()=>{calls++;return accepted;}).receipt).status,'accepted');assert.equal(calls,1);
});
test('late source acceptance must retain the original context and Run and cannot overwrite a definite rejection',async()=>{
  const f=fixture(),input={operationId:'one',sessionRef:'private-A',inputId:'input',expectedRunRef:'private-run',text:'private-body'};
  await f.journal.execute('steer',input,async()=>({status:'unknown',errorCode:'state_unknown'})).receipt;
  assert.equal(f.journal.accepted('one',{...accepted,status:'accepted',sessionRef:'private-B'}),false);
  assert.equal(f.journal.accepted('one',{...accepted,status:'accepted',runRef:'private-other-run'}),false);
  assert.equal(f.journal.accepted('one',accepted),true);
  await f.journal.execute('steer',{...input,operationId:'rejected',inputId:'other-input'},async()=>({status:'rejected',errorCode:'stale_run',definitelyNotAccepted:true})).receipt;
  assert.equal(f.journal.accepted('rejected',accepted),false);
  assert.equal((await f.journal.execute('steer',{...input,operationId:'rejected',inputId:'other-input'},async()=>accepted).receipt).status,'unknown');
});
