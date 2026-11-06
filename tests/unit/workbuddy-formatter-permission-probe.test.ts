import test from 'node:test';
import assert from 'node:assert/strict';
import type { HarnessPort } from '../../src/adapters/harness/port.js';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';
import type { AcpConnection,RpcMessage } from '../../src/adapters/workbuddy-experimental/connection.js';
import { formatterFullToolName } from '../../src/adapters/workbuddy-experimental/formatter.js';
import { exactFormatterPermission,formatterPermissionExperiment,formatterPermissionDecision } from '../probes/workbuddy-formatter-permission.js';
import { managedOutputExperiment } from '../probes/workbuddy-managed-output.js';

type Request=Extract<HarnessEvent,{eventType:'input.requested'}>;
function permission(text='private-synthetic-text'){
  const session='private-session',run='private-run',tool='private-tool',id=JSON.stringify([session,run,'permission',tool]);
  const meta={'codebuddy.ai/requestId':run,'codebuddy.ai/messageRequestId':run,'codebuddy.ai/toolName':formatterFullToolName,'codebuddy.ai/toolArgumentsComplete':true};
  const messages:RpcMessage[]=[
    {jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:{sessionUpdate:'tool_call',toolCallId:tool,rawInput:{kind:'final',text},_meta:meta}}},
    {jsonrpc:'2.0',id:'private-rpc',method:'session/request_permission',params:{sessionId:session,
      toolCall:{toolCallId:tool,rawInput:{kind:'final',text},_meta:meta},options:[{optionId:'once',kind:'allow_once',name:'Allow once'},{optionId:'always',kind:'allow_always',name:'Always'},{optionId:'deny',kind:'reject_once',name:'Deny'}]}},
    {jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:{sessionUpdate:'session_info_update',_meta:{...meta,
      'codebuddy.ai/interruptionRequest':{interruptionId:'private-interruption',toolCallId:tool,toolName:formatterFullToolName,toolInput:{kind:'final',text},options:['allow','allowAll','deny']}}}}},
  ];
  const request:Request={schemaVersion:1,eventKey:'private-request-event',sessionRef:session,runRef:run,eventType:'input.requested',payload:{vendorRequestId:id,
    kind:'permission',messageId:'private-permission-body',adapterMappingRef:'private-mapping',options:[{code:'once',label:'Allow once',decision:'approve'},{code:'always',label:'Always',decision:'approve'},{code:'deny',label:'Deny',decision:'deny'}]}};
  return {session,run,tool,id,messages,request};
}

test('the permission experiment requires an explicit operator decision before any task, subscription or backend activation',async()=>{
  let calls=0;
  const adapter:Pick<HarnessPort,'start'|'answer'|'subscribe'>={start:()=>{calls++;throw new Error('unexpected');},answer:()=>{calls++;throw new Error('unexpected');},subscribe:()=>{calls++;throw new Error('unexpected');}};
  const connection:Pick<AcpConnection,'call'|'onMessage'>={call:async()=>{calls++;},onMessage:()=>{calls++;}};
  assert.equal((await formatterPermissionExperiment(adapter,connection,'private-session'))['authorizationRequired'],true);
  assert.equal((await managedOutputExperiment('invalid','invalid','approved-formatter'))['authorizationRequired'],true);assert.equal(calls,0);
});
test('one formatter approval is bound to the exact original tool, synthetic input and allow-once option across both native request channels',()=>{
  const f=permission(),mapping=exactFormatterPermission(f.request,f.messages,'private-synthetic-text');
  assert.equal(mapping?.wireMethod,'interruption');assert.equal(mapping?.wireOptions['once'],'allow');assert.equal(mapping?.wireOptions['always'],'allowAll');
  assert.equal(mapping?.toolCallId,f.tool);
  for(const change of ['tool','body','foreign','closed','unmapped','once','channel-conflict','updated-input']){
    const f=permission();
    if(change==='tool')((f.messages[1]!.params as any).toolCall._meta)['codebuddy.ai/toolName']='Bash';
    if(change==='body')(f.messages[1]!.params as any).toolCall.rawInput.text='changed';
    if(change==='foreign')(f.messages[2]!.params as any).update._meta['codebuddy.ai/messageRequestId']='foreign-run';
    if(change==='closed')f.messages.push({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update:{sessionUpdate:'tool_call_update',toolCallId:f.tool,status:'cancelled'}}});
    if(change==='unmapped')(f.messages[1]!.params as any).options=[];
    if(change==='once')(f.messages[1]!.params as any).options=[{optionId:'always',kind:'allow_always',name:'Always'}];
    if(change==='channel-conflict')(f.messages[2]!.params as any).update._meta['codebuddy.ai/interruptionRequest'].toolInput.text='changed';
    if(change==='updated-input')f.messages.push({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update:{sessionUpdate:'tool_call_update',toolCallId:f.tool,rawInput:{kind:'final',text:'changed'}}}});
    assert.equal(exactFormatterPermission(f.request,f.messages,'private-synthetic-text'),undefined,change);
  }
});

