import test from 'node:test';
import assert from 'node:assert/strict';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';
import type { RpcMessage } from '../../src/adapters/workbuddy-experimental/connection.js';
import { formatterFullToolName } from '../../src/adapters/workbuddy-experimental/formatter.js';
import { summarizeSteeredFormatterObservation,type SteeredFormatterObservation } from '../probes/workbuddy-formatter-steer.js';
import { formatterSteerExperiment } from '../probes/workbuddy-formatter-steer.js';
import type { AcpConnection } from '../../src/adapters/workbuddy-experimental/connection.js';
import type { HarnessPort } from '../../src/adapters/harness/port.js';

function fixture():SteeredFormatterObservation {
  const events:HarnessEvent[]=[],messages:RpcMessage[]=[];
  const event=(eventType:HarnessEvent['eventType'],payload:unknown)=>events.push({schemaVersion:1,sessionRef:'own-session',runRef:'own-run',
    eventKey:`event-${events.length}`,eventType,payload} as HarnessEvent);
  const message=(index:number,owner:string)=>{
    const kind=index<8?'progress':'final',text=index<8?`progress-${index+1}`:'final private-marker-a private-marker-b',id=`tool-${index}`,messageId=`formatter:${id}`;
    const meta={'codebuddy.ai/requestId':owner,'codebuddy.ai/conversationRequestId':owner,
      'codebuddy.ai/messageRequestId':'own-run','codebuddy.ai/toolName':formatterFullToolName};
    messages.push({jsonrpc:'2.0',method:'session/update',params:{sessionId:'own-session',update:{sessionUpdate:'tool_call',toolCallId:id,
      rawInput:{kind,text},_meta:meta}}});
    messages.push({jsonrpc:'2.0',method:'session/update',params:{sessionId:'own-session',update:{sessionUpdate:'tool_call_update',toolCallId:id,status:'completed',
      rawOutput:{text:JSON.stringify({schemaVersion:1,kind,text})},_meta:meta}}});
    event('message.started',{messageId,kind,userVisible:true,logicalOrder:index});
    event('message.fragment',{messageId,fragmentKey:`${messageId}:snapshot`,fragmentIndex:0,text});
    event('message.completed',{messageId,finalFragmentIndex:0});
  };
  message(0,'own-run');
  const controls=[0,1].map(i=>{
    const eventCursor=events.length,rawCursor=messages.length;
    const operationId=`control-${i}`,inputId=`private-input-${i}`,owner=i===0?'own-run':'native-next-0',next=`native-next-${i}`;
    const text=`Append private-marker-${i===0?'a':'b'}`;
    const meta={'codebuddy.ai':{queueOrigin:'steer'},'agent-courier':{operationId,inputId,runRef:'own-run'}};
    messages.push({jsonrpc:'2.0',method:'session/update',params:{sessionId:'own-session',update:{sessionUpdate:'user_message_chunk',messageId:inputId,content:{type:'text',text},
      _meta:{'codebuddy.ai/requestId':next,'codebuddy.ai/conversationRequestId':owner,'codebuddy.ai/messageRequestId':inputId,
        'codebuddy.ai/messageId':inputId,'codebuddy.ai/steerClientMeta':meta}}}});
    event('input.applied',{inputId,appliedEvidence:'synthetic-applied'});
    return {operationId,inputId,text,pendingAtDispatch:true,eventCursor,rawCursor,
      receipt:{status:'accepted' as const,sessionRef:'own-session',runRef:'own-run',receiptEvidence:'synthetic-receipt'},
      rawParams:{sessionId:'own-session',expectedRequestId:owner,clientUserMessageId:inputId,contentBlocks:[{type:'text',text}],_meta:meta},
      rawResult:{steered:true,ownerRequestId:owner}};
  });
  for(let index=1;index<9;index++)message(index,'native-next-1');
  event('run.completed',{stopReason:'end_turn',completionEvidence:'synthetic-terminal'});
  return {sessionRef:'own-session',runRef:'own-run',progressText:'progress',finalText:'final',markers:['private-marker-a','private-marker-b'],
    controls,events,messages,rawStopReason:'end_turn',traceComplete:true};
}

test('steered formatter probe independently verifies both receipts, applied owner chain and final marker effects',()=>{
  const result=summarizeSteeredFormatterObservation(fixture());
  assert.equal(result['status'],'observed');assert.equal(result['nativeAliasCalls'],8);
  assert.equal(result['controlReceiptsMatched'],true);assert.equal(result['controlsApplied'],2);
  assert.equal(result['finalContainsBoth'],true);assert.equal(result['executionPermissionApprovals'],0);
  assert.deepEqual(result['nativeFinalPartMatches'],[[true,true,true]]);
  assert.equal(JSON.stringify(result).includes('private-'),false);assert.equal(JSON.stringify(result).includes('native-next'),false);
});

