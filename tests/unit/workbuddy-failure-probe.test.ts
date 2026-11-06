import test from 'node:test';
import assert from 'node:assert/strict';
import { failureControlReady,disconnectingSteerRequest } from '../probes/workbuddy-failures.js';
import { CourierError } from '../../src/domain/errors.js';

test('failure controls require the live original Run and refuse terminal, foreign, human-input or tool states',()=>{
  const event={sessionId:'own',update:{sessionUpdate:'agent_thought_chunk',_meta:{'codebuddy.ai/requestId':'original-run'}}};
  const state={sessionId:'own',isProcessing:true,returned:false,failed:false,pendingQuestions:0,pendingPermissions:0,terminalObserved:false,events:[event]};
  assert.equal(failureControlReady(state,'own','original-run'),true);
  for(const change of [{sessionId:'foreign'},{isProcessing:false},{returned:true},{failed:true},{pendingQuestions:1},{pendingPermissions:1},
    {terminalObserved:true},{events:[]},{events:[{...event,update:{...event.update,sessionUpdate:'user_message_chunk'}}]},
    {events:[event,{sessionId:'own',update:{sessionUpdate:'tool_call'}}]}])
    assert.equal(failureControlReady({...state,...change},'own','original-run'),false);
  assert.equal(failureControlReady(state,'own','another-run'),false);
  assert.equal(failureControlReady({...state,events:[{...event,sessionId:'foreign'}]},'own','original-run'),false);
});

test('the transport fault starts one matching real-request delegate before disconnect and blocks any repeated fault POST',async()=>{
  const actions:string[]=[];let posts=0;
  const request=disconnectingSteerRequest((async(_url,init)=>{
    const body=JSON.parse(String(init?.body??'{}')) as {id?:string};actions.push(`request:${body.id??'stream'}`);return new Response(null,{status:202});
  }) as typeof fetch,'fault-operation',()=>{actions.push('disconnect');},()=>{posts++;});
  const init=(id:string,method='session/steer')=>({method:'POST',body:JSON.stringify({jsonrpc:'2.0',id,method,params:{}})});
  await request('http://127.0.0.1:1',init('initialize','initialize'));
  await request('http://127.0.0.1:1',init('stale-operation'));
  await request('http://127.0.0.1:1',init('fault-operation'));
  assert.deepEqual(actions,['request:initialize','request:stale-operation','request:fault-operation','disconnect']);
  assert.equal(posts,2);
  await assert.rejects(request('http://127.0.0.1:1',init('fault-operation')),error=>error instanceof CourierError&&error.code==='state_unknown');
  assert.equal(actions.length,4);assert.equal(posts,2);
  await request('http://127.0.0.1:1',{method:'DELETE'});
  assert.equal(actions.at(-1),'request:stream');assert.equal(actions.filter(action=>action==='disconnect').length,1);
});
