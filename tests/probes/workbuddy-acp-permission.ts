import { randomUUID } from 'node:crypto';
import type { HarnessPort,Receipt } from '../../src/adapters/harness/port.js';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';
import type { AcpConnection,RpcMessage } from '../../src/adapters/workbuddy-experimental/connection.js';
import { interaction } from '../../src/adapters/workbuddy-experimental/interaction.js';
import { record,string,metaField } from '../../src/adapters/workbuddy-experimental/metadata.js';
import { observedInteraction } from './workbuddy-interaction.js';
import { prepareObservedDenial } from './workbuddy-permission.js';

const receiptSummary=(receipt:Receipt)=>receipt.status==='accepted'?{status:receipt.status}:{status:receipt.status,code:receipt.errorCode};
const terminal=(event:HarnessEvent)=>['run.completed','run.failed','connection.lost'].includes(event.eventType);

export function prepareOwnedDenial(messages:RpcMessage[],request:HarnessEvent,sessionRef:string,runRef:string,command:string):
  {toolCallId:string;optionCode:string;sourceCount:number}|undefined {
  if(request.sessionRef!==sessionRef||request.runRef!==runRef||request.eventType!=='input.requested'||request.payload.kind!=='permission')return undefined;
  const candidate=messages.map(message=>interaction(message,sessionRef,runRef,'owned-denial-probe'))
    .find(mapping=>mapping?.vendorRequestId===request.payload.vendorRequestId);
  if(!candidate)return undefined;
  const snapshot={sessionRef,toolCallId:candidate.toolCallId,messages,toolUpdates:messages.flatMap(message=>{
    const params=record(message.params);
    return message.method==='session/update'&&params['sessionId']===sessionRef?[params['update']]:[];
  })};
  const observed=observedInteraction(snapshot,'permission','Bash'),prepared=prepareObservedDenial(snapshot,command);
  if(!observed||!prepared||observed.mapping.runRef!==runRef||observed.mapping.vendorRequestId!==request.payload.vendorRequestId)return undefined;
  const option=observed.mapping.options?.find(option=>option.decision==='deny'&&observed.mapping.wireOptions[option.code]==='deny'&&
    request.payload.options?.some(visible=>visible.code===option.code&&visible.decision==='deny'));
  return option?{toolCallId:observed.mapping.toolCallId,optionCode:option.code,sourceCount:prepared.sourceCount}:undefined;
}

export function deniedToolObserved(messages:RpcMessage[],sessionRef:string,toolCallId:string):boolean {
  const updates=messages.filter(message=>message.method==='session/update'&&record(message.params)['sessionId']===sessionRef)
    .map(message=>record(record(message.params)['update'])).filter(update=>update['sessionUpdate']==='tool_call_update'&&update['toolCallId']===toolCallId);
  return !updates.some(update=>update['status']==='completed')&&updates.some(update=>update['status']==='cancelled'&&
    metaField(update['_meta'],'toolCancelReason')==='permission_denied');
}

