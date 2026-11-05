import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from '../fixtures/rig.js';
import { request } from '../fixtures/interaction.js';

function code(r:ReturnType<typeof rig>,id='synthetic-request'):string{return (r.db.prepare('SELECT publicCode FROM pending_inputs WHERE vendorRequestId=?').get(id) as {publicCode:string}).publicCode;}
test('Q-11 text answer, approve and deny return to the original request once without a new task',async()=>{
  for(const kind of ['text','approve','deny']){const r=rig();try{
    await r.courier.accept(r.platform.inbound('first'));request(r,kind==='text'?'question':'permission');await r.courier.flush();
    assert.equal(r.platform.visible.length,1);
    const text=kind==='text'?`/答复 ${code(r)} {"literal":"text"}`:kind==='approve'?`/批准 ${code(r)}`:`/拒绝 ${code(r)}`;
    const event=r.platform.inbound(text);assert.equal((await r.courier.accept(event)).status,'accepted');
    for(let i=0;i<10;i++)await r.courier.accept({...event,transportMessageId:`retry-${i}`});
    await r.courier.accept(r.platform.inbound(text));assert.equal(r.harness.count('answer'),1);assert.equal(r.harness.count('start'),1);
    assert.equal((r.db.prepare('SELECT answerStatus FROM pending_inputs').get() as {answerStatus:string}).answerStatus,'accepted');
    assert.notEqual((r.db.prepare('SELECT status FROM runs').get() as {status:string}).status,'completed');
  }finally{await r.dispose();}}
});
test('Q-12/Q-13 ambiguous, cross-private and withdrawn requests never authorize; ordinary supplements still steer',async()=>{
  const r=rig();try{
    await r.courier.accept(r.platform.inbound());const original=request(r,'permission');await r.courier.flush();assert.equal(r.platform.visible.length,1);
    await r.courier.accept(r.platform.inbound('同意'));assert.equal(r.harness.count('answer'),0);assert.equal(r.harness.count('steer'),0);
    await r.courier.accept(r.platform.inbound(`/批准 ${code(r)}`,'synthetic-private-b'));assert.equal(r.harness.count('answer'),0);assert.equal(r.harness.count('start'),1);
    await r.courier.accept(r.platform.inbound('/补充 new instruction'));assert.equal(r.harness.count('steer'),1);
    r.harness.emit(original.ref,original.runRef,'input.invalidated',{vendorRequestId:original.id,reason:'withdrawn'});
    await r.courier.accept(r.platform.inbound(`/批准 ${code(r)}`));assert.equal(r.harness.count('answer'),0);
  }finally{await r.dispose();}
});
test('form answers enforce original field and choice types; multi-scope permission requires an explicit option',async()=>{
  const r=rig();try{
    await r.courier.accept(r.platform.inbound());request(r,'question',{schema:{mode:'form',fields:[{fieldId:'F1',label:'synthetic choice',required:true,valueType:'choice',options:[{code:'A',label:'first'}]}]}});
    await r.courier.flush();assert.equal(r.platform.visible.length,1);
    for(const answer of ['{}','{"F1":"B"}','{"F1":["A"]}','{"F1":"A","unknown":"x"}'])await r.courier.accept(r.platform.inbound(`/答复 ${code(r)} ${answer}`));
    assert.equal(r.harness.count('answer'),0);await r.courier.accept(r.platform.inbound(`/答复 ${code(r)} {"F1":"A"}`));assert.equal(r.harness.count('answer'),1);
    request(r,'permission',{id:'permission-two',permissionOptions:[{code:'O1',label:'once',decision:'approve'},{code:'O2',label:'scope',decision:'approve'},{code:'D1',label:'deny',decision:'deny'}]});
    await r.courier.accept(r.platform.inbound(`/批准 ${code(r,'permission-two')}`));assert.equal(r.harness.count('answer'),1);
    await r.courier.accept(r.platform.inbound(`/批准 ${code(r,'permission-two')} O1`));assert.equal(r.harness.count('answer'),2);
  }finally{await r.dispose();}
});
test('unknown permission reception remains open and cannot submit another approve or deny',async()=>{
  const r=rig();try{
    await r.courier.accept(r.platform.inbound());request(r,'permission');r.harness.options.receiptStatus='unknown';
    assert.equal((await r.courier.accept(r.platform.inbound(`/批准 ${code(r)}`))).status,'unknown');
    await r.courier.accept(r.platform.inbound(`/拒绝 ${code(r)}`));assert.equal(r.harness.count('answer'),1);
    assert.deepEqual(r.db.prepare('SELECT validity,answerStatus FROM pending_inputs').get(),{validity:'open',answerStatus:'unknown'});
  }finally{await r.dispose();}
});
