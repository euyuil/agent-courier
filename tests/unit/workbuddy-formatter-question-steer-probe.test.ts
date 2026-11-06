import test from 'node:test';
import assert from 'node:assert/strict';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';
import type { HarnessPort } from '../../src/adapters/harness/port.js';
import type { AcpConnection } from '../../src/adapters/workbuddy-experimental/connection.js';
import { formatterFullToolName } from '../../src/adapters/workbuddy-experimental/formatter.js';
import { formatterQuestionSteerExperiment } from '../probes/workbuddy-formatter-question-steer.js';
import { workbuddyCapabilityProbe } from '../probes/workbuddy-capabilities.js';

function fixture(mode='normal') {
  const session='private-session',run='private-run',listeners=new Set<(event:HarnessEvent)=>void>();
  const counters={starts:0,steers:0,answers:0};
  const inputs:{operationId:string;inputId:string;text:string}[]=[];
  let suffixFirst='',suffixSecond='',final='',extra='',finish!:(value:unknown)=>void,sequence=0;
  const connection:Pick<AcpConnection,'call'|'onMessage'>={onMessage:()=>{},call:async(method)=>{
    if(method==='session/prompt')return new Promise(resolve=>{finish=resolve;});
    return method==='session/steer'?{steered:true,ownerRequestId:run}:{resolved:true,queued:false};
  }};
  const originalCall=connection.call,originalMessage=connection.onMessage;
  const raw=(update:Record<string,unknown>)=>connection.onMessage({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update}});
  const emit=(eventType:HarnessEvent['eventType'],payload:unknown)=>{
    for(const listener of listeners)listener({schemaVersion:1,eventKey:`event-${sequence++}`,sessionRef:session,runRef:run,eventType,payload} as HarnessEvent);
  };
  const question=(index:number,suffix:string)=>{
    const prefix=index===0?'First':'Second',text=`Courier${prefix}Question-${suffix}`,labels=[`Courier${prefix}A-${suffix}`,`Courier${prefix}B-${suffix}`],tool=`private-question-${index}`;
    const meta={'codebuddy.ai/toolName':mode==='wrong-native'?'Bash':'AskUserQuestion',
      'codebuddy.ai/conversationRequestId':run,'codebuddy.ai/requestId':index===0?run:'private-next','codebuddy.ai/messageRequestId':run};
    const native={questions:[{question:text,options:labels.map(label=>({label}))}]};
    raw({sessionUpdate:'tool_call',toolCallId:tool,rawInput:native,_meta:meta});
    if(mode==='early-tool-result')raw({sessionUpdate:'tool_call_update',toolCallId:tool,status:'completed',rawOutput:{text:labels[1]}});
    connection.onMessage({jsonrpc:'2.0',id:`private-rpc-${index}`,method:'session/request_permission',params:{sessionId:session,
      toolCall:{toolCallId:tool,rawInput:native,_meta:{'codebuddy.ai/toolName':mode==='wrong-native'?'Bash':'AskUserQuestion'}},
      options:[{optionId:'allow',kind:'allow_once',name:'Allow once'},{optionId:'deny',kind:'reject_once',name:'Deny'}]}});
    if(mode==='conflicting-question'&&index===0)connection.onMessage({jsonrpc:'2.0',id:'private-conflict',method:'session/request_permission',params:{sessionId:session,
      toolCall:{toolCallId:tool,rawInput:{questions:[{question:'changed private question',options:labels.map(label=>({label}))}]},_meta:{'codebuddy.ai/toolName':'AskUserQuestion'}},
      options:[{optionId:'allow',kind:'allow_once',name:'Allow once'}]}});
    const vendorRequestId=JSON.stringify([session,run,'question',tool]),messageId=`interaction:${vendorRequestId}`;
    emit('input.requested',{vendorRequestId,kind:mode==='permission'?'permission':'question',messageId,adapterMappingRef:'private-mapping',
      answerSchema:{mode:'form',fields:[{fieldId:'q_0',label:text,required:true,valueType:'choice',options:labels.map(code=>({code,label:code}))}]}});
    emit('message.started',{messageId,kind:'question',userVisible:true,logicalOrder:index});
    emit('message.fragment',{messageId,fragmentKey:messageId,fragmentIndex:0,text});emit('message.completed',{messageId,finalFragmentIndex:0});
  };
  const terminal=()=>{
    const text=[final,`CourierFirstB-${suffixFirst}`,`CourierSecondB-${suffixSecond}`,...(['missing-effect','native-missing-effect'].includes(mode)?[]:[extra])].join(' '),id='private-final';
    if(mode.startsWith('native-')){
      raw({sessionUpdate:mode==='native-echo'?'user_message_chunk':'agent_message_chunk',messageId:id,content:{type:'text',text},
        _meta:{'codebuddy.ai/conversationRequestId':run,'codebuddy.ai/requestId':mode==='native-foreign'?'foreign':'private-next',
          'codebuddy.ai/messageRequestId':run,'codebuddy.ai/messageId':id}});
      emit('message.started',{messageId:id,kind:'message',userVisible:true,logicalOrder:2});
      emit('message.fragment',{messageId:id,fragmentKey:`${id}:0`,fragmentIndex:0,text});emit('message.completed',{messageId:id,finalFragmentIndex:0});
      emit('run.completed',{completionEvidence:'synthetic-end',stopReason:'end_turn'});finish({stopReason:'end_turn'});return;
    }
    const meta={'codebuddy.ai/toolName':formatterFullToolName,'codebuddy.ai/conversationRequestId':run,
      'codebuddy.ai/requestId':mode==='foreign-final'?'foreign':'private-next','codebuddy.ai/messageRequestId':run};
    raw({sessionUpdate:'tool_call',toolCallId:id,rawInput:{kind:'final',text},_meta:meta});
    raw({sessionUpdate:'tool_call_update',toolCallId:id,status:'completed',rawOutput:{text:JSON.stringify({schemaVersion:1,kind:'final',text})},_meta:meta});
    const messageId=`formatter:${id}`;emit('message.started',{messageId,kind:'final',userVisible:true,logicalOrder:2});
    emit('message.fragment',{messageId,fragmentKey:`${messageId}:snapshot`,fragmentIndex:0,text});emit('message.completed',{messageId,finalFragmentIndex:0});
    emit('run.completed',{completionEvidence:'synthetic-end',stopReason:'end_turn'});finish({stopReason:'end_turn'});
  };
  const adapter:Pick<HarnessPort,'start'|'steer'|'answer'|'subscribe'>={
    subscribe:(_session,listener)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},
    start:input=>{
      counters.starts++;void connection.call('session/prompt',{},input.operationId);
      suffixFirst=/CourierFirstQuestion-([a-f0-9-]{36})/.exec(input.text)![1]!;
      final=/CourierQuestionFinal-[a-f0-9-]{36}/.exec(input.text)![0];
      if(mode==='overflow')for(let i=0;i<4097;i++)raw({sessionUpdate:'plan'});
      if(mode!=='timeout'&&mode!=='unknown-start')question(0,suffixFirst);
      if(mode==='raw-permission')connection.onMessage({jsonrpc:'2.0',id:'private-extra-permission',method:'session/request_permission',params:{sessionId:session,
        toolCall:{toolCallId:'private-extra-tool',rawInput:{command:'synthetic'},_meta:{'codebuddy.ai/toolName':'Bash'}},options:[{optionId:'deny',kind:'reject_once',name:'Deny'}]}});
      return {operationId:input.operationId,receipt:Promise.resolve(mode==='unknown-start'?{status:'unknown',errorCode:'state_unknown'}:
        {status:'accepted',sessionRef:session,runRef:run,receiptEvidence:'synthetic-start'})};
    },
    steer:input=>{
      counters.steers++;inputs.push(input);
      if(counters.steers===1)suffixSecond=/CourierSecondQuestion-([a-f0-9-]{36})/.exec(input.text)![1]!;
      else extra=/CourierQuestionExtra-[a-f0-9-]{36}/.exec(input.text)![0];
      const params={sessionId:session,expectedRequestId:run,clientUserMessageId:input.inputId,contentBlocks:[{type:'text',text:input.text}],
        _meta:{'codebuddy.ai':{queueOrigin:'steer'},'agent-courier':{operationId:input.operationId,inputId:input.inputId,runRef:run}}};
      const result=connection.call('session/steer',params,input.operationId);
      if(mode==='withdrawn')emit('input.invalidated',{vendorRequestId:JSON.stringify([session,run,'question','private-question-0']),reason:'withdrawn'});
      return {operationId:input.operationId,receipt:result.then(()=>mode==='unknown-steer'?{status:'unknown',errorCode:'state_unknown'}:
        {status:'accepted',sessionRef:session,runRef:run,receiptEvidence:'synthetic-steer'})};
    },
    answer:input=>{
      counters.answers++;const index=counters.answers-1,tool=`private-question-${index}`;
      const receipt=connection.call('_codebuddy.ai/resolveInterruption',{sessionId:session,toolCallId:tool,decision:'allow',answers:{q_0:input.answer.kind==='form'?input.answer.values['q_0']:undefined}},input.operationId).then(()=>{
        if(mode==='unknown-answer')return {status:'unknown' as const,errorCode:'state_unknown' as const};
        emit('input.accepted',{operationId:input.operationId,inputId:input.inputId,receiptEvidence:'synthetic-answer'});
        if(index===1&&mode==='native-before-result')terminal();
        raw({sessionUpdate:'tool_call_update',toolCallId:tool,status:'completed',...(mode==='missing-tool-result'?{}:{rawOutput:{text:String(input.answer.kind==='form'?input.answer.values['q_0']:''),...(mode==='error-tool-result'?{isError:true}:{})}})});
        if(index===0){
          for(const control of inputs){
            const meta={'codebuddy.ai/conversationRequestId':run,'codebuddy.ai/requestId':'private-next','codebuddy.ai/messageRequestId':control.inputId,'codebuddy.ai/messageId':control.inputId,
              'codebuddy.ai/steerClientMeta':{'codebuddy.ai':{queueOrigin:'steer'},'agent-courier':{operationId:control.operationId,inputId:control.inputId,runRef:run}}};
            raw({sessionUpdate:'user_message_chunk',messageId:control.inputId,content:{type:'text',text:mode==='bad-echo'?'changed':control.text},_meta:meta});
            emit('input.applied',{inputId:control.inputId,appliedEvidence:'synthetic-injection'});
          }
          question(1,suffixSecond);
        }else if(mode!=='native-before-result')terminal();
        return {status:'accepted' as const,sessionRef:session,runRef:run,vendorRequestId:input.vendorRequestId,receiptEvidence:'synthetic-answer'};
      });
      return {operationId:input.operationId,receipt};
    },
  };
  return {adapter,connection,counters,restored:()=>connection.call===originalCall&&connection.onMessage===originalMessage&&listeners.size===0};
}