test('accepted controls and normalized output alone cannot certify missing, late, foreign or conflicting native injection proof',()=>{
  for(const change of ['missing','late','foreign','marker','secondary','cycle']) {
    const f=fixture();
    if(change==='missing')f.messages.splice(2,2);
    else if(change==='late')f.messages.push(...f.messages.splice(2,2));
    else {
      const params=f.messages[3]!.params as Record<string,unknown>,update=params['update'] as Record<string,unknown>,meta=update['_meta'] as Record<string,unknown>;
      if(change==='foreign')params['sessionId']='foreign';
      if(change==='marker')(meta['codebuddy.ai/steerClientMeta'] as Record<string,unknown>)['agent-courier']={operationId:'foreign'};
      if(change==='secondary')update['requestId']='foreign';
      if(change==='cycle')meta['codebuddy.ai/requestId']='own-run';
    }
    assert.equal(summarizeSteeredFormatterObservation(f)['status'],'unverified',change);
  }
});

test('a matching injection identity cannot certify missing, partial or changed steer text',()=>{
  for(const content of [undefined,{type:'text',text:'Append'}, {type:'text',text:'changed private body'}, {type:'image',text:'Append private-marker-b'}]) {
    const input=fixture(),params=input.messages[3]!.params as Record<string,unknown>,update=params['update'] as Record<string,unknown>;
    update['content']=content;
    const result=summarizeSteeredFormatterObservation(input);
    assert.equal(result['status'],'unverified');
    assert.equal(JSON.stringify(result).includes('private-'),false);
  }
});

test('steered formatter runner stops on a native permission request or unknown start and restores its observers',async()=>{
  for(const mode of ['permission','unknown']) {
    const listeners=new Set<(event:HarnessEvent)=>void>();let starts=0,steers=0;
    const connection:Pick<AcpConnection,'call'|'onMessage'>={call:async()=>{throw new Error('unexpected command');},onMessage:()=>{}};
    const previousCall=connection.call,previousMessage=connection.onMessage;
    const adapter:Pick<HarnessPort,'start'|'steer'|'subscribe'>={
      subscribe:(_session,listener)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},
      start:input=>{starts++;
        if(mode==='permission')for(const listener of listeners)listener({schemaVersion:1,eventKey:'permission',sessionRef:input.sessionRef,runRef:'own-run',
          eventType:'input.requested',payload:{vendorRequestId:'native-permission',kind:'permission',messageId:'permission-message',adapterMappingRef:'private-mapping'}});
        return {operationId:input.operationId,receipt:Promise.resolve(mode==='unknown'?{status:'unknown',errorCode:'state_unknown'}:
          {status:'accepted',sessionRef:input.sessionRef,runRef:'own-run',receiptEvidence:'synthetic-start'})};},
      steer:input=>{steers++;return {operationId:input.operationId,receipt:Promise.resolve({status:'unknown',errorCode:'state_unknown'})};},
    };
    const result=await formatterSteerExperiment(adapter,connection,'own-session',100);
    assert.equal(result['status'],'unverified');assert.equal(starts,1);assert.equal(steers,0);
    assert.equal(result['promptPendingAtBothDispatches']??false,false);
    assert.equal(result['executionPermissionApprovals'],0);assert.equal(listeners.size,0);
    assert.equal(connection.call,previousCall);assert.equal(connection.onMessage,previousMessage);
  }
});

