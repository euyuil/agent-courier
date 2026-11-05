import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from '../fixtures/rig.js';
import { recordReceipt } from '../../src/application/dispatch.js';
import { decode } from '../../src/storage/records.js';
import type { HarnessOperation } from '../../src/domain/run.js';

test('Q-19 create/start/steer dispatch crashes never replay, and accepted facts survive restart', async () => {
  for(const kind of ['create','start','steer']) for(const phase of ['before_call','after_remote','after_commit'] as const) {
    const r=rig();
    try {
      if(kind==='steer') await r.courier.accept(r.platform.inbound('initial'));
      r.harness.options.silentEvents=true;
      r.boundary((point,operation)=>{if(point===phase&&operation===kind)throw new Error('synthetic_crash');});
      await assert.rejects(r.courier.accept(r.platform.inbound('crashing input')),{message:'synthetic_crash'});
      r.boundary(undefined);const count=r.harness.count(kind);await r.restart();
      assert.equal(r.harness.count(kind),count);
      const row=r.db.prepare('SELECT status FROM harness_operations WHERE kind=? ORDER BY rowid DESC LIMIT 1').get(kind) as {status:string};
      assert.equal(row.status,phase==='after_commit'?'accepted':'unknown');
      if(phase!=='after_commit') {
        await r.courier.accept(r.platform.inbound('new unsafe input'));
        assert.equal(r.harness.count('start'),kind==='steer'?1:kind==='start'&&phase==='after_remote'?1:0);
      }
    } finally {await r.dispose();}
  }
});
test('Q-21 completion arriving before receipt never rolls back to running', async () => {
  const r=rig();
  try {
    await r.courier.accept(r.platform.inbound('first'));
    const [ref,state]=[...r.harness.sessions][0]!;
    r.harness.message(ref,state.activeRun!,'final','synthetic');r.harness.complete(ref);
    const op=r.db.prepare("SELECT id,inputId FROM harness_operations WHERE kind='start'").get() as {id:string;inputId:string};
    const run=r.db.prepare('SELECT harnessRunRef FROM runs').get() as {harnessRunRef:string};
    r.harness.emit(ref,run.harnessRunRef,'input.accepted',{operationId:op.id,inputId:op.inputId,receiptEvidence:'synthetic-late-acceptance'});
    assert.equal((r.db.prepare('SELECT status FROM runs').get() as {status:string}).status,'completed');
  } finally {await r.dispose();}
});
test('contradictory completion or operation evidence preserves established facts and blocks new effects',async()=>{
  for(const kind of ['completion','operation']){const r=rig();try{
    await r.courier.accept(r.platform.inbound());const [ref,state]=[...r.harness.sessions][0]!,runRef=state.activeRun!;
    r.harness.message(ref,runRef,'final','synthetic final');r.harness.complete(ref);
    if(kind==='completion')r.harness.emit(ref,runRef,'run.failed',{errorCode:'synthetic',safeReason:'synthetic',completionEvidence:'contradictory-failure'});
    else {
      const operation=decode<HarnessOperation>(r.db.prepare("SELECT * FROM harness_operations WHERE kind='start'").get())!;
      recordReceipt(r.courier.runtime,operation,{status:'rejected',errorCode:'stale_run',definitelyNotAccepted:true});
      assert.equal((r.db.prepare("SELECT status FROM inputs WHERE id=?").get(operation.inputId!) as {status:string}).status,'accepted');
    }
    assert.equal((r.db.prepare('SELECT status FROM runs').get() as {status:string}).status,'completed');
    assert.equal((r.db.prepare('SELECT status FROM harness_bindings').get() as {status:string}).status,'unknown');
    await r.courier.accept(r.platform.inbound('unsafe next input'));assert.equal(r.harness.count('start'),1);
    await r.courier.flush();assert.ok(r.platform.visible.some(x=>x.payload.includes('冲突')));assert.ok(r.platform.visible.every(x=>!x.payload.includes('已明确执行失败')));
  }finally{await r.dispose();}}
});
