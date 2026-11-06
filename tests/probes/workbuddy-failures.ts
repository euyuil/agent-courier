import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { AcpConnection } from '../../src/adapters/workbuddy-experimental/connection.js';
import { WorkBuddySteering } from '../../src/adapters/workbuddy-experimental/steer.js';
import { record,requestRef,internalFrame,newRequestRef } from '../../src/adapters/workbuddy-experimental/metadata.js';
import { CourierError,safeCode } from '../../src/domain/errors.js';
import { openDatabase,type Connection } from '../../src/storage/database.js';
import { migrate } from '../../src/storage/migrate.js';
import { adapterMappings } from '../../src/storage/adapter-mappings.js';
import type { Receipt,SteerInput } from '../../src/adapters/harness/port.js';
import { ownRuntimeEndpoints,identifyOwnAcpTransport } from './workbuddy-acp.js';
import { originalProbeRun } from './workbuddy-steer.js';
import { WorkBuddyTrace } from './workbuddy-trace.js';

interface Diagnostic {evaluate(expression:string,timeout?:number):Promise<unknown>}
export function failureControlReady(value:unknown,owner:string,run:string):boolean {
  const state=record(value);
  if(state['returned']!==false||state['failed']!==false||state['pendingQuestions']!==0||state['pendingPermissions']!==0||
    state['terminalObserved']!==false||!Array.isArray(state['events']))return false;
  const ownEvents=state['events'].filter(event=>record(event)['sessionId']===owner);
  if(originalProbeRun({...state,events:ownEvents},owner,run)!==run)return false;
  return !state['events'].some(raw=>{
    const params=record(raw),update=record(params['update']);
    return params['sessionId']===owner&&!internalFrame(params,update)&&['tool_call','tool_call_update','tool_call_pending'].includes(String(update['sessionUpdate']));
  });
}
export function disconnectingSteerRequest(request:typeof fetch,operationId:string,disconnect:()=>void,onSteerPost:()=>void):typeof fetch {
  let fired=false;
  return (async(input,init)=>{
    let message:Record<string,unknown>={};
    if(init?.method==='POST'&&typeof init.body==='string')try{message=record(JSON.parse(init.body));}catch{/* 其他传输内容照常交给原请求函数。 */}
    const steer=message['method']==='session/steer',target=steer&&message['id']===operationId;
    if(target&&fired)throw new CourierError('state_unknown');
    const pending=request(input,init);
    if(steer)onSteerPost();
    // 先启动真实请求，再关闭本连接；不等待或伪造服务器回执，也不据此断言服务器已接收。
    if(target){fired=true;disconnect();}
    return await pending;
  }) as typeof fetch;
}
const summarize=(receipt:Receipt)=>({status:receipt.status,...(receipt.status==='accepted'?{}:{code:receipt.errorCode}),
  ...(receipt.status==='rejected'?{definitelyNotAccepted:receipt.definitelyNotAccepted===true}:{})});

