import test from 'node:test';
import assert from 'node:assert/strict';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';
import type { HarnessPort } from '../../src/adapters/harness/port.js';
import type { AcpConnection,RpcMessage } from '../../src/adapters/workbuddy-experimental/connection.js';
import { formatterFullToolName } from '../../src/adapters/workbuddy-experimental/formatter.js';
import { formatterExperiment,summarizeFormatterObservation,type FormatterObservation } from '../probes/workbuddy-formatter.js';

function fixture():FormatterObservation {
  const events:HarnessEvent[]=[],messages:RpcMessage[]=[];
  const base={schemaVersion:1 as const,sessionRef:'own-session',runRef:'own-run'};
  const push=(eventType:HarnessEvent['eventType'],payload:unknown)=>events.push({...base,eventType,payload,eventKey:`event-${events.length}`} as HarnessEvent);
  for(const [index,kind] of ['progress','progress','final'].entries()) {
    const toolCallId=`tool-${index}`,text=kind==='progress'?'fixture-private-progress':'fixture-private-final',messageId=`formatter:${toolCallId}`;
    messages.push({jsonrpc:'2.0',method:'session/update',params:{sessionId:'own-session',update:{sessionUpdate:'tool_call',toolCallId,
      rawInput:{kind,text},_meta:{'codebuddy.ai/requestId':'own-run','codebuddy.ai/toolName':formatterFullToolName}}}});
    const done:RpcMessage={jsonrpc:'2.0',method:'session/update',params:{sessionId:'own-session',update:{sessionUpdate:'tool_call_update',toolCallId,status:'completed',
      rawOutput:{text:JSON.stringify([{type:'text',text:JSON.stringify({schemaVersion:1,kind,text})}])}}}};
    messages.push(done,done);
    push('message.started',{messageId,kind,userVisible:true,logicalOrder:index});
    push('message.fragment',{messageId,text,fragmentKey:`${messageId}:snapshot`,fragmentIndex:0});
    push('message.completed',{messageId,finalFragmentIndex:0});
  }
  push('run.completed',{completionEvidence:'synthetic-prompt',stopReason:'end_turn'});
  return {sessionRef:'own-session',runRef:'own-run',progressText:'fixture-private-progress',finalText:'fixture-private-final',
    events,messages,rawStopReason:'end_turn',traceComplete:true};
}

test('formatter probe requires original identities, all three snapshots and an independent raw prompt result',()=>{
  const f=fixture(),report=summarizeFormatterObservation(f);
  assert.equal(report['status'],'observed');assert.equal(report['nativeFormatterCalls'],3);
  assert.deepEqual(report['normalizedKinds'],['progress','progress','final']);assert.equal(report['finalBeforeRunEnd'],true);
  assert.equal(JSON.stringify(report).includes('fixture-private'),false);
  assert.equal(JSON.stringify(report).includes('tool-0'),false);
  assert.equal(summarizeFormatterObservation({...f,rawStopReason:'other'})['status'],'unverified');
  assert.equal(summarizeFormatterObservation({...f,traceComplete:false})['status'],'unverified');
});

test('formatter probe cannot borrow another Harness session, Run or member source to certify normalized messages',()=>{
  for(const change of ['session','run','member']) {
    const f=fixture();f.messages=f.messages.map(message=>{
      const params=message.params as Record<string,unknown>,update=params['update'] as Record<string,unknown>;
      return {...message,params:{...params,...(change==='session'?{sessionId:'foreign-session'}:{}),update:{...update,
        _meta:{...(update['_meta'] as Record<string,unknown>),...(change==='run'?{'codebuddy.ai/requestId':'foreign-run'}:{}),
          ...(change==='member'?{'codebuddy.ai/isTeamMember':true}:{})}}}};
    });
    assert.equal(summarizeFormatterObservation(f)['status'],'unverified');
  }
});

test('contradictory request metadata and changed native tool names cannot certify a formatter source',()=>{
  for(const change of ['request','name']) {
    const f=fixture();
    f.messages.push({jsonrpc:'2.0',method:'session/update',params:{sessionId:'own-session',update:{sessionUpdate:'tool_call_update',toolCallId:'tool-2',status:'completed',
      rawOutput:{text:JSON.stringify({schemaVersion:1,kind:'final',text:f.finalText})},_meta:{'codebuddy.ai/conversationRequestId':'own-run',
        'codebuddy.ai/requestId':change==='request'?'foreign-run':'own-run','codebuddy.ai/toolName':change==='name'?'ToolSearch':formatterFullToolName}}}});
    assert.equal(summarizeFormatterObservation(f)['status'],'unverified');
  }
});

test('missing, changed and ambiguous formatter completions or duplicate logical identities remain unverified',()=>{
  for(const change of ['missing','conflicting','duplicate-message','end-before-final']) {
    const f=fixture();
    if(change==='missing')f.messages=f.messages.filter((_message,index)=>index<6);
    if(change==='conflicting')f.messages.push({jsonrpc:'2.0',method:'session/update',params:{sessionId:'own-session',update:{sessionUpdate:'tool_call_update',
      toolCallId:'tool-2',status:'completed',rawOutput:{text:JSON.stringify({schemaVersion:1,kind:'final',text:'changed'})}}}});
    if(change==='duplicate-message')f.events.splice(3,0,f.events[0]!);
    if(change==='end-before-final')f.events.splice(6,0,f.events.pop()!);
    assert.equal(summarizeFormatterObservation(f)['status'],'unverified');
  }
});