test('steered formatter runner never dispatches a second control after the first control is unknown',async()=>{
  const listeners=new Set<(event:HarnessEvent)=>void>();let steers=0,finish!:(value:unknown)=>void;
  const connection:Pick<AcpConnection,'call'|'onMessage'>={onMessage:()=>{},call:async method=>{
    if(method==='session/prompt')return new Promise(resolve=>{finish=resolve;});
    return {steered:false};
  }};
  const previousCall=connection.call,previousMessage=connection.onMessage;
  const emit=(eventType:HarnessEvent['eventType'],payload:unknown)=>{
    for(const listener of listeners)listener({schemaVersion:1,eventKey:eventType,sessionRef:'own-session',runRef:'own-run',eventType,payload} as HarnessEvent);
  };
  const adapter:Pick<HarnessPort,'start'|'steer'|'subscribe'>={
    subscribe:(_session,listener)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},
    start:input=>{
      void connection.call('session/prompt',{},input.operationId);
      const text=/CourierFormatterProgress-[a-f0-9-]{36}/.exec(input.text)![0]+'-1';
      emit('message.started',{messageId:'first',kind:'progress',userVisible:true,logicalOrder:0});
      emit('message.fragment',{messageId:'first',fragmentKey:'first:snapshot',fragmentIndex:0,text});
      emit('message.completed',{messageId:'first',finalFragmentIndex:0});
      return {operationId:input.operationId,receipt:Promise.resolve({status:'accepted',sessionRef:input.sessionRef,runRef:'own-run',receiptEvidence:'synthetic'})};
    },
    steer:input=>{
      steers++;void connection.call('session/steer',{},input.operationId);
      queueMicrotask(()=>{emit('run.completed',{stopReason:'end_turn',completionEvidence:'synthetic'});finish({stopReason:'end_turn'});});
      return {operationId:input.operationId,receipt:Promise.resolve({status:'unknown',errorCode:'state_unknown'})};
    },
  };
  const result=await formatterSteerExperiment(adapter,connection,'own-session',100);
  assert.equal(result['status'],'unverified');assert.equal(steers,1);assert.equal(result['controlCalls'],1);
  assert.equal(result['executionPermissionApprovals'],0);assert.equal(listeners.size,0);
  assert.equal(connection.call,previousCall);assert.equal(connection.onMessage,previousMessage);
});

test('wrong receipt scope, unknown control, dispatch after terminal, incomplete trace or missing final effects remain unverified',()=>{
  for(const change of ['receipt','raw','unknown','pending','cursor','trace','effect','control-text','human','duplicate','origin']) {
    const f=fixture();
    if(change==='receipt')f.controls[0]!.receipt={status:'accepted',sessionRef:'foreign',runRef:f.runRef,receiptEvidence:'synthetic'};
    if(change==='raw')f.controls[0]!.rawResult={steered:true,ownerRequestId:'foreign'};
    if(change==='unknown')f.controls[0]!.receipt={status:'unknown',errorCode:'state_unknown'};
    if(change==='pending')f.controls[0]!.pendingAtDispatch=false;
    if(change==='cursor')f.controls[0]!.eventCursor=0;
    if(change==='trace')f.traceComplete=false;
    if(change==='effect')f.markers[1]='absent-effect';
    if(change==='control-text'){
      f.controls[0]!.text='unrelated text';
      (f.controls[0]!.rawParams as Record<string,unknown>)['contentBlocks']=[{type:'text',text:'unrelated text'}];
    }
    if(change==='human')f.events.push({...f.events[0]!,eventType:'input.requested',payload:{kind:'permission'}} as HarnessEvent);
    if(change==='duplicate')f.controls[1]=f.controls[0]!;
    if(change==='origin')for(const m of f.messages.slice(4)){
      const u=(m.params as Record<string,unknown>)['update'] as Record<string,unknown>;(u['_meta'] as Record<string,unknown>)['codebuddy.ai/messageRequestId']='foreign';
    }
    assert.equal(summarizeSteeredFormatterObservation(f)['status'],'unverified',change);
  }
});

test('an additional native final cannot turn the nine-message experiment into a pass',()=>{
  const f=fixture(),extra=structuredClone(f.messages.slice(-2));
  for(const m of extra)((m.params as Record<string,unknown>)['update'] as Record<string,unknown>)['toolCallId']='extra-final';
  f.messages.push(...extra);
  const end=f.events.pop()!,copies=structuredClone(f.events.slice(-3));
  for(const event of copies){
    const payload=event.payload as unknown as Record<string,unknown>;payload['messageId']='formatter:extra-final';
    if(event.eventType==='message.started')payload['logicalOrder']=9;
    if(event.eventType==='message.fragment')payload['fragmentKey']='formatter:extra-final:snapshot';
    event.eventKey+=':extra';
  }
  f.events.push(...copies,end);
  const result=summarizeSteeredFormatterObservation(f);
  assert.equal(result['status'],'unverified');assert.equal(result['nativeFormatterCalls'],10);
  assert.deepEqual(result['nativeFinalPartMatches'],[[true,true,true],[true,true,true]]);
});

test('steer diagnostics localize contradictory tool metadata without exposing source identities or private fields',()=>{
  const f=fixture();
  f.messages.push({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.sessionRef,update:{sessionUpdate:'tool_call_update',
    toolCallId:'private-search-id',status:'completed',_meta:{'codebuddy.ai/conversationRequestId':f.runRef,
      'codebuddy.ai/requestId':'private-other-owner','codebuddy.ai/toolName':'ToolSearch','private-extra':'private-data'}}}});
  const result=summarizeSteeredFormatterObservation(f),details=result['requestMetadataConflicts'] as Record<string,unknown>[];
  assert.equal(result['status'],'unverified');assert.equal(details.length,1);
  assert.equal(details[0]!['tool'],'tool_search');assert.equal(details[0]!['bound'],false);
  assert.equal(details[0]!['conversationMatches'],true);assert.equal(details[0]!['metadataRequestMatches'],false);
  assert.equal(details[0]!['metadataRequestKnownOwner'],false);
  assert.equal(JSON.stringify(result).includes('private-'),false);
});

