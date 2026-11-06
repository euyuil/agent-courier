import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from '../fixtures/rig.js';
import { reconcile } from '../../src/application/reconcile.js';
import { request } from '../fixtures/interaction.js';
import type { HarnessOperation } from '../../src/domain/run.js';
import type { Inspection,Receipt } from '../../src/adapters/harness/port.js';
import { decode } from '../../src/storage/records.js';
test('authoritative operation queries reconcile facts without repeating any Harness operation',async()=>{
  for(const status of ['accepted','rejected','unsupported'] as const){const r=rig();try{
    r.harness.options.receiptStatus='unknown';
    await r.courier.accept(r.platform.inbound());
    const op=r.db.prepare("SELECT id FROM harness_operations WHERE kind='create'").get() as {id:string};
    const ref=[...r.harness.sessions.keys()][0]!;
    r.harness.inspections.set(op.id,status==='unsupported'?{status:'unsupported'}:{status:'known',authoritative:true,evidenceRef:'synthetic-query',receipt:status==='accepted'
      ?{status:'accepted',sessionRef:ref,receiptEvidence:'synthetic-query-acceptance'}:{status:'rejected',errorCode:'steer_rejected',definitelyNotAccepted:true}});
    const count=r.harness.calls.length;assert.equal(await reconcile(r.courier.runtime,{operation:op.id}),status!=='unsupported');assert.equal(r.harness.calls.length,count);
    const binding=r.db.prepare('SELECT status,harnessSessionId FROM harness_bindings').get() as {status:string;harnessSessionId?:string};
    assert.equal(binding.status,status==='accepted'?'ready':status==='rejected'?'blocked':'unknown');
    if(status==='accepted')assert.equal(binding.harnessSessionId,ref);
    assert.equal(r.harness.count('start'),0);
  }finally{await r.dispose();}}
});
test('accepted query alone does not claim a previously unknown Run is still running',async()=>{
  const r=rig();try{
    await r.courier.accept(r.platform.inbound());const [ref]=[...r.harness.sessions][0]!;
    r.harness.options.silentEvents=true;r.harness.options.receiptStatus='unknown';
    const active=r.harness.sessions.get(ref)!;r.harness.message(ref,active.activeRun!,'final','synthetic');r.harness.complete(ref);
    await r.courier.accept(r.platform.inbound('unknown start'));
    const operation=r.db.prepare("SELECT id FROM harness_operations WHERE kind='start' AND status='unknown'").get() as {id:string};
    const runRef=active.activeRun!;
    r.harness.inspections.set(operation.id,{status:'known',authoritative:true,evidenceRef:'synthetic-query',receipt:{status:'accepted',sessionRef:ref,runRef,receiptEvidence:'synthetic-query-acceptance'}});
    const count=r.harness.count('start');assert.equal(await reconcile(r.courier.runtime,{operation:operation.id}),true);assert.equal(r.harness.count('start'),count);
    assert.equal((r.db.prepare('SELECT status FROM runs ORDER BY rowid DESC LIMIT 1').get() as {status:string}).status,'unknown');
  }finally{await r.dispose();}
});

test('reconciliation rejects changed or already owned Harness session identities without an SQL exception or another dispatch',async()=>{
  for(const kind of ['create','load'] as const){const r=rig();try{
    await r.courier.accept(r.platform.inbound());const original=[...r.harness.sessions.keys()][0]!;
    r.harness.message(original,r.harness.sessions.get(original)!.activeRun!,'final','synthetic original final');r.harness.complete(original);
    r.harness.options.receiptStatus='unknown';r.harness.options.silentEvents=true;
    if(kind==='load')await r.restart();
    await r.courier.accept(r.platform.inbound('uncertain operation',kind==='create'?'synthetic-private-b':'synthetic-private-a'));
    const op=decode<HarnessOperation>(r.db.prepare('SELECT * FROM harness_operations WHERE kind=? AND status=?').get(kind,'unknown'))!;
    const before=r.db.prepare('SELECT harnessSessionId FROM harness_bindings WHERE id=?').get(op.bindingId);
    r.harness.inspections.set(op.id,{status:'known',authoritative:true,evidenceRef:'synthetic-query',receipt:{status:'accepted',
      sessionRef:kind==='create'?original:'synthetic-foreign-session',receiptEvidence:'synthetic-query-acceptance'}});
    const calls=r.harness.calls.length;
    assert.equal(await reconcile(r.courier.runtime,{operation:op.id}),false);
    assert.deepEqual(r.db.prepare('SELECT harnessSessionId FROM harness_bindings WHERE id=?').get(op.bindingId),before);
    assert.deepEqual(r.db.prepare('SELECT status,resultCode FROM harness_operations WHERE id=?').get(op.id),{status:'unknown',resultCode:'protocol_conflict'});
    assert.equal(r.harness.calls.length,calls);
  }finally{await r.dispose();}}
});