export async function acpPermissionDenialExperiment(adapter:Pick<HarnessPort,'start'|'answer'|'subscribe'>,
  connection:Pick<AcpConnection,'call'|'onMessage'>,sessionRef:string,timeoutMs=90000):Promise<Record<string,unknown>> {
  const marker=`CourierPermission-${randomUUID()}`,command=`python3 -I -S -c "print('${marker}')"`;
  const events:HarnessEvent[]=[],messages:RpcMessage[]=[];let overflow=false,wake:(()=>void)|undefined;
  const previous=connection.onMessage,previousCall=connection.call,deadline=Date.now()+timeoutMs,rawResults=new Map<string,Record<string,unknown>>();
  const capture=(message:RpcMessage)=>{if(messages.length<2048)messages.push(message);else overflow=true;previous(message);wake?.();};
  // RPC responses settle call promises; onMessage only receives server requests and notifications.
  const captureCall:AcpConnection['call']=(method,params,id,timeout)=>{
    const result=previousCall.call(connection,method,params,id,timeout);
    if(method==='session/prompt'&&id)void result.then(value=>{rawResults.set(id,record(value));wake?.();}).catch(()=>{wake?.();});
    return result;
  };
  connection.call=captureCall;
  connection.onMessage=capture;
  const unsubscribe=adapter.subscribe(sessionRef,event=>{if(events.length<2048)events.push(event);else overflow=true;wake?.();});
  const waitFor=async<T>(condition:()=>T|undefined):Promise<T|undefined>=>{
    while(!overflow&&Date.now()<deadline) {
      const value=condition();if(value!==undefined)return value;
      let timer:NodeJS.Timeout|undefined;
      try{await new Promise<void>(resolve=>{wake=resolve;timer=setTimeout(resolve,Math.max(1,deadline-Date.now()));});}
      finally{if(timer)clearTimeout(timer);wake=undefined;}
    }
    return undefined;
  };
  const report:Record<string,unknown>={status:'unverified',executionPermissionApprovals:0,denialCalls:0};
  try {
    const mode=record(await connection.call('session/set_config_option',{sessionId:sessionRef,configId:'mode',value:'default'},randomUUID()));
    report['defaultModeConfirmed']=Array.isArray(mode['configOptions'])&&mode['configOptions'].some(raw=>{
      const option=record(raw);return option['id']==='mode'&&option['currentValue']==='default';
    });
    if(report['defaultModeConfirmed']!==true)return report;
    const startOperationId=randomUUID(),started=await adapter.start({sessionRef,operationId:startOperationId,inputId:randomUUID(),clientRunId:randomUUID(),
      text:`Call the Bash tool exactly once with this harmless command: ${command}. `+
        'Use the tool instead of asking for permission in plain text or with AskUserQuestion. '+
        'Do not use any other tool, read or write files, contact the network, or change the command. '+
        'If it is denied, do not retry or run a substitute; reply only: Agent Courier permission denied.'}).receipt;
    report['start']=receiptSummary(started);
    if(started.status!=='accepted'||started.sessionRef!==sessionRef||!started.runRef)return report;
    const own=(event:HarnessEvent)=>event.sessionRef===sessionRef&&event.runRef===started.runRef;
    const first=await waitFor(()=>events.find(event=>own(event)&&(event.eventType==='input.requested'||terminal(event))));
    report['firstEvent']=first?.eventType??'not_observed';
    if(first?.eventType!=='input.requested'||first.payload.kind!=='permission')return report;
    const prepared=await waitFor(()=>{
      if(events.some(event=>own(event)&&(terminal(event)||event.eventType==='input.invalidated'&&
        event.payload.vendorRequestId===first.payload.vendorRequestId)))return false;
      return prepareOwnedDenial(messages,first,sessionRef,started.runRef!,command);
    });
    if(!prepared||overflow)return report;
    const operationId=randomUUID(),inputId=randomUUID(),cursor=messages.length;report['denialCalls']=1;
    const denied=await adapter.answer({sessionRef,runRef:started.runRef,vendorRequestId:first.payload.vendorRequestId,operationId,inputId,
      answer:{kind:'permission',decision:'deny',optionCode:prepared.optionCode}}).receipt;
    report['denial']=receiptSummary(denied);report['mappedSources']=prepared.sourceCount;
    if(denied.status!=='accepted'||denied.sessionRef!==sessionRef||denied.runRef!==started.runRef||denied.vendorRequestId!==first.payload.vendorRequestId)return report;
    const end=await waitFor(()=>events.find(event=>own(event)&&terminal(event)));
    report['completion']=end?.eventType??'not_observed';
    const rawStop=await waitFor(()=>end?.eventType==='connection.lost'?false:string(rawResults.get(startOperationId)?.['stopReason']));
    report['rawStopReason']=rawStop&&['cancelled','end_turn','refusal','failed'].includes(rawStop)?rawStop:'not_observed';
    report['denialAcceptedEvent']=events.some(event=>own(event)&&event.eventType==='input.accepted'&&
      event.payload.operationId===operationId&&event.payload.inputId===inputId);
    report['nativeToolCancellationMarkerObserved']=deniedToolObserved(messages.slice(cursor),sessionRef,prepared.toolCallId);
    report['toolUpdateStates']=[...new Set(messages.slice(cursor).filter(message=>message.method==='session/update'&&record(message.params)['sessionId']===sessionRef)
      .map(message=>record(record(message.params)['update'])).filter(update=>update['toolCallId']===prepared.toolCallId&&update['sessionUpdate']==='tool_call_update')
      .map(update=>['pending','in_progress','completed','failed','cancelled'].includes(String(update['status']))?update['status']:'other'))];
    report['promptReportsPermissionDenial']=string(rawResults.get(startOperationId)?.['errorMessage'])==='Permission denied for tool(s): Bash';
    report['additionalToolCallObserved']=messages.some(message=>{
      const params=record(message.params),update=record(params['update']);
      return message.method==='session/update'&&params['sessionId']===sessionRef&&update['sessionUpdate']==='tool_call'&&
        typeof update['toolCallId']==='string'&&update['toolCallId']!==prepared.toolCallId;
    });
    // Native resolveInterruption rejects the original item and cancels its Run.
    // The separate interrupt_result path may emit a tool marker; neither path is invented for the other.
    report['denialAndRunCancellationObserved']=rawStop==='cancelled'&&end?.eventType==='run.failed'&&report['denialAcceptedEvent']===true;
    const toolStates=report['toolUpdateStates'] as string[];
    if(!overflow&&report['additionalToolCallObserved']===false&&!toolStates.includes('completed')&&report['denialAcceptedEvent']===true&&
      (report['denialAndRunCancellationObserved']===true||rawStop==='end_turn'&&end?.eventType==='run.completed'&&
        report['nativeToolCancellationMarkerObserved']===true))report['status']='observed';
    return report;
  }catch{return {...report,status:'unknown'};}
  finally{unsubscribe();if(connection.onMessage===capture)connection.onMessage=previous;if(connection.call===captureCall)connection.call=previousCall;}
}