export async function failureBoundariesExperiment(diagnostic:Diagnostic,cwd:string):Promise<Record<string,unknown>> {
  const owner=await diagnostic.evaluate(`(async()=>{const p=globalThis.__courierCapabilityProbe;if(typeof p?.sessionId!=='string')return;
    const s=await globalThis.__wbInvoke('session:get',{},p.sessionId);
    return !s?.__wbError&&s?.sessionId===p.sessionId&&s?.cwd===${JSON.stringify(cwd)}&&s?.isProcessing===false?p.sessionId:undefined;})()`);
  if(typeof owner!=='string')return {status:'original_owner_unverified'};
  const runtime=ownRuntimeEndpoints(cwd,'/proc',owner),identified=await identifyOwnAcpTransport(runtime.endpoints);
  if(!identified.endpoint)return {status:'endpoint_unverified'};
  const run=newRequestRef(),faultInput:SteerInput={operationId:randomUUID(),inputId:randomUUID(),sessionRef:owner,expectedRunRef:run,
    text:'Additional requirement for this same ongoing report: conclude with a reminder to distinguish rounded approximations from exact values. Do not use tools, files or network.'};
  let staleRef=newRequestRef();while(staleRef===run)staleRef=newRequestRef();
  const staleInput:SteerInput={operationId:randomUUID(),inputId:randomUUID(),sessionRef:owner,expectedRunRef:staleRef,
    text:'Synthetic mismatched-Run control. Do not start another task or use tools, files or network.'};
  const trace=new WorkBuddyTrace(owner,{run,input:faultInput.inputId,operation:faultInput.operationId},{original:'',changed:''},Date.now,5000);
  let db:Connection|undefined,stateDirectory:string|undefined,closing:Promise<void>|undefined,connection!:AcpConnection;
  let rpcCalls=0,postAttempts=0,faultInjected=false,connectionLost=false,closeFailed=false,staleReason='not_observed',
    applied=false,conflict=false,seen=0,integrity=true,terminal=false,normalTaskSubmissions=0,normalSubmissionAttempted=false,
    staleRequested=false,faultRequested=false;
  const rawEvents:Record<string,unknown>[]=[];
  const request=disconnectingSteerRequest(fetch,faultInput.operationId,()=>{
    faultInjected=true;trace.mark('control_transport_closed');closing=connection.close().catch(()=>{closeFailed=true;});
  },()=>{postAttempts++;});
  connection=new AcpConnection({endpoint:identified.endpoint,timeoutMs:5000,request});
  connection.onLost=()=>{connectionLost=true;};
  const call=connection.call.bind(connection);
  connection.call=(method,params,id,timeout)=>{
    if(method==='session/steer')rpcCalls++;
    const pending=call(method,params,id,timeout);
    if(method==='session/steer'&&id===staleInput.operationId)void pending.then(value=>{
      const reason=record(value)['reason'];staleReason=reason==='stale'||reason==='idle'?reason:'other';
    }).catch(()=>{});
    return pending;
  };
  const steeringForStore=()=>new WorkBuddySteering(connection,adapterMappings(db!,'independent-failure-probe'),
    ()=>{applied=true;trace.mark('control_applied');},()=>{conflict=true;});
  let steering:WorkBuddySteering|undefined;
  connection.onMessage=message=>{
    if(message.method!=='session/update')return;
    const params=record(message.params),update=record(params['update']);trace.event('acp',params);
    if(params['sessionId']!==owner||internalFrame(params,update))return;
    if(rawEvents.length<10000)rawEvents.push(params);else integrity=false;
    const ref=requestRef(update)??requestRef(params);
    if(update['sessionUpdate']==='session_end'&&ref===run)terminal=true;
    if(ref)steering?.consume(owner,ref,params);
  };
  const finish=(result:Record<string,unknown>)=>{
    const data=trace.snapshot();return {...result,normalTaskSubmissions,normalSubmissionAttempted,staleRequested,faultRequested,
      controlRpcCalls:rpcCalls,realSteerPostAttempts:postAttempts,staleReason,transportFaultInjected:faultInjected,connectionLost,
      appliedObserved:applied,protocolConflict:conflict,historyIntegrity:integrity,cleanupFailureObserved:closeFailed,
      executionPermissionApprovals:0,sessionLoads:0,rawPromptCalls:0,traceSummary:{events:data.rows.length,truncated:data.truncated},trace:data};
  };
  const expression=`(async()=>{const p=globalThis.__courierCapabilityProbe;if(p?.sessionId!==${JSON.stringify(owner)})return;
    const s=await globalThis.__wbInvoke('session:get',{},p.sessionId);if(s?.__wbError||s?.sessionId!==p.sessionId||s?.cwd!==${JSON.stringify(cwd)})return;
    return {sessionId:s.sessionId,isProcessing:s.isProcessing===true,returned:p.failureResult!==undefined,failed:p.failureFailed===true,
      stopReason:p.failureResult?.stopReason,pendingQuestions:(s.pendingQuestions??[]).length,pendingPermissions:(s.pendingPermissions??[]).length,
      events:(s.eventHistory??[]).slice(p.failureStartCount)};})()`;
  const observe=async()=>{
    const state=record(await diagnostic.evaluate(expression));if(state['sessionId']!==owner){integrity=false;return state;}
    const events=Array.isArray(state['events'])?state['events']:[];
    if(events.length<seen){integrity=false;trace.mark('history_reset');}
    for(let index=seen;index<events.length;index++) {
      const event=record(events[index]);
      if(event['sessionId']!==undefined&&event['sessionId']!==owner){integrity=false;trace.mark('foreign_history_event');continue;}
      trace.event('desktop',{...event,sessionId:owner},index);
    }
    seen=events.length;return state;
  };
  const ready=(state:Record<string,unknown>)=>integrity&&!conflict&&!applied&&connection.connected&&
    failureControlReady({...state,events:rawEvents,terminalObserved:terminal},owner,run);
  try {
    stateDirectory=mkdtempSync(join(dirname(cwd),'failure-state-'));const databasePath=join(stateDirectory,'operations.sqlite');
    db=openDatabase(databasePath);migrate(db);steering=steeringForStore();
    await connection.connect();await connection.call('initialize',{protocolVersion:1,clientInfo:{name:'Agent Courier failure-boundary probe',version:'1'},clientCapabilities:{}});
    trace.mark('task_submit');normalSubmissionAttempted=true;
    const prompt='Do not use tools, read or write files, or contact the network. Explain repeating decimals in twenty numbered lines, each about ten words. End with a short conclusion.';
    const submitted=await diagnostic.evaluate(`(async()=>{const p=globalThis.__courierCapabilityProbe;if(p?.sessionId!==${JSON.stringify(owner)})return false;
      const s=await globalThis.__wbInvoke('session:get',{},p.sessionId);if(s?.__wbError||s?.sessionId!==p.sessionId||s?.isProcessing!==false)return false;
      p.failureStartCount=(s.eventHistory??[]).length;p.failureResult=undefined;p.failureFailed=false;
      p.failurePromise=globalThis.__wbInvoke('session:sendMessage',{},p.sessionId,[{type:'text',text:${JSON.stringify(prompt)}}],
        {'codebuddy.ai/conversationRequestId':${JSON.stringify(run)},'codebuddy.ai/requestId':${JSON.stringify(run)},'codebuddy.ai':{requestId:${JSON.stringify(run)}}})
        .then(r=>{p.failureResult=r;}).catch(()=>{p.failureFailed=true;});return true;})()`);
    if(submitted!==true)return finish({status:'target_not_started'});normalTaskSubmissions=1;
    let state:Record<string,unknown>={};const readyUntil=Date.now()+30000;
    do {state=await observe();if(ready(state))break;
      if(state['returned']===true||state['failed']===true)return finish({status:'finished_before_control'});
      await new Promise(resolve=>setTimeout(resolve,100));
    }while(Date.now()<readyUntil);
    if(!ready(state))return finish({status:'original_run_unverified'});
    staleRequested=true;trace.mark('control_submit',{processing:true,returned:false});
    const staleAt=Date.now(),staleReceipt=await steering.dispatch(staleInput).receipt,staleReceiptMs=Date.now()-staleAt;
    trace.mark('control_receipt',{status:staleReceipt.status});
    const staleObserved=staleReason==='stale'&&staleReceipt.status==='rejected'&&staleReceipt.errorCode==='stale_run'&&staleReceipt.definitelyNotAccepted===true;
    if(!staleObserved)return finish({status:'stale_rejection_unverified',staleReceipt:summarize(staleReceipt),staleReceiptMs});
    state=await observe();if(!ready(state))return finish({status:'finished_before_transport_fault',staleReceipt:summarize(staleReceipt),staleReceiptMs});
    faultRequested=true;trace.mark('second_control_submit',{processing:true,returned:false});
    const faultAt=Date.now(),faultHandle=steering.dispatch(faultInput),faultReceipt=await faultHandle.receipt,faultReceiptMs=Date.now()-faultAt;
    trace.mark('second_control_receipt',{status:faultReceipt.status});await closing;
    if(!faultInjected||!connectionLost||connection.connected||faultReceipt.status!=='unknown'||faultReceipt.errorCode!=='state_unknown')
      return finish({status:'transport_fault_unverified',staleReceipt:summarize(staleReceipt),faultReceipt:summarize(faultReceipt)});
    const beforeRepeat=rpcCalls,postsBeforeRepeat=postAttempts,repeat=steering.dispatch(faultInput),repeatReceipt=await repeat.receipt;
    const sameReceiptPromise=repeat.receipt===faultHandle.receipt;
    const storedBefore=adapterMappings(db,'independent-failure-probe').get(`steer:${faultInput.operationId}`);
    db.close();db=undefined;db=openDatabase(databasePath);migrate(db);trace.mark('store_reopened');
    const storedAfter=adapterMappings(db,'independent-failure-probe').get(`steer:${faultInput.operationId}`),restored=steeringForStore();
    const restoredReceipt=await restored.dispatch(faultInput).receipt;
    const noExtraCalls=rpcCalls===beforeRepeat&&postAttempts===postsBeforeRepeat;
    const survived=JSON.stringify(storedBefore)===JSON.stringify(storedAfter)&&record(storedAfter)['status']==='unknown'&&
      JSON.stringify(record(storedAfter)['input'])===JSON.stringify(faultInput);
    trace.mark('duplicate_suppressed',{status:restoredReceipt.status});
    const finishUntil=Date.now()+90000;
    do {state=await observe();if(state['returned']===true||state['failed']===true)break;
      if(state['pendingQuestions']!==0||state['pendingPermissions']!==0)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }while(Date.now()<finishUntil);
    const events=Array.isArray(state['events'])?state['events']:[],toolFrames=events.filter(raw=>{
      const event=record(raw),update=record(event['update']);return !internalFrame(event,update)&&update['sessionUpdate']==='tool_call';
    }).length;
    const completed=state['returned']===true&&state['failed']===false&&state['stopReason']==='end_turn'&&state['isProcessing']===false;
    trace.mark('task_return_observed',{returned:state['returned']===true,processing:state['isProcessing']===true,stopReason:state['stopReason']});
    const unknownObserved=faultReceipt.status==='unknown'&&faultReceipt.errorCode==='state_unknown'&&repeatReceipt.status==='unknown'&&
      restoredReceipt.status==='unknown'&&restoredReceipt.errorCode==='state_unknown';
    return finish({status:'observed',staleReceipt:summarize(staleReceipt),staleReceiptMs,staleRejectionObserved:staleObserved,
      faultReceipt:summarize(faultReceipt),faultReceiptMs,duplicateReceipt:summarize(repeatReceipt),restoredReceipt:summarize(restoredReceipt),
      sameReceiptPromise,storedIntentSurvivedReopen:survived,noAdditionalRpcOrPost:noExtraCalls,completedNormally:completed,
      isProcessing:state['isProcessing']===true,toolCallFrames:toolFrames,upstreamAcceptanceAtDisconnect:'unknown',
      faultMode:'own_connection_closed_after_fetch_start',reopenScope:'same_process_database_and_adapter_reconstruction',
      failureBoundariesObserved:staleObserved&&unknownObserved&&sameReceiptPromise&&survived&&noExtraCalls&&rpcCalls===2&&postAttempts===2&&
        faultInjected&&connectionLost&&!closeFailed&&!applied&&!conflict&&integrity&&!trace.snapshot().truncated&&completed&&toolFrames===0&&
        state['pendingQuestions']===0&&state['pendingPermissions']===0});
  }catch(error){return finish({status:'unavailable',code:safeCode(error)});}
  finally{
    await closing;await connection.close().catch(()=>{});db?.close();
    if(stateDirectory)rmSync(stateDirectory,{recursive:true,force:true});
  }
}