test('formatter probe stops at an original permission request and restores transport observers without answering',async()=>{
  let listener:((event:HarnessEvent)=>void)|undefined,starts=0,unsubscribed=false;
  const originalMessage=()=>{},methods:string[]=[];
  const originalCall:AcpConnection['call']=async method=>{methods.push(method);return new Promise(()=>{});};
  const connection={call:originalCall,onMessage:originalMessage};
  const adapter:Pick<HarnessPort,'start'|'subscribe'>={
    subscribe:(_session,consume)=>{listener=consume;return ()=>{unsubscribed=true;};},
    start:input=>{
      starts++;void connection.call('session/prompt',{},input.operationId);
      listener!({schemaVersion:1,eventKey:'permission',sessionRef:'own-session',runRef:'own-run',eventType:'input.requested',payload:{
        vendorRequestId:'own-request',kind:'permission',messageId:'permission-body',adapterMappingRef:'own-mapping'}});
      return {operationId:input.operationId,receipt:Promise.resolve({status:'accepted',sessionRef:'own-session',runRef:'own-run',receiptEvidence:'synthetic'})};
    },
  };
  const report=await formatterExperiment(adapter,connection,'own-session',100);
  assert.equal(report['status'],'unverified');assert.equal(report['humanRequests'],1);assert.equal(starts,1);
  assert.deepEqual(methods,['session/prompt']);assert.equal(report['executionPermissionApprovals'],0);assert.equal(unsubscribed,true);
  assert.equal(connection.call,originalCall);assert.equal(connection.onMessage,originalMessage);
});

test('formatter probe never retries or upgrades an unknown start',async()=>{
  let starts=0;const connection:Pick<AcpConnection,'call'|'onMessage'>={call:async()=>({}),onMessage:()=>{}};
  const adapter:Pick<HarnessPort,'start'|'subscribe'>={subscribe:()=>()=>{},start:input=>{
    starts++;return {operationId:input.operationId,receipt:Promise.resolve({status:'unknown',errorCode:'state_unknown'})};
  }};
  const report=await formatterExperiment(adapter,connection,'own-session',50);
  assert.equal(report['status'],'unverified');assert.deepEqual(report['start'],{status:'unknown',code:'state_unknown'});assert.equal(starts,1);
});

test('formatter recall checks a prior final without repeating it in the new prompt or exposing the observation',async()=>{
  const expected='fixture-private-previous-final',listeners=new Set<(event:HarnessEvent)=>void>();
  let resolvePrompt!:(value:unknown)=>void,observed:FormatterObservation|undefined;
  const connection:Pick<AcpConnection,'call'|'onMessage'>={onMessage:()=>{},call:async()=>new Promise(resolve=>{resolvePrompt=resolve;})};
  const previousCall=connection.call,previousMessage=connection.onMessage;
  const emit=(eventType:HarnessEvent['eventType'],payload:unknown)=>{for(const listener of listeners)listener({schemaVersion:1,eventKey:eventType,
    sessionRef:'own-session',runRef:'new-run',eventType,payload} as HarnessEvent);};
  const adapter:Pick<HarnessPort,'start'|'subscribe'>={subscribe:(_session,listener)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},
    start:input=>{
      assert.equal(input.text.includes(expected),false);
      void connection.call('session/prompt',{},input.operationId);
      const raw=(update:unknown)=>connection.onMessage({jsonrpc:'2.0',method:'session/update',params:{sessionId:'own-session',update}});
      raw({sessionUpdate:'tool_call',toolCallId:'private-new-tool',rawInput:{kind:'final',text:expected},_meta:{'codebuddy.ai/requestId':'new-run','codebuddy.ai/toolName':formatterFullToolName}});
      raw({sessionUpdate:'tool_call_update',toolCallId:'private-new-tool',status:'completed',rawOutput:{text:JSON.stringify({schemaVersion:1,kind:'final',text:expected})}});
      const messageId='formatter:private-new-tool';emit('message.started',{messageId,kind:'final',userVisible:true,logicalOrder:0});
      emit('message.fragment',{messageId,fragmentKey:`${messageId}:snapshot`,fragmentIndex:0,text:expected});emit('message.completed',{messageId,finalFragmentIndex:0});
      emit('run.completed',{completionEvidence:'synthetic',stopReason:'end_turn'});resolvePrompt({stopReason:'end_turn'});
      return {operationId:input.operationId,receipt:Promise.resolve({status:'accepted',sessionRef:'own-session',runRef:'new-run',receiptEvidence:'synthetic'})};
    }};
  const report=await formatterExperiment(adapter,connection,'own-session',100,true,{recallFinalText:expected,observe:value=>{observed=value;}});
  assert.equal(report['status'],'observed');assert.equal(observed?.finalText,expected);assert.equal(observed?.runRef,'new-run');
  assert.equal(JSON.stringify(report).includes('fixture-private'),false);assert.equal(JSON.stringify(report).includes('private-new-tool'),false);
  assert.equal(connection.call,previousCall);assert.equal(connection.onMessage,previousMessage);assert.equal(listeners.size,0);
});