test('formal question-steer probe requires both native answers, exact injection proofs, complete final effects and raw termination',async()=>{
  const f=fixture(),result=await formatterQuestionSteerExperiment(f.adapter,f.connection,'private-session',100);
  assert.equal(result['status'],'observed');assert.deepEqual(f.counters,{starts:1,steers:2,answers:2});
  assert.equal(result['executionPermissionApprovals'],0);assert.equal(f.restored(),true);
  assert.equal(JSON.stringify(result).includes('private-'),false);
});

test('native text question-steer observation preserves all four effects after both native question results without claiming formatter output',async()=>{
  const f=fixture('native-valid'),result=await formatterQuestionSteerExperiment(f.adapter,f.connection,'private-session',100,'native-text');
  assert.equal(result['status'],'observed');assert.deepEqual(f.counters,{starts:1,steers:2,answers:2});
  assert.equal(result['outputMode'],'native-text');assert.equal(result['ordinaryIdentitiesAndBodiesMatched'],true);
  assert.equal(result['ordinaryEffectsMatched'],true);assert.equal(result['finalIdentitiesAndBodiesMatched'],false);
  assert.equal(result['executionPermissionApprovals'],0);assert.equal(f.restored(),true);
});
test('native text cannot prove effects using an input echo, foreign provenance, missing addition or body preceding the native answer result',async()=>{
  for(const mode of ['native-echo','native-foreign','native-missing-effect','native-before-result']){
    const f=fixture(mode),result=await formatterQuestionSteerExperiment(f.adapter,f.connection,'private-session',100,'native-text');
    assert.equal(result['status'],'unverified',mode);assert.deepEqual(f.counters,{starts:1,steers:2,answers:2});assert.equal(f.restored(),true);
  }
});

