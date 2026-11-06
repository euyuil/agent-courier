import { randomUUID } from 'node:crypto';
import { AcpConnection } from '../../src/adapters/workbuddy-experimental/connection.js';
import { WorkBuddySteering } from '../../src/adapters/workbuddy-experimental/steer.js';
import { record,requestRef,internalFrame,metaField,newRequestRef } from '../../src/adapters/workbuddy-experimental/metadata.js';
import { safeCode } from '../../src/domain/errors.js';
import { ownRuntimeEndpoints,identifyOwnAcpTransport } from './workbuddy-acp.js';
import { WorkBuddyTrace } from './workbuddy-trace.js';
import { WorkBuddyRunReferences } from '../../src/adapters/workbuddy-experimental/run-references.js';
import type { Receipt } from '../../src/adapters/harness/port.js';

interface Diagnostic {evaluate(expression:string,timeout?:number):Promise<unknown>}
export function newMarkerMessageCount(before:unknown[],after:unknown[],marker:string,owner:string):number {
  if(!marker||!owner)return 0;
  const messages=(events:unknown[]):Map<string,string>|undefined=>{
    const result=new Map<string,string>();
    for(const raw of events) {
      const params=record(raw),update=record(params['update']),content=record(update['content']);
      if(params['sessionId']!==owner||internalFrame(params,update)||!['agent_message_chunk','assistant_message_chunk'].includes(String(update['sessionUpdate'])))continue;
      const id=metaField(update['_meta'],'messageId')??update['messageId'];
      if(typeof id!=='string'||!id||content['type']!=='text'||typeof content['text']!=='string'||
        (typeof update['messageId']==='string'&&update['messageId']!==id))continue;
      const text=(result.get(id)??'')+content['text'];if(text.length>65536)return undefined;
      result.set(id,text);
    }
    return result;
  };
  const prior=messages(before),later=messages(after);if(!prior||!later)return 0;
  return [...later].filter(([id,text])=>!prior.has(id)&&text.includes(marker)).length;
}
function echoSummary(events:unknown[],prompt:string,marker:string):Record<string,unknown> {
  const echoes=events.map(record).filter(event=>record(event['update'])['sessionUpdate']==='user_message_chunk');
  return {userFrames:echoes.length,examples:echoes.slice(0,4).map(event=>{
    const update=record(event['update']),content=record(update['content']),text=typeof content['text']==='string'?content['text']:'';
    const metas=[event['_meta'],update['_meta'],content['_meta']];
    return {textContent:content['type']==='text',exactBody:text===prompt,containsBody:text.includes(prompt),containsMarker:text.includes(marker),
      referencePresent:!!(requestRef(update)??requestRef(event)),internal:internalFrame(event,update),
      internalFlags:['isSubAgent','isTeamMember','parentSessionId','memberEvent','parentToolCallId','teamUpdate','isCompactInternal',
        'compactType','isSessionSeparator','rendererHistoryReplay','ownerSnapshotHistoryReplay','historyReplay'].flatMap(key=>
        metas.flatMap(meta=>{const value=metaField(meta,key);return value!==undefined&&value!==false?[{key,type:value===null?'null':typeof value,empty:value===''}]:[];}))};
  })};
}
function outputSummary(events:unknown[],runRef:string,marker:string,linkedEvents:Record<string,unknown>[]):Record<string,unknown> {
  const visible=events.map(record).filter(event=>{
    const update=record(event['update']);return !internalFrame(event,update)&&
      ['agent_message_chunk','assistant_message_chunk'].includes(String(update['sessionUpdate']));
  });
  const messages=new Map<string,string>(),promptMessages=new Map<string,string>(),linkedMessages=new Map<string,string>();
  let otherRun=false,unidentified=0,promptLinkedFrames=0;
  for(const event of linkedEvents) {
    const update=record(event['update']),content=record(update['content']);
    const id=metaField(update['_meta'],'messageId')??metaField(event['_meta'],'messageId')??update['messageId'];
    if(typeof id==='string'&&content['type']==='text'&&typeof content['text']==='string')
      linkedMessages.set(id,(linkedMessages.get(id)??'')+content['text']);
  }
  for(const event of visible) {
    const update=record(event['update']),ref=requestRef(update)??requestRef(event);
    const id=metaField(update['_meta'],'messageId')??metaField(event['_meta'],'messageId')??update['messageId'],content=record(update['content']);
    const prompt=metaField(update['_meta'],'promptRequestId')??metaField(event['_meta'],'promptRequestId');
    if(prompt===runRef&&typeof id==='string'&&content['type']==='text'&&typeof content['text']==='string') {
      promptLinkedFrames++;promptMessages.set(id,(promptMessages.get(id)??'')+content['text']);
    }
    if(ref&&ref!==runRef){otherRun=true;continue;}
    if(!ref){unidentified++;continue;}
    if(typeof id!=='string'){unidentified++;continue;}
    if(content['type']!=='text'||typeof content['text']!=='string')continue;
    messages.set(id,(messages.get(id)??'')+content['text']);
  }
  const unsolicited=events.map(record).filter(event=>record(event['update'])['sessionUpdate']==='session_info_update')
    .map(event=>record(metaField(record(event['update'])['_meta'],'unsolicitedTurn'))).filter(turn=>typeof turn['requestId']==='string');
  return {changedOutputInOriginalRun:[...messages.values()].some(text=>text.includes(marker)),otherRunObserved:otherRun,
    linkedChangedOutputInOriginalRun:[...linkedMessages.values()].some(text=>text.includes(marker)),unlinkedVisibleFrames:visible.length-linkedEvents.length,
    promptLinkedFrames,promptLinkedChangedOutput:[...promptMessages.values()].some(text=>text.includes(marker)),
    unsolicitedTurnFrames:unsolicited.length,backgroundDrainFrames:unsolicited.filter(turn=>turn['reason']==='background_drain').length,
    unidentifiedVisibleFrames:unidentified,visibleFrames:visible.length,lastFrameIdentity:visible.slice(-4).map(event=>{
      const update=record(event['update']),top=update['requestId'],conversation=metaField(update['_meta'],'conversationRequestId'),
        request=metaField(update['_meta'],'requestId'),prompt=metaField(update['_meta'],'promptRequestId');
      return {topPresent:typeof top==='string',topMatches:top===runRef,conversationPresent:typeof conversation==='string',
        conversationMatches:conversation===runRef,requestPresent:typeof request==='string',requestMatches:request===runRef,
        promptPresent:typeof prompt==='string',promptMatches:prompt===runRef,normalizedMatches:(requestRef(update)??requestRef(event))===runRef};
    })};
}
export function originalProbeRun(value:unknown,owner:string,expectedRef:string):string|undefined {
  const snapshot=record(value);
  if(!owner||!expectedRef||snapshot['sessionId']!==owner||snapshot['isProcessing']!==true||!Array.isArray(snapshot['events']))return undefined;
  for(const raw of snapshot['events']) {
    const event=record(raw),update=record(event['update']);
    if(internalFrame(event,update)||!['agent_message_chunk','agent_thought_chunk','tool_call'].includes(String(update['sessionUpdate'])))continue;
    if((requestRef(update)??requestRef(event))===expectedRef)return expectedRef;
  }
  return undefined;
}
export function slashRejectionObserved(evidence:{receipt:Receipt;rawSteered:boolean|undefined;dispatchedWhileProcessing:boolean;
  applied:boolean;ownerUnchanged:boolean;originalOutput:boolean;changedOutput:boolean;completedNormally:boolean;processing:boolean;
  toolCallFrames:number;integrity:boolean;conflict:boolean;truncated:boolean}):boolean {
  return evidence.receipt.status==='rejected'&&evidence.receipt.errorCode==='steer_rejected'&&evidence.receipt.definitelyNotAccepted===true&&
    evidence.rawSteered===false&&evidence.dispatchedWhileProcessing&&!evidence.applied&&evidence.ownerUnchanged&&evidence.originalOutput&&
    !evidence.changedOutput&&evidence.completedNormally&&!evidence.processing&&evidence.toolCallFrames===0&&evidence.integrity&&
    !evidence.conflict&&!evidence.truncated;
}
export function nearCompletionControlReady(value:unknown,owner:string,run:string,marker:string):boolean {
  const state=record(value);
  if(!owner||!run||!marker||state['sessionId']!==owner||state['isProcessing']!==true||state['returned']!==false||state['failed']!==false||
    state['pendingQuestions']!==0||state['pendingPermissions']!==0||state['terminalObserved']!==false||!Array.isArray(state['events']))return false;
  const messages=new Map<string,string>();
  for(const raw of state['events']) {
    const params=record(raw),update=record(params['update']),content=record(update['content']);
    if(params['sessionId']!==owner||internalFrame(params,update))continue;
    if(['tool_call','tool_call_update','tool_call_pending'].includes(String(update['sessionUpdate'])))return false;
    if(!['agent_message_chunk','assistant_message_chunk'].includes(String(update['sessionUpdate']))||
      (requestRef(update)??requestRef(params))!==run||metaField(update['_meta'],'conversationRequestId')!==run||
      metaField(update['_meta'],'requestId')!==run||metaField(update['_meta'],'messageRequestId')!==run)continue;
    const id=metaField(update['_meta'],'messageId')??update['messageId'];
    if(typeof id!=='string'||!id||content['type']!=='text'||typeof content['text']!=='string')continue;
    const text=(messages.get(id)??'')+content['text'];if(text.length>65536)return false;
    messages.set(id,text);
  }
  return [...messages.values()].some(text=>{
    const lines=text.split(/\r?\n/);
    return lines.length>=18&&lines.length<=20&&lines.slice(0,17).every((line,index)=>line.startsWith(`${String(index+1).padStart(2,'0')}. `))&&
      lines[17]!.startsWith(`18. ${marker}`);
  });
}
export function secondProbeControlReady(value:unknown,owner:string,nextOwner:string,originalRun:string,marker:string):boolean {
  const snapshot=record(value);
  if(!owner||!nextOwner||!originalRun||!marker||nextOwner===originalRun||snapshot['sessionId']!==owner||snapshot['isProcessing']!==true||
    snapshot['returned']!==false||snapshot['failed']!==false||snapshot['pendingPermissions']!==0||snapshot['pendingQuestions']!==0||!Array.isArray(snapshot['events']))return false;
  const messages=new Map<string,string>();
  for(const raw of snapshot['events']) {
    const event=record(raw),update=record(event['update']),content=record(update['content']),meta=update['_meta'];
    if(event['sessionId']!==owner||internalFrame(event,update)||!['agent_message_chunk','assistant_message_chunk'].includes(String(update['sessionUpdate']))||
      (requestRef(update)??requestRef(event))!==nextOwner||metaField(meta,'conversationRequestId')!==nextOwner||
      metaField(meta,'requestId')!==nextOwner||metaField(meta,'messageRequestId')!==originalRun)continue;
    const id=metaField(meta,'messageId')??update['messageId'];
    if(typeof id!=='string'||!id||content['type']!=='text'||typeof content['text']!=='string')continue;
    const text=(messages.get(id)??'')+content['text'];if(text.length>65536)return false;
    messages.set(id,text);
  }
  return [...messages.values()].some(text=>text.includes(marker));
}
export async function steerExperiment(diagnostic:Diagnostic,cwd:string,mode:1|2|'same-text'|'slash'|'near-completion'=1):Promise<Record<string,unknown>> {
  const controls=mode==='same-text'||mode==='near-completion'?2:typeof mode==='number'?mode:1;
  const owner=await diagnostic.evaluate(`(async()=>{const p=globalThis.__courierCapabilityProbe;if(typeof p?.sessionId!=='string')return;
    const s=await globalThis.__wbInvoke('session:get',{},p.sessionId);
    return !s?.__wbError&&s?.sessionId===p.sessionId&&s?.cwd===${JSON.stringify(cwd)}&&s?.isProcessing===false?p.sessionId:undefined;})()`);
  if(typeof owner!=='string')return {status:'original_owner_unverified'};
  const runtime=ownRuntimeEndpoints(cwd,'/proc',owner),identified=await identifyOwnAcpTransport(runtime.endpoints);
  if(!identified.endpoint)return {status:'endpoint_unverified',ownedRuntimes:runtime.runtimeCount,acpTransportMatches:identified.matches};
  const originalMarker=`CourierOriginal-${randomUUID()}`,changedMarker=`CourierSteered-${randomUUID()}`,preassignedRun=newRequestRef(),
    controlInput=randomUUID(),controlOperation=randomUUID(),secondMarker=`CourierSecond-${randomUUID()}`,
    secondControlInput=randomUUID(),secondControlOperation=randomUUID(),lateMarker=`CourierLateStage-${randomUUID()}`;
  const trace=new WorkBuddyTrace(owner,{run:preassignedRun,input:controlInput,operation:controlOperation},
    {original:mode==='near-completion'?lateMarker:originalMarker,changed:changedMarker},Date.now,mode==='near-completion'?5000:2000);
  const references=new WorkBuddyRunReferences(preassignedRun);
  let lateAnchorObserved=false,originalTerminalObserved=false,firstAppliedBeforeTerminal=false,secondAppliedBeforeTerminal=false;
  const directObservations=new Map<string,Promise<boolean>>();
  const finish=(result:Record<string,unknown>):Record<string,unknown>=>{
    const data=trace.snapshot();return {...result,
      ...(mode==='near-completion'&&!result['nearCompletion']?{nearCompletion:{lateAnchorObserved,originalTerminalObserved,plannedAnchorLine:18,plannedTotalLines:20,traceRowLimit:5000}}:{}),
      traceSummary:{events:data.rows.length,truncated:data.truncated},trace:data};
  };
  const connection=new AcpConnection({endpoint:identified.endpoint,timeoutMs:5000}),stored=new Map<string,unknown>();
  const call=connection.call.bind(connection);let rawSteerReason:string|undefined,rawSteered:boolean|undefined;
  connection.call=(method,params,id,timeout)=>{
    const result=call(method,params,id,timeout);
    if(method==='session/steer')void result.then(value=>{
      const result=record(value),reason=result['reason'];
      if(typeof result['steered']==='boolean')rawSteered=result['steered'];
      if(typeof reason==='string')rawSteerReason=['idle','stale'].includes(reason)?reason:'other';
    }).catch(()=>{});
    return result;
  };
  const streamEvents:Record<string,unknown>[]=[],linkedStreamEvents:Record<string,unknown>[]=[],linkedHistoryEvents:Record<string,unknown>[]=[];
  let applied=false,secondApplied=false,conflict=false,appliedSource:string|undefined,currentSource='acp',secondStreamBoundary:number|undefined,
    historyIntegrity=true,streamTruncated=false;
  const steering=new WorkBuddySteering(connection,{get:key=>stored.get(key),set:(key,value)=>{stored.set(key,value);}},
    (input,_evidence,transition)=>{
      if(input.inputId===secondControlInput){secondApplied=true;secondAppliedBeforeTerminal=!originalTerminalObserved;secondStreamBoundary=linkedStreamEvents.length;trace.mark('second_control_applied');}
      else {applied=true;firstAppliedBeforeTerminal=!originalTerminalObserved;appliedSource=currentSource;trace.mark('control_applied');}
      if(!references.advance(transition))conflict=true;
      if(mode==='near-completion')directObservations.set(input.inputId,diagnostic.evaluate(`(async()=>{const p=globalThis.__courierCapabilityProbe;
        if(p?.sessionId!==${JSON.stringify(owner)})return;const s=await globalThis.__wbInvoke('session:get',{},p.sessionId);
        if(s?.__wbError||s?.sessionId!==p.sessionId)return;
        return {processing:s.isProcessing===true,returned:p.steerResult!==undefined,failed:p.steerFailed===true};})()`)
        .then(value=>{const state=record(value);trace.mark('application_task_observed',{processing:state['processing']===true,returned:state['returned']===true});
          return state['processing']===true&&state['returned']===false&&state['failed']===false;}).catch(()=>false));
    },()=>{conflict=true;});
  const feed=(params:Record<string,unknown>,source:string)=>{
    const update=record(params['update']),ref=requestRef(update)??requestRef(params);
    if(params['sessionId']!==owner||!ref||internalFrame(params,update))return;
    currentSource=source;steering.consume(owner,ref,params);
  };
  connection.onMessage=message=>{
    if(message.method!=='session/update')return;
    const params=record(message.params);
    if(params['sessionId']===owner){if(streamEvents.length<10000)streamEvents.push(params);else streamTruncated=true;}
    trace.event('acp',params);
    if(mode==='near-completion'&&started&&params['sessionId']===owner&&!internalFrame(params,record(params['update']))&&
      record(params['update'])['sessionUpdate']==='session_end')originalTerminalObserved=true;
    feed(params,'acp');
    if(params['sessionId']===owner&&!internalFrame(params,record(params['update']))&&references.visibleOutput(params))linkedStreamEvents.push(params);
  };
  const prompt=mode==='near-completion'?
    'Do not use tools, read or write files, or contact the network. Write a final report on repeating decimals in exactly twenty numbered lines, '+
    'starting directly with "01. " and continuing through "20. ". Each line should contain about ten words. Do not add headings, blank lines or code fences. '+
    `Lines 01 through 17 should each state a mathematical fact. Line 18 must begin exactly "18. ${lateMarker}" and summarize those facts. `+
    `Line 19 should explain a limitation. Line 20 should conclude the report and end with exactly ${originalMarker}.`:
    'Do not use tools, read or write files, or contact the network. Internally check the first 300 digits of the repeating decimal 1/7. '+
    `Do not show calculations. When finished, reply only: ${originalMarker}.`;
  let started=false,startAttempted=false;
  try {
    await connection.connect();await connection.call('initialize',{protocolVersion:1,clientInfo:{name:'Agent Courier independent steer probe',version:'1'},clientCapabilities:{}});
    // 桌面继续持有原 Harness 会话写入权；本连接不 new/load/prompt，只发送明确关联原 Run 的控制请求。
    startAttempted=true;
    trace.mark('task_submit');
    const submitted=await diagnostic.evaluate(`(async()=>{const p=globalThis.__courierCapabilityProbe;if(p?.sessionId!==${JSON.stringify(owner)})return false;
      const s=await globalThis.__wbInvoke('session:get',{},p.sessionId);
      if(s?.__wbError||s?.sessionId!==p.sessionId||s?.isProcessing!==false)return false;
      p.steerStartCount=(s.eventHistory??[]).length;p.steerResult=undefined;p.steerFailed=false;p.steerResultAt=undefined;p.steerStartedAt=Date.now();
      p.steerPromise=globalThis.__wbInvoke('session:sendMessage',{},p.sessionId,[{type:'text',text:${JSON.stringify(prompt)}}],
        {'codebuddy.ai/conversationRequestId':${JSON.stringify(preassignedRun)},'codebuddy.ai/requestId':${JSON.stringify(preassignedRun)},
          'codebuddy.ai':{requestId:${JSON.stringify(preassignedRun)}}})
        .then(r=>{p.steerResult=r;p.steerResultAt=Date.now();}).catch(()=>{p.steerFailed=true;p.steerResultAt=Date.now();});return true;})()`);
    started=submitted===true;
    if(!started)return finish({status:'not_started'});
    const snapshotExpression=`(async()=>{const p=globalThis.__courierCapabilityProbe;if(p?.sessionId!==${JSON.stringify(owner)})return;
      const s=await globalThis.__wbInvoke('session:get',{},p.sessionId);if(s?.__wbError||s?.sessionId!==p.sessionId)return;
      return {sessionId:s.sessionId,isProcessing:s.isProcessing,events:(s.eventHistory??[]).slice(p.steerStartCount),
        pendingPermissions:(s.pendingPermissions??[]).length,pendingQuestions:(s.pendingQuestions??[]).length,
        returned:p.steerResult!==undefined,failed:p.steerFailed===true,stopReason:p.steerResult?.stopReason,
        resultElapsedMs:typeof p.steerResultAt==='number'?p.steerResultAt-p.steerStartedAt:undefined};})()`;
    let historySeen=0,resultObserved=false;
    const observeSnapshot=async()=>{
      const value=record(await diagnostic.evaluate(snapshotExpression));if(value['sessionId']!==owner)return value;
      const events=Array.isArray(value['events'])?value['events']:[];
      if(events.length<historySeen){historyIntegrity=false;trace.mark('history_reset');historySeen=0;}
      for(let index=historySeen;index<events.length;index++) {
        const event=record(events[index]);
        if(typeof event['sessionId']==='string'&&event['sessionId']!==owner){historyIntegrity=false;trace.mark('foreign_history_event');continue;}
        const params:Record<string,unknown>={...event,sessionId:owner};trace.event('desktop',params,index);feed(params,'desktop_history');
        if(!internalFrame(params,record(params['update']))&&references.visibleOutput(params))linkedHistoryEvents.push(params);
      }
      historySeen=events.length;
      if(!resultObserved&&(value['returned']===true||value['failed']===true)) {
        resultObserved=true;trace.mark('task_return_observed',{returned:value['returned']===true,processing:value['isProcessing']===true,
          resultElapsedMs:value['resultElapsedMs'],stopReason:value['stopReason']});
      }
      return value;
    };
    let runRef:string|undefined,snapshot:Record<string,unknown>={};
    const readyUntil=Date.now()+(mode==='near-completion'?90000:30000);
    while(Date.now()<readyUntil) {
      snapshot=await observeSnapshot();
      const events=Array.isArray(snapshot['events'])?snapshot['events']:[];
      runRef=mode==='near-completion'?
        nearCompletionControlReady({...snapshot,events:streamEvents,terminalObserved:originalTerminalObserved},owner,preassignedRun,lateMarker)?preassignedRun:undefined:
        originalProbeRun({...snapshot,events:[...events,...streamEvents]},owner,preassignedRun);
      if(runRef){
        if(mode==='near-completion'){lateAnchorObserved=true;trace.mark('late_output_anchor',{processing:true,returned:false});}
        else trace.mark('run_activity',{processing:true});
        break;
      }
      if(snapshot['returned']===true||snapshot['failed']===true)return finish({status:'finished_before_control',normalTaskSubmissions:1,steerDispatches:0,
        ownAcpFrames:streamEvents.length,historyFrames:events.length,acpEchoes:echoSummary(streamEvents,prompt,originalMarker),
        historyEchoes:echoSummary(events,prompt,originalMarker)});
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!runRef)return finish({status:'original_run_unverified',normalTaskSubmissions:1,steerDispatches:0});
    if(snapshot['pendingPermissions']!==0||snapshot['pendingQuestions']!==0)return finish({status:'unexpected_human_input',normalTaskSubmissions:1,steerDispatches:0,executionPermissionApprovals:0});
    const dispatchedWhileProcessing=snapshot['isProcessing']===true&&snapshot['returned']===false&&snapshot['failed']===false&&historyIntegrity;
    if((mode==='slash'||mode==='near-completion')&&(!dispatchedWhileProcessing||mode==='near-completion'&&originalTerminalObserved))
      return finish({status:'control_precondition_lost',normalTaskSubmissions:1,steerDispatches:0});
    trace.mark('control_submit',{processing:snapshot['isProcessing']===true,returned:snapshot['returned']===true});
    const firstChange=mode==='near-completion'?`For this same ongoing report, preserve the prior requirements and add exactly ${changedMarker} to the final closing line. `+
      'Do not start another task or use tools, files or network.':mode==='slash'?`/courier-synthetic-probe-${randomUUID()} ${changedMarker}`:controls===2?`Replace the requested output for this same ongoing task. Do not use tools, files or network. `+
      `Begin your visible reply with exactly ${changedMarker}. Then explain repeating decimals in ${mode==='same-text'?8:20} short sentences.`:
      `Replace the requested output for this same ongoing task. Do not use tools. Reply only: ${changedMarker}.`;
    const secondText=mode==='near-completion'?`For this same ongoing report, also add exactly ${secondMarker} to the final closing line. `+
      'Keep all earlier additional requirements. Do not start another task or use tools, files or network.':
      mode==='same-text'?firstChange:`Update this same ongoing task again. Do not use tools, files or network. Reply only: ${secondMarker}.`;
    const sentAt=Date.now(),receipt=await steering.dispatch({operationId:controlOperation,inputId:controlInput,sessionRef:owner,
      expectedRunRef:runRef,text:firstChange}).receipt;
    trace.mark('control_receipt',{status:receipt.status});
    const receiptMs=Date.now()-sentAt;let appliedWhileProcessing=false,secondAppliedWhileProcessing=false,toolFrames=0,
      secondAttempted=false,secondReceipt:Receipt|undefined,secondReceiptMs:number|undefined;
    if(mode==='near-completion'&&receipt.status==='accepted') {
      snapshot=await observeSnapshot();
      if(snapshot['sessionId']===owner&&snapshot['isProcessing']===true&&snapshot['returned']===false&&snapshot['failed']===false&&
        snapshot['pendingQuestions']===0&&snapshot['pendingPermissions']===0&&historyIntegrity&&!conflict&&!originalTerminalObserved) {
        secondAttempted=true;trace.mark('second_control_submit',{processing:true,returned:false});
        const secondAt=Date.now();secondReceipt=await steering.dispatch({operationId:secondControlOperation,inputId:secondControlInput,
          sessionRef:owner,expectedRunRef:runRef,text:secondText},references.ownerRef).receipt;
        secondReceiptMs=Date.now()-secondAt;trace.mark('second_control_receipt',{status:secondReceipt.status});
      }
    }
    const until=Date.now()+90000;
    while(Date.now()<until) {
      snapshot=await observeSnapshot();
      if(snapshot['sessionId']!==owner)return finish({status:'observation_unknown',normalTaskSubmissions:1,steerDispatches:secondAttempted?2:1,receipt:receipt.status});
      const events=Array.isArray(snapshot['events'])?snapshot['events']:[];toolFrames=0;
      for(const raw of events) {
        const event=record(raw),update=record(event['update']);
        if(internalFrame(event,update))continue;
        if(update['sessionUpdate']==='tool_call')toolFrames++;
      }
      if(applied&&snapshot['isProcessing']===true&&snapshot['returned']!==true)appliedWhileProcessing=true;
      if(secondApplied&&snapshot['isProcessing']===true&&snapshot['returned']!==true)secondAppliedWhileProcessing=true;
      if(snapshot['returned']===true||snapshot['failed']===true)break;
      if(mode!=='near-completion'&&controls===2&&!secondAttempted&&receipt.status==='accepted'&&applied&&!conflict&&toolFrames===0&&
        secondProbeControlReady({...snapshot,events:linkedStreamEvents},owner,references.ownerRef,runRef,changedMarker)) {
        secondAttempted=true;trace.mark('second_control_submit',{processing:true,returned:false});
        const secondAt=Date.now();secondReceipt=await steering.dispatch({operationId:secondControlOperation,inputId:secondControlInput,
          sessionRef:owner,expectedRunRef:runRef,text:secondText},references.ownerRef).receipt;
        secondReceiptMs=Date.now()-secondAt;trace.mark('second_control_receipt',{status:secondReceipt.status});
      }
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(snapshot['returned']===true) {
      // 原提交已有显式结果后，短暂只读观察迟到的控制帧，不用观察窗口替代任务终态。
      await new Promise(resolve=>setTimeout(resolve,300));snapshot=await observeSnapshot();
      trace.mark('post_result_observation',{processing:snapshot['isProcessing']===true,returned:snapshot['returned']===true});
    }
    const [firstDirect,secondDirect]=mode==='near-completion'?await Promise.all([
      directObservations.get(controlInput)??Promise.resolve(false),directObservations.get(secondControlInput)??Promise.resolve(false)]):[false,false];
    if(firstDirect)appliedWhileProcessing=true;if(secondDirect)secondAppliedWhileProcessing=true;
    const acpOutput=outputSummary(streamEvents,runRef,changedMarker,linkedStreamEvents),
      desktopOutput=outputSummary(Array.isArray(snapshot['events'])?snapshot['events']:[],runRef,changedMarker,linkedHistoryEvents);
    const originalRunContinuationObserved=historyIntegrity&&!streamTruncated&&!trace.snapshot().truncated&&receipt.status==='accepted'&&applied&&appliedWhileProcessing&&!conflict&&toolFrames===0&&
      acpOutput['linkedChangedOutputInOriginalRun']===true&&acpOutput['unlinkedVisibleFrames']===0&&
      desktopOutput['linkedChangedOutputInOriginalRun']===true&&snapshot['returned']===true&&
      snapshot['stopReason']==='end_turn'&&snapshot['isProcessing']===false;
    const targetMarker=mode==='same-text'?changedMarker:secondMarker;
    const secondAcpOutput=controls===2?outputSummary(streamEvents,runRef,targetMarker,linkedStreamEvents):undefined,
      secondDesktopOutput=controls===2?outputSummary(Array.isArray(snapshot['events'])?snapshot['events']:[],runRef,targetMarker,linkedHistoryEvents):undefined;
    const newMessagesAfterSecond=secondStreamBoundary===undefined?0:newMarkerMessageCount(linkedStreamEvents.slice(0,secondStreamBoundary),
      linkedStreamEvents.slice(secondStreamBoundary),targetMarker,owner);
    const acpMarkerMessages=newMarkerMessageCount([],linkedStreamEvents,targetMarker,owner),
      desktopMarkerMessages=newMarkerMessageCount([],linkedHistoryEvents,targetMarker,owner);
    const sameTextOutputObserved=mode==='same-text'&&firstChange===secondText&&controlInput!==secondControlInput&&
      newMessagesAfterSecond>0&&acpMarkerMessages>=2&&desktopMarkerMessages>=2;
    const bothControlsInOriginalRunObserved=controls===2&&originalRunContinuationObserved&&secondReceipt?.status==='accepted'&&secondApplied&&
      secondAppliedWhileProcessing&&secondAcpOutput?.['linkedChangedOutputInOriginalRun']===true&&secondDesktopOutput?.['linkedChangedOutputInOriginalRun']===true&&
      (mode!=='same-text'||sameTextOutputObserved)&&
      (mode!=='near-completion'||lateAnchorObserved&&firstDirect&&secondDirect&&firstAppliedBeforeTerminal&&secondAppliedBeforeTerminal&&originalTerminalObserved);
    const originalAcp=mode==='slash'?outputSummary(streamEvents,runRef,originalMarker,linkedStreamEvents):undefined,
      originalDesktop=mode==='slash'?outputSummary(Array.isArray(snapshot['events'])?snapshot['events']:[],runRef,originalMarker,linkedHistoryEvents):undefined;
    const slashRejected=mode==='slash'&&slashRejectionObserved({receipt,rawSteered,dispatchedWhileProcessing,applied,
      ownerUnchanged:references.ownerRef===preassignedRun,
      originalOutput:originalAcp?.['linkedChangedOutputInOriginalRun']===true&&originalDesktop?.['linkedChangedOutputInOriginalRun']===true&&
        originalAcp?.['unlinkedVisibleFrames']===0,
      changedOutput:acpOutput['linkedChangedOutputInOriginalRun']===true||desktopOutput['linkedChangedOutputInOriginalRun']===true,
      completedNormally:snapshot['returned']===true&&snapshot['failed']===false&&snapshot['stopReason']==='end_turn',
      processing:snapshot['isProcessing']!==false,toolCallFrames:toolFrames,integrity:historyIntegrity&&!streamTruncated,
      conflict,truncated:trace.snapshot().truncated});
    return finish({status:'observed',normalTaskSubmissions:1,steerDispatches:secondAttempted?2:1,sessionLoads:0,rawPromptCalls:0,receipt:receipt.status,
      ...(receipt.status!=='accepted'?{code:receipt.errorCode}:{}),receiptMs,elapsedMs:Date.now()-sentAt,
      ...(rawSteerReason?{rawSteerReason}:{}),
      appliedObserved:applied,appliedSource:appliedSource??'none',appliedWhileProcessingObserved:appliedWhileProcessing,
      acpOutput,desktopOutput,originalRunContinuationObserved,nativeOwnerTransitionObserved:references.ownerRef!==preassignedRun,
      ...(controls===2?{secondControl:{requested:secondAttempted,receipt:secondReceipt?.status??'not_requested',receiptMs:secondReceiptMs,
        appliedObserved:secondApplied,appliedWhileProcessingObserved:secondAppliedWhileProcessing,
        acpOutput:secondAcpOutput,desktopOutput:secondDesktopOutput},bothControlsInOriginalRunObserved}:{}),
      ...(mode==='same-text'?{sameTextInputs:{identicalBodies:firstChange===secondText,distinctInputIds:controlInput!==secondControlInput,
        newMarkerMessagesAfterSecond:newMessagesAfterSecond,acpMarkerMessages,desktopMarkerMessages,
        bothHandledObserved:bothControlsInOriginalRunObserved}}:{}),
      ...(mode==='slash'?{slashControl:{rawSteered:rawSteered??null,rawReason:rawSteerReason??'not_provided',
        dispatchedWhileOriginalProcessing:dispatchedWhileProcessing,originalAcp,originalDesktop,slashRejectionObserved:slashRejected}}:{}),
      ...(mode==='near-completion'?{nearCompletion:{plannedAnchorLine:18,plannedTotalLines:20,traceRowLimit:5000,lateAnchorObserved,originalTerminalObserved,
        firstAppliedBeforeTerminal,secondAppliedBeforeTerminal,firstDirectPendingObserved:firstDirect,secondDirectPendingObserved:secondDirect,
        bothInputsInOriginalRunObserved:bothControlsInOriginalRunObserved}}:{}),
      historyIntegrity,streamTruncated,
      protocolConflict:conflict,toolCallFrames:toolFrames,
      completedNormally:snapshot['stopReason']==='end_turn',isProcessing:snapshot['isProcessing']===true,
      executionPermissionApprovals:0});
  }catch(error){return finish({status:'unavailable',code:safeCode(error),taskSubmission:started?'submitted':startAttempted?'unknown':'not_requested'});}
  finally{await connection.close().catch(()=>{});}
}
