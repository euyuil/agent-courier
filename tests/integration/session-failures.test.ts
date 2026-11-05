import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from '../fixtures/rig.js';
import { sessionStatus } from '../../src/cli/status.js';

test('Q-09 writer conflict, missing original context and login failure never replace a Harness session',async()=>{
  for(const fault of ['writer','missing','auth']){const r=rig();try{
    await r.courier.accept(r.platform.inbound());const [ref,state]=[...r.harness.sessions][0]!;
    r.harness.message(ref,state.activeRun!,'final','synthetic');r.harness.complete(ref);await r.courier.flush();await r.restart();
    if(fault==='writer')r.harness.options.writerOccupied=true;
    if(fault==='missing')r.harness.sessions.delete(ref);
    if(fault==='auth')r.harness.options.authenticated=false;
    assert.equal((await r.courier.accept(r.platform.inbound('follow up'))).status,'rejected');assert.equal(r.harness.count('create'),1);
    assert.equal((r.db.prepare('SELECT harnessSessionId FROM harness_bindings').get() as {harnessSessionId:string}).harnessSessionId,ref);
  }finally{await r.dispose();}}
});
test('Q-18 raw adapter exceptions do not enter user messages or safe local status',async()=>{
  const r=rig();try{
    await r.courier.accept(r.platform.inbound('synthetic-private-body'));
    r.harness.steer=()=>{throw new Error('SYNTHETIC_SECRET /synthetic/private/path http://synthetic.invalid/token');};
    await r.courier.accept(r.platform.inbound('supplement'));await r.courier.flush();
    const id=(r.db.prepare('SELECT id FROM courier_sessions').get() as {id:string}).id;
    assert.doesNotMatch(JSON.stringify({status:sessionStatus(r.db,id),messages:r.platform.visible.map(x=>x.payload),logs:r.courier.runtime.diagnostics}),/SYNTHETIC_SECRET|synthetic-private-body|synthetic.invalid|private\/path/);
  }finally{await r.dispose();}
});
test('Q-10 missing final content is reported only when selected; partial progress survives explicit execution failure',async()=>{
  for(const final of [true,false]){const r=rig();try{
    r.courier.runtime.config.display.defaults.final=final;await r.courier.accept(r.platform.inbound());const [ref]=[...r.harness.sessions][0]!;
    r.harness.complete(ref);await r.courier.flush();assert.equal(r.platform.visible.length,final?1:0);
    if(final)assert.match(r.platform.visible[0]!.payload,/完整最终回答/);
    assert.equal((r.db.prepare('SELECT status FROM runs').get() as {status:string}).status,'completed');
  }finally{await r.dispose();}}
  const r=rig();try{
    await r.courier.accept(r.platform.inbound());const [ref,state]=[...r.harness.sessions][0]!,run=state.activeRun!;
    r.harness.message(ref,run,'progress','already visible progress');await r.courier.flush();
    r.harness.emit(ref,run,'run.failed',{errorCode:'synthetic',safeReason:'synthetic',completionEvidence:'synthetic-failure'});await r.courier.flush();
    assert.equal(r.platform.visible[0]!.payload,'already visible progress');assert.match(r.platform.visible[1]!.payload,/已明确执行失败/);
    assert.equal((r.db.prepare('SELECT status FROM runs').get() as {status:string}).status,'failed');
  }finally{await r.dispose();}
});
