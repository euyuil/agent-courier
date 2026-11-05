import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from '../fixtures/rig.js';
import { reconcile } from '../../src/application/reconcile.js';
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