test('formal question-steer probe never answers a permission, unbound native question or unknown start',async()=>{
  for(const mode of ['permission','wrong-native','unknown-start','raw-permission','conflicting-question','early-tool-result']){
    const f=fixture(mode),result=await formatterQuestionSteerExperiment(f.adapter,f.connection,'private-session',100);
    assert.equal(result['status'],'unverified',mode);assert.deepEqual(f.counters,{starts:1,steers:0,answers:0},mode);assert.equal(f.restored(),true);
  }
});

test('withdrawing the original question during a control stops further control and answer calls',async()=>{
  const f=fixture('withdrawn'),result=await formatterQuestionSteerExperiment(f.adapter,f.connection,'private-session',100);
  assert.equal(result['status'],'unverified');assert.deepEqual(f.counters,{starts:1,steers:1,answers:0});assert.equal(f.restored(),true);
});

test('formal question-steer probe stops after an unknown control or answer without fallback or replay',async()=>{
  for(const mode of ['unknown-steer','unknown-answer']){
    const f=fixture(mode),result=await formatterQuestionSteerExperiment(f.adapter,f.connection,'private-session',100);
    assert.equal(result['status'],'unverified');assert.equal(f.counters.steers,mode==='unknown-steer'?1:2);
    assert.equal(f.counters.answers,mode==='unknown-steer'?0:1);assert.equal(f.restored(),true);
  }
});

