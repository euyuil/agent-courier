import test from 'node:test';
import assert from 'node:assert/strict';
import { fork,type ChildProcess } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeHarness } from '../fixtures/harness/fake-harness.js';
import { FakePlatform } from '../fixtures/platform/fake-platform.js';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';
import type { StartInput,SteerInput,AnswerInput,SessionInput } from '../../src/adapters/harness/port.js';
import type { Recipient,DeliveryRoute } from '../../src/adapters/dingtalk/port.js';

interface Snapshot {
  bindings:{id:string;harnessSessionId:string|null;status:string}[];
  operations:{id:string;kind:string;status:string;resultCode:string|null}[];
  runs:{id:string;harnessRunRef:string|null;status:string}[];
  pending:{id:string;publicCode:string;sourceMessageId:string;vendorRequestId:string;adapterMappingRef:string;validity:string;answerStatus:string}[];
  deliveries:{id:string;status:string;attemptCount:number}[];
}
async function processRig() {
  const dir=mkdtempSync(join(tmpdir(),'courier-process-')),path=join(dir,'state.sqlite');
  const harness=new FakeHarness(),platform=new FakePlatform(),children=new Set<ChildProcess>();
  const start=async()=>{
    const child=fork(fileURLToPath(new URL('../fixtures/courier-process.js',import.meta.url)),[],{stdio:['ignore','ignore','ignore','ipc']});
    children.add(child);let sequence=0;
    const waits=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>(),subscriptions=new Map<string,()=>void>();
    const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>{child.once('exit',(code,signal)=>{
      children.delete(child);for(const release of subscriptions.values())release();
      for(const wait of waits.values()){clearTimeout(wait.timer);wait.reject(new Error('synthetic_process_terminated'));}waits.clear();resolve({code,signal});
    });});
    child.on('error',()=>{for(const wait of waits.values()){clearTimeout(wait.timer);wait.reject(new Error('synthetic_process_unavailable'));}waits.clear();});
    const send=(message:unknown)=>{if(child.connected)child.send(message as Parameters<ChildProcess['send']>[0],()=>{});};
    child.on('message',(message:{id:number;method?:string;input?:unknown;ok?:boolean;result?:unknown})=>{
      if(!message.method){const wait=waits.get(message.id);waits.delete(message.id);if(wait){clearTimeout(wait.timer);
        if(message.ok)wait.resolve(message.result);else wait.reject(new Error('synthetic_command_failed'));}return;}
      void (async()=>{
        const input=message.input;let result:unknown;
        switch(message.method) {
          case 'harness.probe':result=await harness.probe(input as string);break;
          case 'harness.create':result=await harness.createSession(input as {operationId:string;courierSessionId:string}).receipt;break;
          case 'harness.load':result=await harness.resumeSession(input as SessionInput).receipt;break;
          case 'harness.start':result=await harness.start(input as StartInput).receipt;break;
          case 'harness.steer':result=await harness.steer(input as SteerInput).receipt;break;
          case 'harness.answer':result=await harness.answer(input as AnswerInput).receipt;break;
          case 'harness.inspect':result=await harness.inspect(input as {operationId?:string});break;
          case 'harness.subscribe':{
            const ref=input as string;if(!subscriptions.has(ref))subscriptions.set(ref,harness.subscribe(ref,event=>send({event})));break;
          }
          case 'harness.unsubscribe':subscriptions.get(input as string)?.();subscriptions.delete(input as string);break;
          case 'harness.disconnect':for(const release of subscriptions.values())release();subscriptions.clear();break;
          case 'platform.ack':await platform.ack(input as string);break;
          case 'platform.send':{const value=input as {deliveryId:string;recipient:Recipient;payload:string;route:DeliveryRoute};
            result=await platform.send(value.deliveryId,value.recipient,value.payload,value.route);break;}
          case 'platform.inspect':result=await platform.inspectDelivery(input as string);break;
          default:throw new Error('synthetic_method_invalid');
        }
        send({id:message.id,ok:true,result});
      })().catch(()=>send({id:message.id,ok:false}));
    });
    const call=<T=unknown>(method:string,input?:unknown):Promise<T>=>new Promise((resolve,reject)=>{
      const id=++sequence,timer=setTimeout(()=>{waits.delete(id);reject(new Error('synthetic_process_timeout'));},10000);
      waits.set(id,{resolve:value=>resolve(value as T),reject,timer});send({id,method,input});
    });
    await call('init',path);
    return {child,call,exited,snapshot:()=>call<Snapshot>('snapshot'),async close(){await call('close');assert.equal((await exited).code,0);}};
  };
  return {harness,platform,start,async dispose(){await Promise.all([...children].map(child=>new Promise<void>(resolve=>{
    child.once('exit',()=>resolve());child.kill('SIGKILL');})));rmSync(dir,{recursive:true,force:true});}};
}