test('a conflicting or malformed query receipt cannot apply its accompanying Run state',async()=>{
  for(const fault of ['foreign-run','missing-run','empty-evidence','unproven-rejection'] as const){const r=rig();try{
    await r.courier.accept(r.platform.inbound());const {ref,runRef}=request(r);
    r.harness.options.receiptStatus='unknown';r.harness.options.silentEvents=true;
    await r.courier.accept(r.platform.inbound('uncertain supplement'));
    const op=r.db.prepare("SELECT id FROM harness_operations WHERE kind='steer' AND status='unknown'").get() as {id:string};
    const receipt=(fault==='unproven-rejection'?{status:'rejected',errorCode:'stale_run'}:{status:'accepted',sessionRef:ref,
      ...(fault!=='missing-run'?{runRef:fault==='foreign-run'?'synthetic-foreign-run':runRef}:{}),
      receiptEvidence:fault==='empty-evidence'?'':'synthetic-query-acceptance'}) as Receipt;
    r.harness.inspections.set(op.id,{status:'known',authoritative:true,evidenceRef:'synthetic-query',receipt,runState:'completed'});
    const calls=r.harness.calls.length;
    assert.equal(await reconcile(r.courier.runtime,{operation:op.id}),false);
    assert.deepEqual(r.db.prepare('SELECT status,harnessRunRef FROM runs').get(),{status:'waiting_input',harnessRunRef:runRef});
    assert.equal((r.db.prepare('SELECT validity FROM pending_inputs').get() as {validity:string}).validity,'open');
    assert.deepEqual(r.db.prepare('SELECT status,resultCode FROM harness_operations WHERE id=?').get(op.id),{status:'unknown',resultCode:'protocol_conflict'});
    assert.equal(r.harness.calls.length,calls);
  }finally{await r.dispose();}}
});

test('an authoritative original Run terminal query closes its pending requests and projects the corresponding limitation once',async()=>{
  for(const state of ['completed','failed'] as const){const r=rig();try{
    await r.courier.accept(r.platform.inbound());const {ref,runRef}=request(r);
    r.harness.options.receiptStatus='unknown';r.harness.options.silentEvents=true;
    await r.courier.accept(r.platform.inbound('uncertain supplement'));
    const op=r.db.prepare("SELECT id FROM harness_operations WHERE kind='steer' AND status='unknown'").get() as {id:string};
    r.harness.inspections.set(op.id,{status:'known',authoritative:true,evidenceRef:'synthetic-original-query',receipt:{status:'accepted',
      sessionRef:ref,runRef,receiptEvidence:'synthetic-query-acceptance'},runState:state});
    const calls=r.harness.calls.length;
    assert.equal(await reconcile(r.courier.runtime,{operation:op.id}),true);
    assert.deepEqual(r.db.prepare('SELECT status,completionEvidenceRef FROM runs').get(),{status:state,completionEvidenceRef:'synthetic-original-query'});
    assert.equal((r.db.prepare('SELECT validity FROM pending_inputs').get() as {validity:string}).validity,'closed_by_run');
    assert.equal((r.db.prepare('SELECT count(*) n FROM failure_notices WHERE code=?').get(state==='completed'?'content_missing':'run_failed') as {n:number}).n,1);
    assert.equal(r.harness.calls.length,calls);
  }finally{await r.dispose();}}
});

test('a query finishing after a newer operation fact preserves that fact and its original Run state',async()=>{
  const r=rig();try{
    await r.courier.accept(r.platform.inbound());const {ref,runRef}=request(r);
    r.harness.options.receiptStatus='unknown';r.harness.options.silentEvents=true;
    await r.courier.accept(r.platform.inbound('uncertain supplement'));
    const op=decode<HarnessOperation>(r.db.prepare("SELECT * FROM harness_operations WHERE kind='steer' AND status='unknown'").get())!;
    let finish!:(value:Inspection)=>void;const answer=new Promise<Inspection>(resolve=>{finish=resolve;});r.harness.inspect=()=>answer;
    const reconciling=reconcile(r.courier.runtime,{operation:op.id});
    r.harness.emit(ref,runRef,'input.accepted',{operationId:op.id,inputId:op.inputId!,receiptEvidence:'synthetic-newer-event'});
    finish({status:'known',authoritative:true,evidenceRef:'synthetic-stale-query',receipt:{status:'rejected',errorCode:'stale_run',definitelyNotAccepted:true},runState:'completed'});
    assert.equal(await reconciling,false);
    assert.equal((r.db.prepare('SELECT status FROM runs').get() as {status:string}).status,'waiting_input');
    assert.equal((r.db.prepare('SELECT status FROM harness_operations WHERE id=?').get(op.id) as {status:string}).status,'accepted');
    assert.equal((r.db.prepare('SELECT resultCode FROM harness_operations WHERE id=?').get(op.id) as {resultCode:string}).resultCode,'protocol_conflict');
  }finally{await r.dispose();}
});
