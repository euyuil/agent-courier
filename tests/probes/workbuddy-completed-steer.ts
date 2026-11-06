import { randomUUID } from 'node:crypto';
import { AcpConnection } from '../../src/adapters/workbuddy-experimental/connection.js';
import { WorkBuddySteering } from '../../src/adapters/workbuddy-experimental/steer.js';
import { record,requestRef,metaField,internalFrame,newRequestRef } from '../../src/adapters/workbuddy-experimental/metadata.js';
import { safeCode } from '../../src/domain/errors.js';
import { ownRuntimeEndpoints,identifyOwnAcpTransport } from './workbuddy-acp.js';
import { WorkBuddyTrace } from './workbuddy-trace.js';

interface Diagnostic {evaluate(expression:string,timeout?:number):Promise<unknown>}
export function completedRunReady(value:unknown,owner:string,run:string,marker:string):boolean {
  const state=record(value);
  if(!owner||!run||!marker||state['sessionId']!==owner||state['isProcessing']!==false||state['returned']!==true||state['failed']!==false||
    state['stopReason']!=='end_turn'||state['pendingQuestions']!==0||state['pendingPermissions']!==0||!Array.isArray(state['events']))return false;
  const messages=new Map<string,string>();
  for(const raw of state['events']) {
    const params=record(raw),update=record(params['update']);
    // 正常桌面历史已由上层 Harness 会话容器限定；若事件另带会话标识，仍须严格一致。
    if(params['sessionId']!==undefined&&params['sessionId']!==owner)return false;
    if(internalFrame(params,update))continue;
    if(['tool_call','tool_call_update','tool_call_pending'].includes(String(update['sessionUpdate'])))return false;
    if(!['agent_message_chunk','assistant_message_chunk'].includes(String(update['sessionUpdate'])))continue;
    if((requestRef(update)??requestRef(params))!==run)return false;
    const content=record(update['content']),id=metaField(update['_meta'],'messageId')??update['messageId'];
    if(typeof id!=='string'||!id||content['type']!=='text'||typeof content['text']!=='string')return false;
    const text=(messages.get(id)??'')+content['text'];if(text.length>65536)return false;
    messages.set(id,text);
  }
  return [...messages.values()].some(text=>text.includes(marker));
}
export function unchangedCompletedRun(before:unknown,after:unknown,owner:string,run:string,marker:string):boolean {
  return completedRunReady(before,owner,run,marker)&&completedRunReady(after,owner,run,marker)&&
    JSON.stringify(record(before)['events'])===JSON.stringify(record(after)['events'])&&
    JSON.stringify(record(before)['history'])===JSON.stringify(record(after)['history']);
}
export async function completedSteerExperiment(diagnostic:Diagnostic,cwd:string):Promise<Record<string,unknown>> {
  const owner=await diagnostic.evaluate(`(async()=>{const p=globalThis.__courierCapabilityProbe;if(typeof p?.sessionId!=='string')return;
    const s=await globalThis.__wbInvoke('session:get',{},p.sessionId);
    return !s?.__wbError&&s?.sessionId===p.sessionId&&s?.cwd===${JSON.stringify(cwd)}&&s?.isProcessing===false?p.sessionId:undefined;})()`);
  if(typeof owner!=='string')return {status:'original_owner_unverified'};
  const runtime=ownRuntimeEndpoints(cwd,'/proc',owner),identified=await identifyOwnAcpTransport(runtime.endpoints);
  if(!identified.endpoint)return {status:'endpoint_unverified'};
  const run=newRequestRef(),inputId=randomUUID(),operationId=randomUUID(),marker=`CourierCompleted-${randomUUID()}`;
  const trace=new WorkBuddyTrace(owner,{run,input:inputId,operation:operationId},{original:marker,changed:''});
  const connection=new AcpConnection({endpoint:identified.endpoint,timeoutMs:5000}),stored=new Map<string,unknown>(),targetEvents:Record<string,unknown>[]=[];
  let normalTaskSubmissions=0,normalTaskSubmissionAttempted=false,steerDispatches=0,applied=false,conflict=false,rawReason='not_observed',observingTarget=false,streamTruncated=false;
  const call=connection.call.bind(connection);
  connection.call=(method,params,id,timeout)=>{
    const result=call(method,params,id,timeout);
    if(method==='session/steer')void result.then(value=>{
      const reason=record(value)['reason'];rawReason=reason==='idle'||reason==='stale'?reason:'other';
    }).catch(()=>{});
    return result;
  };
  const steering=new WorkBuddySteering(connection,{get:key=>stored.get(key),set:(key,value)=>{stored.set(key,value);}},
    ()=>{applied=true;trace.mark('control_applied');},()=>{conflict=true;});
  connection.onMessage=message=>{
    if(message.method!=='session/update')return;
    const params=record(message.params),update=record(params['update']);trace.event('acp',params);
    if(params['sessionId']===owner&&!internalFrame(params,update)) {
      if(observingTarget){if(targetEvents.length<10000)targetEvents.push(params);else streamTruncated=true;}
      const ref=requestRef(update)??requestRef(params);if(ref)steering.consume(owner,ref,params);
    }
  };
  const finish=(result:Record<string,unknown>)=>{
    const data=trace.snapshot();return {...result,normalTaskSubmissions,normalTaskSubmissionAttempted,steerDispatches,rawReason,appliedObserved:applied,protocolConflict:conflict,
      executionPermissionApprovals:0,sessionLoads:0,rawPromptCalls:0,streamTruncated,traceSummary:{events:data.rows.length,truncated:data.truncated},trace:data};
  };
  const expression=`(async()=>{const p=globalThis.__courierCapabilityProbe;if(p?.sessionId!==${JSON.stringify(owner)})return;
    const s=await globalThis.__wbInvoke('session:get',{},p.sessionId);if(s?.__wbError||s?.sessionId!==p.sessionId||s?.cwd!==${JSON.stringify(cwd)})return;
    return {sessionId:s.sessionId,isProcessing:s.isProcessing===true,returned:p.completedSteerResult!==undefined,failed:p.completedSteerFailed===true,
      stopReason:p.completedSteerResult?.stopReason,pendingQuestions:(s.pendingQuestions??[]).length,pendingPermissions:(s.pendingPermissions??[]).length,
      events:(s.eventHistory??[]).slice(p.completedSteerStartCount)};})()`;
  const observe=async()=>{
    const state=record(await diagnostic.evaluate(expression));
    // 输出归属使用订阅到达时保留的原始 ACP 元数据；桌面历史仅用于比较变化。
    return {...state,history:state['events'],events:[...targetEvents]};
  };
  try {
    await connection.connect();await connection.call('initialize',{protocolVersion:1,clientInfo:{name:'Agent Courier completed-run probe',version:'1'},clientCapabilities:{}});
    trace.mark('task_submit');
    const prompt=`Do not use tools, read or write files, or contact the network. Reply only: ${marker}.`;
    normalTaskSubmissionAttempted=true;observingTarget=true;
    const started=await diagnostic.evaluate(`(async()=>{const p=globalThis.__courierCapabilityProbe;if(p?.sessionId!==${JSON.stringify(owner)})return false;
      const before=await globalThis.__wbInvoke('session:get',{},p.sessionId);if(before?.__wbError||before?.sessionId!==p.sessionId||before?.isProcessing!==false)return false;
      p.completedSteerStartCount=(before.eventHistory??[]).length;p.completedSteerResult=undefined;p.completedSteerFailed=false;
      try{p.completedSteerResult=await globalThis.__wbInvoke('session:sendMessage',{},p.sessionId,[{type:'text',text:${JSON.stringify(prompt)}}],
        {'codebuddy.ai/conversationRequestId':${JSON.stringify(run)},'codebuddy.ai/requestId':${JSON.stringify(run)},'codebuddy.ai':{requestId:${JSON.stringify(run)}}});}
      catch{p.completedSteerFailed=true;}return true;})()`,90000);
    if(started!==true)return finish({status:'target_not_started'});
    normalTaskSubmissions=1;
    const before=await observe();
    const state=record(before),events=Array.isArray(state['events'])?state['events']:[];
    const completionSnapshot={originalSession:state['sessionId']===owner,idle:state['isProcessing']===false,returned:state['returned']===true,
      failed:state['failed']===true,normalEnd:state['stopReason']==='end_turn',pendingClear:state['pendingQuestions']===0&&state['pendingPermissions']===0,
      rawFrames:events.length,desktopHistoryFrames:Array.isArray(state['history'])?state['history'].length:0,
      eventOwnersPresent:events.filter(event=>record(event)['sessionId']!==undefined).length,
      foreignEventOwners:events.filter(event=>record(event)['sessionId']!==undefined&&record(event)['sessionId']!==owner).length};
    if(!completedRunReady(before,owner,run,marker))return finish({status:'original_completion_unverified',completionSnapshot});
    trace.mark('task_return_observed',{processing:false,returned:true,stopReason:'end_turn'});
    // 原任务明确结束后仅派发一次旧 Run 控制；拒绝或未知均不回退到 prompt、队列或另一 Harness 会话。
    trace.mark('control_submit',{processing:false,returned:true});steerDispatches=1;
    const at=Date.now(),receipt=await steering.dispatch({operationId,inputId,sessionRef:owner,expectedRunRef:run,
      text:'Synthetic late supplement for the specified completed task only. Do not create a new task, run tools, read or write files, or contact the network.'}).receipt;
    const receiptMs=Date.now()-at;trace.mark('control_receipt',{status:receipt.status});
    let unchanged=true,observations=0,lastState:unknown;const observationAt=Date.now(),until=observationAt+5000;
    do {
      const after=await observe();lastState=after;observations++;
      if(!unchangedCompletedRun(before,after,owner,run,marker)){unchanged=false;break;}
      await new Promise(resolve=>setTimeout(resolve,200));
    }while(Date.now()<until);
    const observationMs=Date.now()-observationAt;
    const last=record(lastState);
    trace.mark('post_result_observation',{
      ...(typeof last['isProcessing']==='boolean'?{processing:last['isProcessing']}:{}),
      ...(typeof last['returned']==='boolean'?{returned:last['returned']}:{})});
    const rejected=receipt.status==='rejected'&&receipt.errorCode==='stale_run'&&receipt.definitelyNotAccepted===true&&
      (rawReason==='idle'||rawReason==='stale');
    return finish({status:'observed',originalCompletionObserved:true,completionSnapshot,receipt:{status:receipt.status,
      ...(receipt.status==='accepted'?{}:{code:receipt.errorCode}),definitelyNotAccepted:receipt.status==='rejected'&&receipt.definitelyNotAccepted===true},
      receiptMs,postControlObservationMs:observationMs,postControlObservations:observations,originalHistoryUnchanged:unchanged,
      completedRunRejectionObserved:rejected&&unchanged&&!applied&&!conflict&&!streamTruncated&&!trace.snapshot().truncated});
  }catch(error){return finish({status:'unavailable',code:safeCode(error)});}
  finally{await connection.close().catch(()=>{});}
}