test('receipt and final text cannot replace native tool results, exact injected bodies or original Run provenance',async()=>{
  for(const mode of ['missing-effect','missing-tool-result','bad-echo','foreign-final','error-tool-result']){
    const f=fixture(mode),result=await formatterQuestionSteerExperiment(f.adapter,f.connection,'private-session',100);
    assert.equal(result['status'],'unverified',mode);assert.equal(f.restored(),true);
    assert.equal(JSON.stringify(result).includes('private-'),false);
  }
});

test('formal question-steer probe bounds observations and restores callbacks on timeout or overflow',async()=>{
  for(const mode of ['timeout','overflow']){
    const f=fixture(mode),result=await formatterQuestionSteerExperiment(f.adapter,f.connection,'private-session',10);
    assert.equal(result['status'],'unverified');assert.equal(f.counters.answers,0);assert.equal(f.restored(),true);
  }
});

test('question-steer CLI requires explicit enablement, rejects mixed owned modes and recognizes its private configuration gate',async()=>{
  const previous=process.stderr.write;let output='';
  process.stderr.write=((chunk:unknown)=>{output+=String(chunk);return true;}) as typeof process.stderr.write;
  try {
    const mode='--acp-bootstrap-owned-formatter-question-steer';
    assert.equal(await workbuddyCapabilityProbe([mode]),2);
    const args=['--enable-live','--launch-profile','synthetic-missing-launch.json','--output','synthetic-output.json',mode];
    assert.equal(await workbuddyCapabilityProbe([...args,'--acp-bootstrap-owned-formatter-contract']),2);
    assert.equal(await workbuddyCapabilityProbe(args),3);
    const release=['--enable-live','--launch-profile','synthetic-missing-launch.json','--output','synthetic-output.json','--acp-release-handoff'];
    assert.equal(await workbuddyCapabilityProbe(['--acp-release-handoff']),2);
    assert.equal(await workbuddyCapabilityProbe([...release,'--acp-handoff']),2);
    assert.equal(await workbuddyCapabilityProbe(release),3);
    const history=['--enable-live','--launch-profile','synthetic-missing-launch.json','--output','synthetic-output.json','--acp-bootstrap-owned-formatter-history'];
    assert.equal(await workbuddyCapabilityProbe(['--acp-bootstrap-owned-formatter-history']),2);
    assert.equal(await workbuddyCapabilityProbe([...history,'--acp-bootstrap-owned-formatter-contract']),2);
    assert.equal(await workbuddyCapabilityProbe(history),3);
    const isolation=['--enable-live','--launch-profile','synthetic-missing-launch.json','--output','synthetic-output.json','--acp-bootstrap-owned-isolation'];
    assert.equal(await workbuddyCapabilityProbe(['--acp-bootstrap-owned-isolation']),2);
    assert.equal(await workbuddyCapabilityProbe([...isolation,'--acp-bootstrap-owned-run']),2);
    assert.equal(await workbuddyCapabilityProbe(isolation),3);
    assert.ok(output.includes('private_configuration'));
  }finally{process.stderr.write=previous;}
});
