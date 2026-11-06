import test from 'node:test';
import assert from 'node:assert/strict';
import type { RpcMessage } from '../../src/adapters/workbuddy-experimental/connection.js';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';
import type { AcpConnection } from '../../src/adapters/workbuddy-experimental/connection.js';
import type { HarnessPort } from '../../src/adapters/harness/port.js';
import { prepareOwnedDenial,deniedToolObserved,acpPermissionDenialExperiment } from '../probes/workbuddy-acp-permission.js';

const command='python3 -I -S -c "print(\'synthetic\')"';
function fixture(owner='own-run') {
  const messages:RpcMessage[]=[
    {jsonrpc:'2.0',method:'session/update',params:{sessionId:'own-session',update:{sessionUpdate:'tool_call',toolCallId:'own-tool',
      _meta:{'codebuddy.ai/requestId':owner}}}},
    {jsonrpc:'2.0',id:17,method:'session/request_permission',params:{sessionId:'own-session',toolCall:{toolCallId:'own-tool',rawInput:{command},
      _meta:{'codebuddy.ai/toolName':'Bash'}},options:[{optionId:'allow',kind:'allow_once',name:'Allow once'},{optionId:'reject',kind:'reject_once',name:'Deny once'}]}},
    {jsonrpc:'2.0',method:'session/update',params:{sessionId:'own-session',update:{sessionUpdate:'session_info_update',_meta:{
      'codebuddy.ai/interruptionRequest':{interruptionId:'own-interruption',toolCallId:'own-tool',toolName:'Bash',toolInput:{command},options:['allow','deny']}}}}},
  ];
  const request:Extract<HarnessEvent,{eventType:'input.requested'}>={schemaVersion:1,eventKey:'own-event',sessionRef:'own-session',runRef:'own-run',
    eventType:'input.requested',payload:{vendorRequestId:JSON.stringify(['own-session','own-run','permission','own-tool']),kind:'permission',
      messageId:'own-message',adapterMappingRef:'own-mapping',options:[{code:'allow',label:'Allow once',decision:'approve'},{code:'reject',label:'Deny once',decision:'deny'}]}};
  return {messages,request};
}

test('owned ACP denial requires the exact original command, owner and visible reject scope',()=>{
  const f=fixture();
  assert.deepEqual(prepareOwnedDenial(f.messages,f.request,'own-session','own-run',command),{toolCallId:'own-tool',optionCode:'reject',sourceCount:2});
  assert.equal(prepareOwnedDenial(f.messages,{...f.request,payload:{...f.request.payload,options:[{code:'allow',label:'Allow',decision:'approve'}]}},
    'own-session','own-run',command),undefined);
});

test('owned ACP denial never borrows another request, owner or command or a missing native path',()=>{
  const f=fixture();
  for(const [messages,request,session,run,text] of [
    [f.messages,f.request,'foreign-session','own-run',command],
    [f.messages,f.request,'own-session','foreign-run',command],
    [f.messages,f.request,'own-session','own-run','different command'],
    [fixture('foreign-run').messages,f.request,'own-session','own-run',command],
    [f.messages.slice(1),f.request,'own-session','own-run',command],
    [f.messages.slice(0,2),f.request,'own-session','own-run',command],
    [f.messages,{...f.request,payload:{...f.request.payload,kind:'question'}},'own-session','own-run',command],
  ] as [RpcMessage[],HarnessEvent,string,string,string][])assert.equal(prepareOwnedDenial(messages,request,session,run,text),undefined);
});

test('a tool cancellation marker requires its matching authoritative reason, without a completed tool contradiction',()=>{
  const update=(sessionId:string,toolCallId:string,status:string,reason?:string):RpcMessage=>({jsonrpc:'2.0',method:'session/update',params:{sessionId,
    update:{sessionUpdate:'tool_call_update',toolCallId,status,content:[{type:'text',text:'Permission denied by user.'}],
      _meta:reason?{'codebuddy.ai/toolCancelReason':reason}:{}}}});
  const denied=update('own-session','own-tool','cancelled','permission_denied');
  assert.equal(deniedToolObserved([denied],'own-session','own-tool'),true);
  for(const frame of [update('foreign-session','own-tool','cancelled','permission_denied'),update('own-session','foreign-tool','cancelled','permission_denied'),
    update('own-session','own-tool','failed'),update('own-session','own-tool','cancelled','other_reason')])
    assert.equal(deniedToolObserved([frame],'own-session','own-tool'),false);
  assert.equal(deniedToolObserved([denied,update('own-session','own-tool','completed')],'own-session','own-tool'),false);
});

