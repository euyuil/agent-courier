import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { rig } from '../fixtures/rig.js';

test('Courier drains a held delivery and removes every subscription even when Harness disconnect fails',async()=>{
  const r=rig();let release!:()=>void,done=false,disconnects=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const originalSend=r.platform.send.bind(r.platform),originalDisconnect=r.harness.disconnect.bind(r.harness);
  const unsubscribed:string[]=[];
  let flushing:Promise<void>|undefined,closed:Promise<void>|undefined;
  try {
    r.platform.send=async(...args)=>{await gate;return originalSend(...args);};
    await r.courier.accept(r.platform.inbound('synthetic'));
    const [ref,state]=[...r.harness.sessions][0]!;r.harness.message(ref,state.activeRun!,'progress','held');
    flushing=r.courier.flush();await new Promise(resolve=>setImmediate(resolve));
    r.harness.disconnect=async()=>{disconnects++;throw new Error('SYNTHETIC_PRIVATE_DISCONNECT_DETAIL');};
    r.courier.runtime.subscriptions.set('synthetic-throwing-subscription',()=>{unsubscribed.push('first');throw new Error('private subscription error');});
    r.courier.runtime.subscriptions.set('synthetic-last-subscription',()=>{unsubscribed.push('last');});
    const result=r.courier.close();
    closed=result.then(()=>{assert.fail('close must report the failed disconnect');},error=>{
      assert.equal(error.message,'state_unknown');done=true;
    });
    assert.equal(r.courier.close(),result);
    await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);
    release();await flushing;await closed;
    assert.equal(done,true);assert.equal(disconnects,1);assert.deepEqual(unsubscribed,['first','last']);
    assert.equal(r.courier.runtime.subscriptions.size,0);
  }finally{
    release();await Promise.allSettled([flushing,closed]);r.harness.disconnect=originalDisconnect;
    await r.courier.close().catch(()=>{});r.db.close();rmSync(dirname(r.config.storage.databasePath),{recursive:true,force:true});
  }
});

test('a failed recipient cannot let shutdown finish before another in-flight delivery settles',async()=>{
  const r=rig();let release!:()=>void,entered!:()=>void,closed=false,failed=false,armed=true,heldPayload='';
  const gate=new Promise<void>(resolve=>{release=resolve;}),sending=new Promise<void>(resolve=>{entered=resolve;});
  const original=r.platform.send.bind(r.platform);
  let flushing:Promise<void>|undefined,closing:Promise<void>|undefined;
  try {
    for(const name of ['a','b']) {
      await r.courier.accept(r.platform.inbound('synthetic',`synthetic-private-${name}`));
      const [ref,state]=[...r.harness.sessions].at(-1)!;
      r.harness.message(ref,state.activeRun!,'final',`synthetic-${name}`);r.harness.complete(ref);
    }
    r.boundary((phase,kind)=>{if(armed&&phase==='before_call'&&kind==='send'){armed=false;throw new Error('synthetic_batch_failure');}});
    r.platform.send=async(...args)=>{heldPayload=args[2];entered();await gate;return original(...args);};
    flushing=r.courier.flush().then(()=>{assert.fail('flush must report the failed recipient');},error=>{
      assert.equal(error.message,'synthetic_batch_failure');failed=true;
    });
    await sending;await new Promise(resolve=>setImmediate(resolve));
    closing=r.courier.close().then(()=>{closed=true;});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);
    release();await flushing;await closing;
    assert.equal(failed,true);assert.equal(closed,true);
    assert.ok(['synthetic-a','synthetic-b'].includes(heldPayload));
    assert.equal(r.platform.attempts.length,1);assert.deepEqual(r.platform.visible.map(item=>item.payload),[heldPayload]);
    assert.deepEqual(r.db.prepare('SELECT status FROM outbound_deliveries ORDER BY status').all(),[{status:'delivered'},{status:'sending'}]);
    r.boundary(undefined);await r.restart();await r.courier.flush();
    assert.deepEqual(r.db.prepare('SELECT status FROM outbound_deliveries ORDER BY status').all(),[{status:'delivered'},{status:'unknown'}]);
    assert.equal(r.platform.attempts.length,1);
  }finally{release();await Promise.allSettled([flushing,closing]);await r.dispose();}
});
