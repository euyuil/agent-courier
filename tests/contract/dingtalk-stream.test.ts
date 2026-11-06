import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DingTalkStream,type StreamWorker } from '../../src/adapters/dingtalk/stream.js';

class SyntheticWorker extends EventEmitter {
  stdout=new PassThrough();stderr=new PassThrough();
  throwStop=false;throwAck=false;terminations=0;ackPosts=0;
  termination:()=>Promise<number>=async()=>0;
  postMessage(message:{type:string}):void {
    if(message.type==='ack'){this.ackPosts++;if(this.throwAck)throw new Error('SYNTHETIC_PRIVATE_ACK_DETAIL');}
    if(message.type==='stop'&&this.throwStop)throw new Error('SYNTHETIC_PRIVATE_STOP_DETAIL');
  }
  async terminate():Promise<number>{this.terminations++;try{return await this.termination();}finally{this.stdout.end();this.stderr.end();}}
}
async function connected() {
  const worker=new SyntheticWorker();let callbacks=0,lost=0;
  const stream=new DingTalkStream(()=>worker as unknown as StreamWorker);
  const ready=stream.connect({clientId:'synthetic',clientSecret:'synthetic'},async()=>{callbacks++;},()=>{lost++;});
  worker.emit('message',{type:'ready'});await ready;
  return {worker,stream,callbacks:()=>callbacks,lost:()=>lost};
}
test('worker startup failures return only a safe authentication error',async()=>{
  const stream=new DingTalkStream(()=>{throw new Error('SYNTHETIC_PRIVATE_STARTUP_DETAIL');});
  await assert.rejects(stream.connect({clientId:'synthetic',clientSecret:'synthetic'},async()=>{},()=>{}),{message:'auth_required'});
});
test('Stream shutdown always terminates its worker, shares one completion and blocks callbacks after a failed stop message',async()=>{
  const f=await connected();let release!:()=>void;
  f.worker.termination=()=>new Promise(resolve=>{release=()=>resolve(0);});f.worker.throwStop=true;
  const closing=f.stream.close();void closing.catch(()=>{});
  try {
    assert.equal(f.stream.close(),closing);assert.equal(f.worker.terminations,1);
    f.worker.emit('message',{type:'callback',transportMessageId:'synthetic',data:'synthetic'});
    assert.equal(f.callbacks(),0);assert.equal(f.lost(),0);
  }finally{release?.();await closing;}
});
test('failed worker termination rejects pending ACKs with safe errors and leaves no callback listener',async()=>{
  const f=await connected();f.worker.termination=async()=>{throw new Error('SYNTHETIC_PRIVATE_TERMINATION_DETAIL');};
  const ack=f.stream.ack('synthetic-transport');
  const checked=assert.rejects(ack,{message:'state_unknown'});
  await assert.rejects(f.stream.close(),{message:'state_unknown'});await checked;
  assert.equal(f.worker.listenerCount('message'),0);
});
test('a local ACK posting failure releases the transport identity for a later callback ACK',async()=>{
  const f=await connected();
  try {
    f.worker.throwAck=true;await assert.rejects(f.stream.ack('same-transport'),{message:'state_unknown'});
    f.worker.throwAck=false;const second=f.stream.ack('same-transport');
    f.worker.emit('message',{type:'acked',transportMessageId:'same-transport'});await second;
    assert.equal(f.worker.ackPosts,2);
  }finally{await f.stream.close();}
});
