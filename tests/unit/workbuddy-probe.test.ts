import test from 'node:test';
import assert from 'node:assert/strict';
import { Diagnostic } from '../probes/workbuddy-capabilities.js';

class Socket {
  onopen:(()=>void)|undefined;onerror:(()=>void)|undefined;onmessage:((event:{data:string})=>void)|undefined;
  constructor(){queueMicrotask(()=>this.onopen?.());}
  send(data:string){const message=JSON.parse(data) as {id:number;method:string};assert.equal(message.method,'Runtime.evaluate');
    queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({id:message.id,result:{result:{value:true}}})}));}
  close(){}
}
test('desktop probe waits for renderer discovery without retrying any Harness command',async()=>{
  let calls=0;
  const diagnostic=new Diagnostic({request:(async(_url,init)=>{
    assert.equal(init?.method,undefined);calls++;
    return Response.json(calls<3?[]:[{type:'page',webSocketDebuggerUrl:'ws://127.0.0.1:1/devtools/page/synthetic'}]);
  }) as typeof fetch,socket:Socket as unknown as typeof WebSocket,retryDelayMs:0});
  try {await diagnostic.connect('ws://127.0.0.1:1/devtools/browser/synthetic');assert.equal(calls,3);
    assert.equal(await diagnostic.evaluate('true'),true);
  }finally{diagnostic.close();}
});
test('desktop probe refuses discovery and debugger redirects outside its configured loopback target',async()=>{
  const foreign=new Diagnostic({request:(async()=>{assert.fail('network prohibited');}) as typeof fetch});
  await assert.rejects(foreign.connect('ws://example.invalid/devtools/browser/synthetic'),{message:'diagnostic_unavailable'});
  const redirected=new Diagnostic({request:(async()=>Response.json([{type:'page',webSocketDebuggerUrl:'ws://example.invalid/devtools/page/synthetic'}])) as typeof fetch,
    socket:class {constructor(){assert.fail('socket prohibited');}} as unknown as typeof WebSocket});
  await assert.rejects(redirected.connect('ws://127.0.0.1:1/devtools/browser/synthetic'),{message:'diagnostic_unavailable'});
});