test('request metadata diagnostics keep a bounded sample and report omitted details explicitly',()=>{
  const f=fixture();
  for(let i=0;i<40;i++)f.messages.push({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.sessionRef,update:{sessionUpdate:'tool_call_update',
    toolCallId:`private-search-${i}`,_meta:{'codebuddy.ai/conversationRequestId':'native-next-1','codebuddy.ai/requestId':`private-foreign-${i}`,
      'codebuddy.ai/messageRequestId':f.runRef,'codebuddy.ai/toolName':'ToolSearch'}}}});
  const result=summarizeSteeredFormatterObservation(f),details=result['requestMetadataConflicts'] as Record<string,unknown>[];
  assert.equal(result['status'],'unverified');assert.equal(details.length,32);
  assert.equal(result['requestMetadataConflictCount'],40);assert.equal(result['requestMetadataConflictDetailsComplete'],false);
  assert.equal(result['diagnosticComplete'],false);assert.ok(details.every(row=>row['metadataRequestKnownOwner']===false));
  assert.equal(JSON.stringify(result).includes('private-'),false);
});

test('mixed native request fields require already-proven owners and the original input identity',()=>{
  const f=fixture();
  for(const m of f.messages.slice(4)){
    const u=(m.params as Record<string,unknown>)['update'] as Record<string,unknown>,meta=u['_meta'] as Record<string,unknown>;
    meta['codebuddy.ai/conversationRequestId']=f.runRef;
  }
  assert.equal(summarizeSteeredFormatterObservation(f)['status'],'observed');
  const missing=structuredClone(f);missing.messages.push(...missing.messages.splice(2,2));
  assert.equal(summarizeSteeredFormatterObservation(missing)['status'],'unverified');
  const wrong=structuredClone(f),u=(wrong.messages[4]!.params as Record<string,unknown>)['update'] as Record<string,unknown>;
  (u['_meta'] as Record<string,unknown>)['codebuddy.ai/requestId']='private-unknown-owner';
  assert.equal(summarizeSteeredFormatterObservation(wrong)['status'],'unverified');
});

test('ordinary visible markers and observable native final timing are diagnostics and never certify a missing typed effect',()=>{
  const f=fixture();
  for(const message of f.messages) {
    const update=(message.params as Record<string,unknown>)['update'] as Record<string,unknown>;
    if(update['toolCallId']!=='tool-8')continue;
    if(update['rawInput'])update['rawInput']={kind:'final',text:f.finalText};
    if(update['rawOutput'])update['rawOutput']={text:JSON.stringify({schemaVersion:1,kind:'final',text:f.finalText})};
  }
  for(const event of f.events)if(event.eventType==='message.fragment'&&event.payload.messageId==='formatter:tool-8')event.payload.text=f.finalText;
  const chunk=(sessionId:string,kind:string,text:string,meta:Record<string,unknown>={})=>({jsonrpc:'2.0' as const,method:'session/update',params:{sessionId,update:{sessionUpdate:kind,
    content:{type:'text',text},_meta:{'codebuddy.ai/requestId':'native-next-1','codebuddy.ai/conversationRequestId':'native-next-1',
      'codebuddy.ai/messageRequestId':f.runRef,'codebuddy.ai/messageId':'private-visible-id',...meta}}}});
  f.messages.push(chunk(f.sessionRef,'agent_message_chunk','final private-mar'),chunk(f.sessionRef,'agent_message_chunk','ker-a private-marker-b private-extra'));
  f.messages.push(chunk('foreign','agent_message_chunk','private-body'),chunk(f.sessionRef,'agent_thought_chunk','private-reasoning'),
    chunk(f.sessionRef,'agent_message_chunk','private-history',{'codebuddy.ai/historyReplay':true}));
  const result=summarizeSteeredFormatterObservation(f);
  assert.equal(result['status'],'unverified');assert.equal(result['finalContainsBoth'],false);
  assert.deepEqual(result['ordinaryVisiblePartMatches'],[[true,true,true]]);
  const timings=result['nativeFinalTiming'] as Record<string,unknown>[];
  assert.equal(timings.length,1);assert.deepEqual(timings[0]!['beforeDispatch'],[false,false]);
  assert.deepEqual(timings[0]!['beforeInjection'],[false,false]);
  assert.equal(JSON.stringify(result).includes('private-'),false);
});