function nativeRejectFixture(unknown=false) {
  let listener:((event:HarnessEvent)=>void)|undefined,finish!:(value:unknown)=>void,denialCalls=0;
  const originalCall:AcpConnection['call']=async method=>method==='session/set_config_option'?{configOptions:[{id:'mode',currentValue:'default'}]}:
    new Promise<unknown>(resolve=>{finish=resolve;});
  const originalMessage=()=>{};
  const connection:Pick<AcpConnection,'call'|'onMessage'>={call:originalCall,onMessage:originalMessage};
  const base={schemaVersion:1 as const,eventKey:'own-event',sessionRef:'own-session',runRef:'own-run'};
  const adapter:Pick<HarnessPort,'start'|'answer'|'subscribe'>={
    subscribe:(_session,consume)=>{listener=consume;return ()=>{listener=undefined;};},
    start:input=>{
      const nativeCommand=/harmless command: (.*?)\. Use the tool/s.exec(input.text)![1]!;
      void connection.call('session/prompt',{},input.operationId).then(()=>listener?.({...base,eventType:'run.failed',
        payload:{errorCode:'run_failed',safeReason:'Synthetic cancellation',completionEvidence:'synthetic-prompt-result'}}));
      connection.onMessage({jsonrpc:'2.0',method:'session/update',params:{sessionId:'own-session',update:{sessionUpdate:'tool_call',toolCallId:'own-tool',
        _meta:{'codebuddy.ai/requestId':'own-run'}}}});
      connection.onMessage({jsonrpc:'2.0',method:'session/update',params:{sessionId:'own-session',update:{sessionUpdate:'session_info_update',_meta:{
        'codebuddy.ai/interruptionRequest':{interruptionId:'own-interruption',toolCallId:'own-tool',toolName:'Bash',toolInput:{command:nativeCommand},options:['allow','deny']}}}}});
      listener!({...base,eventType:'input.requested',payload:{vendorRequestId:JSON.stringify(['own-session','own-run','permission','own-tool']),kind:'permission',
        messageId:'permission-body',adapterMappingRef:'own-mapping',options:[{code:'allow',label:'Allow',decision:'approve'},{code:'deny',label:'Deny',decision:'deny'}]}});
      return {operationId:input.operationId,receipt:Promise.resolve({status:'accepted',sessionRef:'own-session',runRef:'own-run',receiptEvidence:'synthetic-start'})};
    },
    answer:input=>{
      denialCalls++;assert.deepEqual(input.answer,{kind:'permission',decision:'deny',optionCode:'deny'});
      listener!({...base,eventType:'input.accepted',payload:{operationId:input.operationId,inputId:input.inputId,receiptEvidence:'synthetic-reject'}});
      finish({stopReason:'cancelled'});
      return {operationId:input.operationId,receipt:Promise.resolve(unknown?{status:'unknown',errorCode:'state_unknown'}:
        {status:'accepted',sessionRef:'own-session',runRef:'own-run',vendorRequestId:input.vendorRequestId,receiptEvidence:'synthetic-reject'})};
    },
  };
  return {adapter,connection,originalCall,originalMessage,get denialCalls(){return denialCalls;}};
}

test('native interruption rejection is acknowledged before Run cancellation, without inventing a tool cancellation frame',async()=>{
  const f=nativeRejectFixture(),report=await acpPermissionDenialExperiment(f.adapter,f.connection,'own-session',1000);
  assert.equal(report['status'],'observed');assert.equal(report['denialAndRunCancellationObserved'],true);
  assert.equal(report['nativeToolCancellationMarkerObserved'],false);assert.equal(report['rawStopReason'],'cancelled');
  assert.equal(f.denialCalls,1);assert.equal(f.connection.call,f.originalCall);assert.equal(f.connection.onMessage,f.originalMessage);
});

test('a cancelled Run cannot turn an unknown denial into accepted or cause another decision',async()=>{
  const f=nativeRejectFixture(true),report=await acpPermissionDenialExperiment(f.adapter,f.connection,'own-session',1000);
  assert.equal(report['status'],'unverified');assert.equal(f.denialCalls,1);
  assert.deepEqual(report['denial'],{status:'unknown',code:'state_unknown'});
  assert.equal(f.connection.call,f.originalCall);assert.equal(f.connection.onMessage,f.originalMessage);
});
