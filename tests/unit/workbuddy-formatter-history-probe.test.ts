import test from 'node:test';
import assert from 'node:assert/strict';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';
import { formatterFullToolName } from '../../src/adapters/workbuddy-experimental/formatter.js';
import type { FormatterObservation } from '../probes/workbuddy-formatter.js';
import { summarizeFormatterReload,formatterHistoryExperiment,type FormatterReloadObservation,type FormatterEndpoint } from '../probes/workbuddy-formatter-history.js';

function observation(name:string,recall?:string):FormatterObservation {
  const input:FormatterObservation={sessionRef:'private-session',runRef:`private-${name}-run`,progressText:'PRIVATE_PROGRESS',finalText:recall??'PRIVATE_FINAL',
    events:[],messages:[],rawStopReason:'end_turn',traceComplete:true};
  const emit=(eventType:HarnessEvent['eventType'],payload:unknown)=>input.events.push({schemaVersion:1,sessionRef:input.sessionRef,runRef:input.runRef,eventKey:`event-${input.events.length}`,eventType,payload} as HarnessEvent);
  for(const [index,kind] of (recall?['final']:['progress','progress','final']).entries()) {
    const id=`private-${name}-tool-${index}`,text=kind==='final'?input.finalText:input.progressText,messageId=`formatter:${id}`;
    input.messages.push({jsonrpc:'2.0',method:'session/update',params:{sessionId:input.sessionRef,update:{sessionUpdate:'tool_call',toolCallId:id,rawInput:{kind,text},
      _meta:{'codebuddy.ai/requestId':input.runRef,'codebuddy.ai/toolName':formatterFullToolName}}}});
    input.messages.push({jsonrpc:'2.0',method:'session/update',params:{sessionId:input.sessionRef,update:{sessionUpdate:'tool_call_update',toolCallId:id,status:'completed',
      rawOutput:{text:JSON.stringify({schemaVersion:1,kind,text})}}}});
    emit('message.started',{messageId,kind,userVisible:true,logicalOrder:index});emit('message.fragment',{messageId,fragmentKey:`${messageId}:snapshot`,fragmentIndex:0,text});emit('message.completed',{messageId,finalFragmentIndex:0});
  }
  emit('run.completed',{completionEvidence:'synthetic',stopReason:'end_turn'});return input;
}
function fixture():FormatterReloadObservation {
  const original=observation('old'),next=observation('new',original.finalText),messages=structuredClone(original.messages);
  for(const [offset,message] of messages.entries())(message.params as Record<string,unknown>)['_meta']={'codebuddy.ai':{mode:'history',offset}};
  return {original,next,messages,events:[],loadBoundary:messages.length,traceComplete:true};
}

test('typed history observation separately proves exact prior native IDs and payloads, replay provenance and fresh context continuation',()=>{
  const result=summarizeFormatterReload(fixture());
  assert.equal(result['status'],'observed');assert.equal(result['matchedHistoryTools'],3);assert.equal(result['matchedHistoryPayloads'],3);
  assert.equal(result['newRunAndToolsDistinct'],true);assert.equal(result['duplicateNormalizedEvents'],0);
  assert.equal(JSON.stringify(result).includes('private-'),false);assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
});

test('late history is measured separately while duplicate outputs or incomplete, foreign, member or conflicting history cannot pass',()=>{
  const late=fixture();late.loadBoundary=1;const diagnostic=summarizeFormatterReload(late);
  assert.equal(diagnostic['status'],'observed');assert.ok(Number(diagnostic['lateHistoryFrames'])>0);
  for(const mode of ['foreign','member','unflagged','conflict','duplicate','same-run','truncated']){
    const f=fixture();
    if(mode==='foreign')for(const message of f.messages)(message.params as Record<string,unknown>)['sessionId']='foreign';
    if(mode==='member')for(const message of f.messages)((message.params as Record<string,unknown>)['_meta'] as Record<string,unknown>)['codebuddy.ai/isTeamMember']=true;
    if(mode==='unflagged')for(const message of f.messages)delete (message.params as Record<string,unknown>)['_meta'];
    if(mode==='conflict')((f.messages[1]!.params as Record<string,unknown>)['update'] as Record<string,unknown>)['rawOutput']={text:JSON.stringify({schemaVersion:1,kind:'progress',text:'changed PRIVATE_BODY'})};
    if(mode==='duplicate')f.events.push({...f.original.events[1]!,runRef:f.next.runRef});
    if(mode==='same-run')f.next.runRef=f.original.runRef;
    if(mode==='truncated')f.traceComplete=false;
    const result=summarizeFormatterReload(f);assert.equal(result['status'],'unverified',mode);
    assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
  }
});

test('history coordination cannot disconnect and restart an unknown baseline or create another target',async()=>{
  let starts=0,factories=0,disconnects=0;const connection:FormatterEndpoint['connection']={call:async()=>({}),onMessage:()=>{}};
  const initial:FormatterEndpoint={connection,adapter:{connect:async()=>{},subscribe:()=>()=>{},disconnect:async()=>{disconnects++;},
    resumeSession:input=>({operationId:input.operationId,receipt:Promise.resolve({status:'unknown',errorCode:'state_unknown'})}),
    start:input=>{starts++;return {operationId:input.operationId,receipt:Promise.resolve({status:'unknown',errorCode:'state_unknown'})};}}};
  const result=await formatterHistoryExperiment(initial,()=>{factories++;throw new Error('unexpected factory');},'private-session',20);
  assert.equal(result['status'],'unverified');assert.equal(starts,1);assert.equal(factories,0);assert.equal(disconnects,0);
});