test('an interruption without Run metadata requires its exact tool and input to be bound by the original native tool call',()=>{
  const f=permission(),params=f.messages[2]!.params as any;
  params.update._meta={'codebuddy.ai/interruptionRequest':params.update._meta['codebuddy.ai/interruptionRequest']};
  assert.equal(exactFormatterPermission(f.request,f.messages,'private-synthetic-text')?.wireMethod,'interruption');
  const withoutSource=f.messages.slice(1);assert.equal(exactFormatterPermission(f.request,withoutSource,'private-synthetic-text'),undefined);
  params.update._meta['codebuddy.ai/interruptionRequest'].toolCallId='foreign-tool';
  assert.equal(exactFormatterPermission(f.request,f.messages,'private-synthetic-text'),undefined);
});
test('the native permission RPC correlation is distinct from Run identity while explicit original-Run fields must still agree',()=>{
  const f=permission(),params=f.messages[1]!.params as any;params._meta={'codebuddy.ai/requestId':'private-permission-correlation'};
  assert.equal(exactFormatterPermission(f.request,f.messages,'private-synthetic-text')?.wireMethod,'interruption');
  params._meta['codebuddy.ai/conversationRequestId']='foreign-run';assert.equal(exactFormatterPermission(f.request,f.messages,'private-synthetic-text'),undefined);
  delete params._meta['codebuddy.ai/conversationRequestId'];params._meta['codebuddy.ai/requestId']={untrusted:'private-value'};
  assert.equal(exactFormatterPermission(f.request,f.messages,'private-synthetic-text'),undefined);
});
test('initial empty or growing formatter parameters require a later exact original source and cannot overwrite a complete source',()=>{
  for(const rawInput of [{},{kind:'f'},{kind:'fina'},{kind:'final'},{kind:'final',text:'private-synthetic'}]){
    const f=permission(),first=structuredClone(f.messages[0]!);(first.params as any).update.rawInput=rawInput;
    delete (first.params as any).update._meta['codebuddy.ai/toolArgumentsComplete'];f.messages.unshift(first);
    assert.equal(exactFormatterPermission(f.request,f.messages,'private-synthetic-text')?.wireMethod,'interruption');
    assert.equal(exactFormatterPermission(f.request,[first,...f.messages.slice(2)],'private-synthetic-text'),undefined);
  }
  for(const rawInput of [{kind:'progress'},{kind:'final',text:'wrong-prefix'},{unknown:'private-value'}]){
    const f=permission(),first=structuredClone(f.messages[0]!);(first.params as any).update.rawInput=rawInput;f.messages.unshift(first);
    assert.equal(exactFormatterPermission(f.request,f.messages,'private-synthetic-text'),undefined);
  }
  const f=permission(),downgrade=structuredClone(f.messages[0]!);(downgrade.params as any).update.rawInput={};f.messages.push(downgrade);
  assert.equal(exactFormatterPermission(f.request,f.messages,'private-synthetic-text'),undefined);
});
test('only a native toolArgumentsComplete source can authorize the exact synthetic call',()=>{
  const f=permission();delete (f.messages[0]!.params as any).update._meta['codebuddy.ai/toolArgumentsComplete'];
  assert.equal(exactFormatterPermission(f.request,f.messages,'private-synthetic-text'),undefined);
  (f.messages[0]!.params as any).update._meta['codebuddy.ai/toolArgumentsComplete']=false;
  assert.equal(exactFormatterPermission(f.request,f.messages,'private-synthetic-text'),undefined);
});