test('a new Courier process loads the same external fake Harness context and never redelivers old logical messages',{timeout:20000},async()=>{
  const r=await processRig();try {
    const first=await r.start(),inbound=r.platform.inbound('synthetic retained context');
    assert.equal((await first.call<{status:string}>('accept',inbound)).status,'accepted');
    const [ref,state]=[...r.harness.sessions][0]!,events:HarnessEvent[]=[];
    const stop=r.harness.subscribe(ref,event=>events.push(event));
    r.harness.message(ref,state.activeRun!,'progress','same progress');r.harness.message(ref,state.activeRun!,'progress','same progress');
    r.harness.message(ref,state.activeRun!,'final','original final');r.harness.complete(ref);stop();
    await first.call('flush');const original=await first.snapshot();await first.close();
    const second=await r.start();assert.notEqual(second.child.pid,first.child.pid);
    assert.deepEqual((await second.snapshot()).bindings,original.bindings);
    assert.equal((await second.call<{status:string}>('accept',inbound)).status,'duplicate');
    for(const event of events)r.harness.emit(ref,event.runRef,event.eventType,event.payload,event.eventKey);
    await second.call('flush');assert.deepEqual(r.platform.visible.map(row=>row.payload),['same progress','same progress','original final']);
    await second.call('accept',r.platform.inbound('synthetic next turn'));
    assert.equal(r.harness.count('create'),1);assert.equal(r.harness.count('load'),1);assert.equal(r.harness.count('start'),2);
    assert.equal((r.harness.calls.find(call=>call.kind==='load')!.input as SessionInput).sessionRef,ref);
    assert.deepEqual(state.history,['synthetic retained context','synthetic next turn']);
    r.harness.message(ref,state.activeRun!,'final','next final');r.harness.complete(ref);await second.call('flush');
    assert.equal(r.platform.visible.at(-1)!.payload,'next final');await second.close();
  }finally{await r.dispose();}
});

test('SIGKILL at each effect boundary preserves original unknown or committed facts without repeating create/start/steer/answer/send',{timeout:60000},async()=>{
  for(const kind of ['create','start','steer','answer','send'])for(const phase of ['before_call','after_remote','after_commit']) {
    const r=await processRig();try {
      const first=await r.start();let answerCode:string|undefined;
      if(['steer','answer','send'].includes(kind)) {
        await first.call('accept',r.platform.inbound('synthetic initial'));const [ref,state]=[...r.harness.sessions][0]!;
        if(kind==='answer') {
          r.harness.emit(ref,state.activeRun!,'input.requested',{vendorRequestId:'synthetic-original-question',kind:'question',messageId:'synthetic-question-body',
            adapterMappingRef:'synthetic-original-mapping',answerSchema:{mode:'text'}});
          r.harness.message(ref,state.activeRun!,'question','synthetic original question','synthetic-question-body');
          answerCode=(await first.snapshot()).pending[0]!.publicCode;
        }
        if(kind==='send') {for(const [type,body] of [['progress','one'],['progress','two'],['final','three']] as const)r.harness.message(ref,state.activeRun!,type,body);
          r.harness.complete(ref);await first.snapshot();}
      }
      r.harness.options.silentEvents=true;
      await first.call('crashAt',{kind,phase});
      const input=r.platform.inbound(answerCode?`/答复 ${answerCode} synthetic answer`:'synthetic crashing input');
      await assert.rejects(first.call(kind==='send'?'flush':'accept',kind==='send'?undefined:input),{message:'synthetic_process_terminated'});
      assert.equal((await first.exited).signal,'SIGKILL');
      const count=kind==='send'?r.platform.attempts.length:r.harness.count(kind),second=await r.start();
      assert.notEqual(first.child.pid,second.child.pid);
      const recovered=await second.snapshot();
      if(kind==='send') {
        assert.equal(recovered.deliveries[0]!.status,phase==='after_commit'?'delivered':'unknown');
        assert.equal(recovered.deliveries[0]!.attemptCount,1);
      } else {
        assert.equal(recovered.operations.filter(op=>op.kind===kind).at(-1)!.status,phase==='after_commit'?'accepted':'unknown');
        assert.equal((await second.call<{status:string}>('accept',input)).status,'duplicate');
        if(kind==='answer') {
          assert.equal(recovered.pending[0]!.answerStatus,phase==='after_commit'?'accepted':'unknown');
          assert.equal(recovered.pending[0]!.vendorRequestId,'synthetic-original-question');
          assert.equal(recovered.pending[0]!.adapterMappingRef,'synthetic-original-mapping');
          await second.call('accept',r.platform.inbound(`/答复 ${answerCode} synthetic second answer`));
        }
      }
      await second.call('flush');
      if(kind==='send')assert.equal(r.platform.attempts.filter(attempt=>attempt.deliveryId===recovered.deliveries[0]!.id).length,count);
      else assert.equal(r.harness.count(kind),count);
      await second.close();
    }finally{await r.dispose();}
  }
});
