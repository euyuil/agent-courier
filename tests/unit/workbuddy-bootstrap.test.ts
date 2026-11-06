import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { desktopBootstrapReady,createDesktopBootstrap,desktopRuntimeRegistryDirectory } from '../../src/adapters/workbuddy-experimental/authentication.js';
import type { BootstrapRunProvenance } from '../../src/adapters/workbuddy-experimental/bootstrap-provenance.js';

function fixture(change:Record<string,unknown>={},authenticated=true,provenance?:BootstrapRunProvenance[]) {
  const calls:string[]=[];
  const snapshot={sessionId:'own-bootstrap',cwd:'synthetic-workspace',isProcessing:false,eventHistory:[],pendingPermissions:[],pendingQuestions:[],pendingElicitations:[],...change};
  class Socket {
    onopen:(()=>void)|undefined;onerror:(()=>void)|undefined;onclose:(()=>void)|undefined;onmessage:((event:{data:string})=>void)|undefined;
    constructor(){queueMicrotask(()=>this.onopen?.());}
    send(value:string){const message=JSON.parse(value) as {id:number;params:{expression:string}};
      void Promise.resolve(runInNewContext(message.params.expression,{__wbInvoke:async(channel:string,_event:unknown,id?:string)=>{
        calls.push(channel);if(channel==='auth:getAccount')return authenticated?{uid:'private-account'}:null;
        assert.equal(channel,'session:get');assert.equal(id,'own-bootstrap');return snapshot;
      }})).then(value=>this.onmessage?.({data:JSON.stringify({id:message.id,result:{result:{value}}})}));
    }
    close(){}
  }
  const request=(async()=>Response.json([{type:'page',webSocketDebuggerUrl:'ws://127.0.0.1:1/devtools/page/synthetic'}])) as typeof fetch;
  return {calls,check:()=>desktopBootstrapReady('http://127.0.0.1:1','synthetic-workspace','own-bootstrap',request,Socket as unknown as typeof WebSocket,provenance)};
}
test('normal desktop verification admits only an authenticated idle bootstrap with no user history or pending input',async()=>{
  const f=fixture();assert.equal(await f.check(),true);assert.deepEqual(f.calls,['auth:getAccount','session:get']);
  for(const change of [{isProcessing:true},{cwd:'foreign'},{sessionId:'foreign'},{pendingQuestions:[{}]},{pendingPermissions:[{}]},
    {pendingElicitations:[{}]},{pendingPermissions:undefined},{eventHistory:undefined},{eventHistory:[{update:{sessionUpdate:'user_message_chunk'}}]},
    {eventHistory:[{update:{sessionUpdate:'agent_message_chunk'}}]},{eventHistory:[{update:{sessionUpdate:'tool_call'}}]}])assert.equal(await fixture(change).check(),false);
  assert.equal(await fixture({},false).check(),false);
});
test('mirrored Courier history requires one persisted Run proof and cannot admit foreign references or unbound tool results',async()=>{
  const proof=[{runRef:'own-run',owners:['own-run','proven-next'],inputs:['own-input']}];
  const update=(sessionUpdate:string,extra:Record<string,unknown>={})=>({update:{sessionUpdate,...extra}});
  const tracking={'codebuddy.ai/conversationRequestId':'own-run','codebuddy.ai/requestId':'proven-next','codebuddy.ai/messageRequestId':'own-input'};
  const own=update('agent_message_chunk',{_meta:tracking});
  assert.equal(await fixture({eventHistory:[own]}).check(),false);
  assert.equal(await fixture({eventHistory:[own]},true,proof).check(),true);
  for(const field of Object.keys(tracking))assert.equal(await fixture({eventHistory:[update('agent_message_chunk',{_meta:{...tracking,[field]:'foreign'}})]},true,proof).check(),false);
  const tool=update('tool_call',{toolCallId:'own-tool',_meta:tracking}),done=update('tool_call_update',{toolCallId:'own-tool'});
  assert.equal(await fixture({eventHistory:[tool,done]},true,proof).check(),true);
  assert.equal(await fixture({eventHistory:[done]},true,proof).check(),false);
  assert.equal(await fixture({eventHistory:[tool,update('tool_call_update',{toolCallId:'foreign-tool'})]},true,proof).check(),false);
});
test('normal host creation distinguishes pre-dispatch authentication failure from uncertain native creation without exposing account data',async()=>{
  for(const mode of ['normal','normal-default','ignored-default','logged-out','throw','missing-id','wrong-cwd']) {
    let creations=0;const cwd='synthetic "quoted" workspace';
    class Socket {
      onopen:(()=>void)|undefined;onerror:(()=>void)|undefined;onclose:(()=>void)|undefined;onmessage:((event:{data:string})=>void)|undefined;
      constructor(){queueMicrotask(()=>this.onopen?.());}
      send(value:string){const message=JSON.parse(value) as {id:number;params:{expression:string}};
        void Promise.resolve(runInNewContext(message.params.expression,{__wbInvoke:async(channel:string,_event:unknown,input:{cwd:string;permissionMode?:string})=>{
          if(channel==='auth:getAccount')return mode==='logged-out'?null:{uid:'private-account'};
          assert.equal(channel,'session:create');assert.equal(input.cwd,cwd);creations++;
          assert.equal(input.permissionMode,mode.endsWith('default')?'default':undefined);
          if(mode==='throw')throw new Error('private-native-error');
          return {sessionId:mode==='missing-id'?undefined:'new-host',cwd:mode==='wrong-cwd'?'foreign':cwd,
            ...(mode.endsWith('default')?{config:{permissionMode:mode==='normal-default'?'default':'bypassPermissions'}}:{})};
        }})).then(value=>this.onmessage?.({data:JSON.stringify({id:message.id,result:{result:{value}}})}));
      }
      close(){}
    }
    const request=(async()=>Response.json([{type:'page',webSocketDebuggerUrl:'ws://127.0.0.1:1/devtools/page/synthetic'}])) as typeof fetch;
    const result=await createDesktopBootstrap('http://127.0.0.1:1',cwd,request,Socket as unknown as typeof WebSocket,mode.endsWith('default')?'default':undefined);
    assert.equal(result.status,mode.startsWith('normal')?'created':mode==='logged-out'?'not_created':'unknown');
    assert.equal(creations,mode==='logged-out'?0:1);assert.doesNotMatch(JSON.stringify(result),/private-account|private-native-error|quoted/);
  }
});
test('runtime metadata uses only the authenticated normal directory API and rejects relative paths or logged-out access',async()=>{
  for(const mode of ['normal','relative','logged-out']){
    const calls:string[]=[];
    class Socket {
      onopen:(()=>void)|undefined;onerror:(()=>void)|undefined;onclose:(()=>void)|undefined;onmessage:((event:{data:string})=>void)|undefined;
      constructor(){queueMicrotask(()=>this.onopen?.());}
      send(value:string){const message=JSON.parse(value) as {id:number;params:{expression:string}};
        void Promise.resolve(runInNewContext(message.params.expression,{__wbInvoke:async(channel:string)=>{
          calls.push(channel);if(channel==='auth:getAccount')return mode==='logged-out'?null:{uid:'private-account',secret:'never-return'};
          assert.equal(channel,'app:getConfigDir');return mode==='relative'?'relative':'/synthetic/config';
        }})).then(value=>this.onmessage?.({data:JSON.stringify({id:message.id,result:{result:{value}}})}));
      }
      close(){}
    }
    const request=(async()=>Response.json([{type:'page',webSocketDebuggerUrl:'ws://127.0.0.1:1/devtools/page/synthetic'}])) as typeof fetch;
    const result=await desktopRuntimeRegistryDirectory('http://127.0.0.1:1',request,Socket as unknown as typeof WebSocket);
    assert.equal(result,mode==='normal'?'/synthetic/config/sessions':undefined);
    assert.deepEqual(calls,mode==='logged-out'?['auth:getAccount']:['auth:getAccount','app:getConfigDir']);
  }
});