function rig(mode='normal'){
  let listener:((event:HarnessEvent)=>void)|undefined,finishPrompt!:(value:unknown)=>void,answerCalls=0,wireDecisions=0,unsubscribed=false;
  let f=permission(),text='';
  const nativeCall:AcpConnection['call']=async(method)=>{
    if(method==='session/prompt')return new Promise(resolve=>{finishPrompt=resolve;});wireDecisions++;return {resolved:true,queued:false};
  };
  const nativeMessage=()=>{};const connection:Pick<AcpConnection,'call'|'onMessage'>={call:nativeCall,onMessage:nativeMessage};
  const emit=(eventType:HarnessEvent['eventType'],payload:unknown)=>listener!({schemaVersion:1,eventKey:`private-${eventType}`,sessionRef:f.session,runRef:f.run,eventType,payload} as HarnessEvent);
  const raw=(message:RpcMessage)=>connection.onMessage(message);
  const adapter:Pick<HarnessPort,'start'|'answer'|'subscribe'>={
    subscribe:(_session,consume)=>{listener=consume;return ()=>{unsubscribed=true;};},
    start:input=>{
      text=input.text.match(/CourierFormatterPermission-[\w-]+/)![0];f=permission(text);
      void connection.call('session/prompt',{},input.operationId);
      if(mode==='native-metadata'){
        for(const rawInput of [{},{kind:'f'},{kind:'final',text:'CourierFormatter'}]){
          const partial=structuredClone(f.messages[0]!);(partial.params as any).update.rawInput=rawInput;
          delete (partial.params as any).update._meta['codebuddy.ai/toolArgumentsComplete'];raw(partial);
        }
        (f.messages[1]!.params as any)._meta={'codebuddy.ai/requestId':'private-permission-correlation'};
        (f.messages[1]!.params as any).toolCall._meta={'codebuddy.ai/toolName':formatterFullToolName};
        const update=(f.messages[2]!.params as any).update;update._meta={'codebuddy.ai/interruptionRequest':update._meta['codebuddy.ai/interruptionRequest']};
      }
      for(const [index,message] of f.messages.entries()){
        if(mode==='unscoped-interruption'&&index===2){const update=(message.params as any).update;update._meta={'codebuddy.ai/interruptionRequest':update._meta['codebuddy.ai/interruptionRequest']};}
        if(mode==='delayed-interruption'&&index===2)setImmediate(()=>{assert.equal(answerCalls,0);raw(message);});else raw(message);
      }
      emit('message.started',{messageId:`formatter:${f.tool}`,kind:'final',userVisible:true,logicalOrder:0});
      listener!(f.request);emit('message.started',{messageId:f.request.payload.messageId,kind:'permission_request',userVisible:true,logicalOrder:1});
      emit('message.fragment',{messageId:f.request.payload.messageId,fragmentKey:'permission',fragmentIndex:0,text:'synthetic permission'});
      emit('message.completed',{messageId:f.request.payload.messageId,finalFragmentIndex:0});
      if(mode==='extra-request')emit('input.requested',{...f.request.payload,vendorRequestId:'private-other'});
      if(mode==='withdrawn')emit('input.invalidated',{vendorRequestId:f.id,reason:'withdrawn'});
      if(mode==='foreign-tool')raw({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update:{sessionUpdate:'tool_call',toolCallId:'private-other',_meta:{'codebuddy.ai/toolName':'Bash'}}}});
      return {operationId:input.operationId,receipt:Promise.resolve({status:'accepted',sessionRef:f.session,runRef:f.run,receiptEvidence:'synthetic'})};
    },
    answer:input=>{answerCalls++;assert.deepEqual(input.answer,{kind:'permission',decision:'approve',optionCode:'once'});
      const receipt=(async()=>{
        await connection.call('_codebuddy.ai/resolveInterruption',{sessionId:input.sessionRef,toolCallId:f.tool,decision:mode==='persistent-decision'?'allowAll':'allow'},input.operationId);
        if(mode==='second-decision')await connection.call('_codebuddy.ai/resolveInterruption',{sessionId:input.sessionRef,toolCallId:f.tool,decision:'allow'},input.operationId);
        if(mode==='unknown-answer')return {status:'unknown' as const,errorCode:'state_unknown' as const};
        emit('input.accepted',{operationId:input.operationId,inputId:input.inputId,receiptEvidence:'synthetic'});
        raw({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update:{sessionUpdate:'tool_call_update',toolCallId:f.tool,status:'completed',
          rawOutput:{text:JSON.stringify({schemaVersion:1,kind:'final',text:mode==='changed-result'?'changed':text})}}}});
        const id=`formatter:${f.tool}`;emit('message.fragment',{messageId:id,fragmentKey:`${id}:snapshot`,fragmentIndex:0,text});
        emit('message.completed',{messageId:id,finalFragmentIndex:0});emit('run.completed',{completionEvidence:'synthetic',stopReason:'end_turn'});finishPrompt({stopReason:'end_turn'});
        return {status:'accepted' as const,sessionRef:input.sessionRef,runRef:input.runRef,vendorRequestId:input.vendorRequestId,receiptEvidence:'synthetic'};
      })();return {operationId:input.operationId,receipt};
    },
  };
  return {adapter,connection,get answerCalls(){return answerCalls;},get wireDecisions(){return wireDecisions;},checkCleanup(){assert.equal(connection.call,nativeCall);assert.equal(connection.onMessage,nativeMessage);assert.equal(unsubscribed,true);}};
}
test('a scoped explicit once decision requires raw acceptance, the original formatter result and output, and independent original Run completion',async()=>{
  const r=rig(),report=await formatterPermissionExperiment(r.adapter,r.connection,'private-session',formatterPermissionDecision,100);
  assert.equal(report['status'],'observed');assert.equal(report['executionPermissionApprovals'],1);assert.equal(r.answerCalls,1);assert.equal(report['rawDecisionMatched'],true);
  assert.equal(report['rawDecisionAccepted'],true);assert.equal(report['originalToolCompleted'],true);assert.equal(report['originalOutputMatched'],true);
  assert.equal(report['rawPromptEndTurn'],true);assert.equal(JSON.stringify(report).includes('private-'),false);r.checkCleanup();
});
test('the operator-approved probe waits for the matching interruption channel and complete request before its single decision',async()=>{
  const r=rig('delayed-interruption'),report=await formatterPermissionExperiment(r.adapter,r.connection,'private-session',formatterPermissionDecision,100);
  assert.equal(report['status'],'observed');assert.equal(r.answerCalls,1);r.checkCleanup();
});
test('native unscoped interruption uses only the already bound original formatter and emits bounded redacted diagnostics',async()=>{
  const r=rig('unscoped-interruption'),report=await formatterPermissionExperiment(r.adapter,r.connection,'private-session',formatterPermissionDecision,100);
  assert.equal(report['status'],'observed');assert.equal(r.answerCalls,1);assert.equal(report['executionPermissionApprovals'],1);
  const diagnostics=report['diagnostics'] as {nativeRequests:{hasRunMetadata:boolean;boundByOriginalTool:boolean}[];detailsComplete:boolean};
  assert.equal(diagnostics.detailsComplete,true);assert.equal(diagnostics.nativeRequests.some(value=>!value.hasRunMetadata&&value.boundByOriginalTool),true);
  assert.equal(JSON.stringify(report).includes('private-'),false);r.checkCleanup();
});
test('the installed native metadata combination preserves one exact decision and never exposes its transport correlation or parameter fragments',async()=>{
  const r=rig('native-metadata'),report=await formatterPermissionExperiment(r.adapter,r.connection,'private-session',formatterPermissionDecision,100);
  assert.equal(report['status'],'observed');assert.equal(r.wireDecisions,1);assert.equal(report['rawDecisionAccepted'],true);
  assert.equal(JSON.stringify(report).includes('private-'),false);assert.equal(JSON.stringify(report).includes('CourierFormatter'),false);r.checkCleanup();
});
test('unrelated or withdrawn requests never receive approval; an unknown answer is never retried and a changed tool result cannot pass',async()=>{
  for(const mode of ['extra-request','withdrawn','foreign-tool','unknown-answer','changed-result']){
    const r=rig(mode),report=await formatterPermissionExperiment(r.adapter,r.connection,'private-session',formatterPermissionDecision,100);
    assert.equal(report['status'],'unverified',mode);assert.equal(r.answerCalls,['unknown-answer','changed-result'].includes(mode)?1:0,mode);r.checkCleanup();
  }
});
test('an incorrect or repeated wire decision is blocked before transport, including persistent permission',async()=>{
  for(const mode of ['persistent-decision','second-decision']){
    const r=rig(mode),report=await formatterPermissionExperiment(r.adapter,r.connection,'private-session',formatterPermissionDecision,100);
    assert.equal(report['status'],'unverified');assert.equal(r.answerCalls,1);assert.equal(r.wireDecisions,mode==='persistent-decision'?0:1);
    assert.equal(report['executionPermissionApprovals'],r.wireDecisions);r.checkCleanup();
  }
});
