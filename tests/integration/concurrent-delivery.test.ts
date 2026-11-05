import test from 'node:test';
import assert from 'node:assert/strict';
import { rig } from '../fixtures/rig.js';
test('a held send for one private conversation cannot block another conversation or input control',async()=>{
  const r=rig();let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const tasks:Promise<void>[]=[];
  try{
    const original=r.platform.send.bind(r.platform);
    r.platform.send=async(...args)=>{if(args[1].platformConversationId==='synthetic-private-a')await gate;return original(...args);};
    await r.courier.accept(r.platform.inbound('a'));const [ref,state]=[...r.harness.sessions][0]!;
    r.harness.message(ref,state.activeRun!,'progress','held-a');tasks.push(r.courier.flush());
    await r.courier.accept(r.platform.inbound('b','synthetic-private-b'));const [refB,stateB]=[...r.harness.sessions][1]!;
    r.harness.message(refB,stateB.activeRun!,'final','visible-b');r.harness.complete(refB);tasks.push(r.courier.flush());
    await r.courier.accept(r.platform.inbound('steer while sending','synthetic-private-a'));
    for(let i=0;i<20;i++)await Promise.resolve();
    assert.ok(r.platform.visible.some(item=>item.payload==='visible-b'));assert.equal(r.harness.count('steer'),1);
  }finally{release();await Promise.allSettled(tasks);await r.dispose();}
});
