import test from 'node:test';
import assert from 'node:assert/strict';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';
import type { HarnessPort } from '../../src/adapters/harness/port.js';
import type { AcpConnection } from '../../src/adapters/workbuddy-experimental/connection.js';
import { formatterFullToolName } from '../../src/adapters/workbuddy-experimental/formatter.js';
import { permissionSteerExperiment } from '../probes/workbuddy-permission-steer.js';
import { workbuddyCapabilityProbe } from '../probes/workbuddy-capabilities.js';

function fixture(mode='normal') {
  const session='private-session',run='private-run',tool='private-bash',listeners=new Set<(event:HarnessEvent)=>void>();
  const request=JSON.stringify([session,run,'permission',tool]),counters={starts:0,steers:0,answers:0};
  let sequence=0,finish!:(value:unknown)=>void;
  const connection:Pick<AcpConnection,'call'|'onMessage'>={onMessage:()=>{},call:async(method)=>{
    if(method==='session/set_config_option')return {configOptions:[{id:'mode',currentValue:mode==='mode-unknown'?'other':'default'}]};
    if(method==='session/prompt')return new Promise(resolve=>{finish=resolve;});
    return method==='session/steer'?{steered:true,ownerRequestId:run}:{resolved:true,queued:false};
  }};
  const originalCall=connection.call,originalMessage=connection.onMessage;
  const raw=(update:Record<string,unknown>)=>connection.onMessage({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update}});
  const emit=(eventType:HarnessEvent['eventType'],payload:unknown)=>{
    for(const listener of listeners)listener({schemaVersion:1,eventKey:`event-${sequence++}`,sessionRef:session,runRef:run,eventType,payload} as HarnessEvent);
  };
  const adapter:Pick<HarnessPort,'start'|'steer'|'answer'|'subscribe'>={
    subscribe:(_ref,listener)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},
    start:input=>{
      counters.starts++;void connection.call('session/prompt',{},input.operationId);
      const command=/python3 -I -S -c "print\('CourierPermission-[a-f0-9-]{36}'\)"/.exec(input.text)![0];
      const meta={'codebuddy.ai/toolName':'Bash','codebuddy.ai/conversationRequestId':run,'codebuddy.ai/messageRequestId':run};
      raw({sessionUpdate:'tool_call',toolCallId:tool,rawInput:{command},_meta:meta});
      const interruption={interruptionId:'private-interruption',toolCallId:tool,toolName:'Bash',toolInput:{command},options:['allow','deny']};
      raw({sessionUpdate:'session_info_update',_meta:{'codebuddy.ai/interruptionRequest':interruption}});
      connection.onMessage({jsonrpc:'2.0',id:'private-rpc',method:'session/request_permission',params:{sessionId:session,
        toolCall:{toolCallId:tool,rawInput:{command},_meta:{'codebuddy.ai/toolName':'Bash'}},
        options:[{optionId:'allow',kind:'allow_once',name:'Allow'},{optionId:'deny',kind:'reject_once',name:'Deny'}]}});
      const messageId=`interaction:${request}`;
      emit('message.started',{messageId,kind:'permission_request',userVisible:true,logicalOrder:0});
      emit('message.fragment',{messageId,fragmentKey:messageId,fragmentIndex:0,text:'synthetic permission'});emit('message.completed',{messageId,finalFragmentIndex:0});
      if(mode!=='missing-request')emit('input.requested',{vendorRequestId:request,kind:'permission',messageId,adapterMappingRef:'private-map',
        options:[{code:'allow',label:'Allow',decision:'allow'},{code:'deny',label:'Deny',decision:'deny'}]});
      if(mode==='other-tool')raw({sessionUpdate:'tool_call',toolCallId:'private-other',_meta:{'codebuddy.ai/toolName':'Write'}});
      if(mode==='executed')raw({sessionUpdate:'tool_call_update',toolCallId:tool,status:'completed'});
      if(mode==='overflow')raw({sessionUpdate:'plan',text:'x'.repeat(8388609)});
      if(mode==='raw-extra-permission')connection.onMessage({jsonrpc:'2.0',id:'private-extra',method:'session/request_permission',
        params:{sessionId:session,toolCall:{toolCallId:'private-extra',_meta:{'codebuddy.ai/toolName':formatterFullToolName}}}});
      return {operationId:input.operationId,receipt:Promise.resolve(mode==='unknown-start'?{status:'unknown',errorCode:'state_unknown'}:
        {status:'accepted',sessionRef:session,runRef:run,receiptEvidence:'synthetic-start'})};
    },
    steer:input=>{
      counters.steers++;const index=counters.steers;
      const params={sessionId:session,expectedRequestId:run,clientUserMessageId:input.inputId,contentBlocks:[{type:'text',text:input.text}],
        _meta:{'codebuddy.ai':{queueOrigin:'steer'},'agent-courier':{operationId:input.operationId,inputId:input.inputId,runRef:run}}};
      const pending=connection.call('session/steer',params,input.operationId);
      const marker=/CourierPermissionSteer[AB]-[a-f0-9-]{36}/.exec(input.text)![0];
      const injection={'codebuddy.ai/conversationRequestId':run,'codebuddy.ai/requestId':run,'codebuddy.ai/messageRequestId':input.inputId,
        'codebuddy.ai/messageId':input.inputId,'codebuddy.ai/steerClientMeta':params._meta};
      raw({sessionUpdate:'user_message_chunk',messageId:input.inputId,content:{type:'text',text:mode==='changed-injection'?'changed':input.text},_meta:injection});
      emit('input.applied',{inputId:input.inputId,appliedEvidence:'synthetic-injection'});
      if(mode==='withdrawn')emit('input.invalidated',{vendorRequestId:request,reason:'withdrawn'});
      if(mode!=='missing-effect'){
        const id=`private-progress-${index}`,text=mode==='wrong-effect'?'wrong':marker;
        const meta={'codebuddy.ai/toolName':formatterFullToolName,'codebuddy.ai/conversationRequestId':mode==='foreign-effect'?'foreign':run,
          'codebuddy.ai/requestId':run,'codebuddy.ai/messageRequestId':run};
        raw({sessionUpdate:'tool_call',toolCallId:id,rawInput:{kind:'progress',text},_meta:meta});
        raw({sessionUpdate:'tool_call_update',toolCallId:id,status:'completed',rawOutput:{text:JSON.stringify({schemaVersion:1,kind:'progress',text})},_meta:meta});
        const messageId=`formatter:${id}`;emit('message.started',{messageId,kind:'progress',userVisible:true,logicalOrder:index});
        emit('message.fragment',{messageId,fragmentKey:`${messageId}:snapshot`,fragmentIndex:0,text});emit('message.completed',{messageId,finalFragmentIndex:0});
      }
      return {operationId:input.operationId,receipt:pending.then(()=>mode==='unknown-steer'?{status:'unknown',errorCode:'state_unknown'}:
        {status:'accepted',sessionRef:session,runRef:run,receiptEvidence:'synthetic-steer'})};
    },
    answer:input=>{
      counters.answers++;assert.equal(input.answer.kind,'permission');assert.equal(input.answer.kind==='permission'&&input.answer.decision,'deny');
      const receipt=connection.call('_codebuddy.ai/resolveInterruption',{sessionId:session,toolCallId:tool,decision:'deny'},input.operationId).then(()=>{
        if(mode==='unknown-denial')return {status:'unknown' as const,errorCode:'state_unknown' as const};
        emit('input.accepted',{operationId:input.operationId,inputId:input.inputId,receiptEvidence:'synthetic-denial'});
        emit('run.failed',{completionEvidence:'synthetic-cancel',errorCode:'request_cancelled',safeReason:'synthetic'});finish({stopReason:'cancelled'});
        return {status:'accepted' as const,sessionRef:session,runRef:run,vendorRequestId:request,receiptEvidence:'synthetic-denial'};
      });return {operationId:input.operationId,receipt};
    },
  };
  return {adapter,connection,counters,restored:()=>connection.call===originalCall&&connection.onMessage===originalMessage&&listeners.size===0};
}
test('permission-wait probe requires two actual in-Run effects before its one explicit denial and never grants permission',async()=>{
  const f=fixture(),result=await permissionSteerExperiment(f.adapter,f.connection,'private-session',500);
  assert.equal(result['status'],'observed');assert.deepEqual(f.counters,{starts:1,steers:2,answers:1});assert.equal(f.restored(),true);
  assert.equal(result['executionPermissionApprovals'],0);assert.doesNotMatch(JSON.stringify(result),/private-|CourierPermission|python3/);
});
test('execution, another tool, an extra raw permission or a truncated trace prevents any control or denial decision',async()=>{
  for(const mode of ['executed','other-tool','raw-extra-permission','overflow']){
    const f=fixture(mode),result=await permissionSteerExperiment(f.adapter,f.connection,'private-session',100);
    assert.equal(result['status'],'unverified',mode);assert.deepEqual(f.counters,{starts:1,steers:0,answers:0},mode);assert.equal(f.restored(),true);
  }
});
test('automatic permission-wait and managed modes require explicit enablement, reject mixed probes and stop at private configuration',async()=>{
  const previous=process.stderr.write;process.stderr.write=(()=>true) as typeof process.stderr.write;
  try {
    for(const mode of ['--acp-automatic-permission-steer','--acp-automatic-managed','--acp-automatic-managed-text','--acp-automatic-managed-question','--acp-automatic-managed-recovery','--acp-automatic-managed-process','--acp-automatic-managed-approve-one-formatter','--acp-automatic-managed-formatter','--acp-automatic-managed-formatter-steer','--acp-automatic-managed-formatter-question-steer','--acp-automatic-managed-question-steer']){
      const args=['--enable-live','--launch-profile','never-read','--output','never-write',mode];
      assert.equal(await workbuddyCapabilityProbe([mode]),2);
      for(const other of ['--acp-automatic-runtime','--acp-automatic-permission-steer','--acp-automatic-managed','--acp-automatic-managed-text','--acp-automatic-managed-question','--acp-automatic-managed-recovery','--acp-automatic-managed-process','--acp-automatic-managed-approve-one-formatter','--acp-automatic-managed-formatter','--acp-automatic-managed-formatter-steer','--acp-automatic-managed-formatter-question-steer','--acp-automatic-managed-question-steer','--question','--acp-bootstrap-owned-run'])
        if(other!==mode)assert.equal(await workbuddyCapabilityProbe([...args,other]),2);
      assert.equal(await workbuddyCapabilityProbe(args),3);
    }
  }finally{process.stderr.write=previous;}
});
test('permission-wait probe stops uncertain control and denial without approval, fallback or replay',async()=>{
  for(const mode of ['mode-unknown','unknown-start','missing-request','withdrawn','unknown-steer','unknown-denial']){
    const f=fixture(mode),result=await permissionSteerExperiment(f.adapter,f.connection,'private-session',20);
    assert.equal(result['status'],'unverified',mode);assert.ok(f.counters.starts<=1);assert.ok(f.counters.steers<=2);assert.ok(f.counters.answers<=1);
    if(['mode-unknown','unknown-start','missing-request','withdrawn','unknown-steer'].includes(mode))assert.equal(f.counters.answers,0,mode);
    assert.equal(f.restored(),true,mode);
  }
});
test('accepted controls cannot replace exact injection bodies, owned native output or both distinct progress effects',async()=>{
  for(const mode of ['changed-injection','foreign-effect','missing-effect','wrong-effect']){
    const f=fixture(mode),result=await permissionSteerExperiment(f.adapter,f.connection,'private-session',30);
    assert.equal(result['status'],'unverified',mode);assert.equal(result['executionPermissionApprovals'],0);assert.equal(f.restored(),true);
  }
});
