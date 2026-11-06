import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpConnection,type RpcMessage } from '../../src/adapters/workbuddy-experimental/connection.js';

function transport(reply:(message:RpcMessage)=>unknown) {
  let controller:ReadableStreamDefaultController<Uint8Array>,posts=0,closed=false;
  const request=(async(_url,init)=>{
    if(init?.method==='DELETE')return new Response(null,{status:204});
    if(init?.method==='POST'){posts++;const value=reply(JSON.parse(String(init.body)) as RpcMessage);
      return value===undefined?new Response(null,{status:202}):Response.json(value);}
    return new Response(new ReadableStream<Uint8Array>({start(stream){controller=stream;init?.signal?.addEventListener('abort',()=>{if(!closed){closed=true;stream.close();}},{once:true});},cancel(){closed=true;}}),
      {headers:{'content-type':'text/event-stream','Acp-Connection-Id':'synthetic'}});
  }) as typeof fetch;
  return {connection:new AcpConnection({endpoint:'http://127.0.0.1:1/api/v1/acp',request,timeoutMs:50}),
    posts:()=>posts,emit(message:unknown){controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`));}};
}
test('RPC reply without exactly one result or error never confirms a command',async()=>{
  for(const malformed of [false,true]) {
    const f=transport(message=>({jsonrpc:'2.0',id:message.id,...(malformed?{result:{},error:{code:-32000,message:'synthetic'}}:{})}));
    await f.connection.connect();
    try{await assert.rejects(f.connection.call('session/load',{sessionId:'original'},'load'));assert.equal(f.posts(),1);}
    finally{await f.connection.close();}
  }
});
test('numeric response ID cannot confirm a string operation ID',async()=>{
  const f=transport(()=>({jsonrpc:'2.0',id:47,result:{sessionId:'wrong-operation'}}));await f.connection.connect();
  try {await assert.rejects(f.connection.call('session/new',{},'47'),{message:'state_unknown'});assert.equal(f.posts(),1);}
  finally{await f.connection.close();}
});
test('subscriber failure closes the transport with unknown receipts and never leaks a raw close error',async()=>{
  const f=transport(()=>undefined);await f.connection.connect();
  f.connection.onMessage=()=>{throw new Error('synthetic-private-subscriber-detail');};
  f.connection.onLost=()=>{throw new Error('synthetic-private-close-detail');};
  const pending=f.connection.call('session/prompt',{},'prompt');
  f.emit({jsonrpc:'2.0',method:'session/update',params:{sessionId:'synthetic'}});
  await assert.rejects(pending,{message:'state_unknown'});assert.equal(f.connection.connected,false);
  await assert.doesNotReject(f.connection.close());assert.equal(f.posts(),1);
});
