import { randomUUID } from 'node:crypto';
import { summarizeFormatterObservation,type FormatterObservation } from './workbuddy-formatter.js';
import type { HarnessPort,Receipt } from '../../src/adapters/harness/port.js';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';
import type { AcpConnection,RpcMessage } from '../../src/adapters/workbuddy-experimental/connection.js';
import { record,string,metaField,internalFrame,requestRef } from '../../src/adapters/workbuddy-experimental/metadata.js';
import { formatterFullToolName,formatterInputSchema,decodeFormatterResult } from '../../src/adapters/workbuddy-experimental/formatter.js';

export interface FormatterControl {
  operationId:string;inputId:string;text:string;pendingAtDispatch:boolean;eventCursor:number;rawCursor?:number;
  receipt?:Receipt;rawParams?:unknown;rawResult?:unknown;
}
export interface SteeredFormatterObservation extends FormatterObservation {
  controls:FormatterControl[];markers:string[];
}
// 只输出到达次序、受控标记的匹配布尔值和有界计数；
// 原生参数帧的到达不证明模型内部生成参数的时点。
function timeline(input:SteeredFormatterObservation,owners:ReadonlyMap<string,number>,injections:ReadonlyMap<string,number>):Record<string,unknown> {
  const tools=new Map<string,{first:number;completed?:number}>(),visible=new Map<string,string>(),names=new Map<string,string>();
  let complete=input.traceComplete,unboundVisibleFrames=0;
  for(const [index,message] of input.messages.entries()) {
    const params=record(message.params),update=record(params['update']),kind=update['sessionUpdate'];
    if(message.method!=='session/update'||params['sessionId']!==input.sessionRef||internalFrame(params,update))continue;
    const ref=requestRef(update)??requestRef(params),proof=ref?owners.get(ref):undefined;
    const owned=ref===input.runRef||proof!==undefined&&proof<index&&metaField(update['_meta'],'messageRequestId')===input.runRef;
    const references=[update['requestId'],metaField(update['_meta'],'conversationRequestId'),metaField(update['_meta'],'requestId')];
    const consistent=references.every(value=>typeof value!=='string'||value===ref)||metaField(update['_meta'],'messageRequestId')===input.runRef&&
      references.every(value=>{if(typeof value!=='string'||value===input.runRef)return true;const proof=owners.get(value);return proof!==undefined&&proof<index;});
    if(kind==='agent_message_chunk'||kind==='assistant_message_chunk') {
      if(!owned||!consistent){unboundVisibleFrames++;continue;}
      const id=string(update['messageId'])??string(metaField(update['_meta'],'messageId')),content=record(update['content']);
      if(!id||content['type']!=='text'||typeof content['text']!=='string')continue;
      if(!visible.has(id)&&visible.size>=128){complete=false;continue;}
      const text=(visible.get(id)??'')+content['text'];
      if(text.length>65536){complete=false;continue;}visible.set(id,text);
    }
    if(!owned||!consistent||!['tool_call','tool_call_update'].includes(String(kind)))continue;
    const id=string(update['toolCallId']);if(!id)continue;
    const name=string(metaField(update['_meta'],'toolName'));if(name)names.set(id,name);
    if(names.get(id)!==formatterFullToolName)continue;
    const parsed=formatterInputSchema.safeParse(update['rawInput']);
    if(parsed.success&&parsed.data.kind==='final'&&!tools.has(id)) {
      if(tools.size>=32){complete=false;continue;}tools.set(id,{first:index});
    }
    const tool=tools.get(id);
    if(tool&&update['status']==='completed'&&decodeFormatterResult(update['rawOutput'])?.kind==='final')tool.completed??=index;
  }
  const before=(index:number|undefined,limit:number|undefined)=>index!==undefined&&limit!==undefined?index<limit:null;
  return {diagnosticComplete:complete,nativeFinalTiming:[...tools.values()].map(tool=>({
    beforeDispatch:input.controls.map(control=>before(tool.first,control.rawCursor)),
    beforeInjection:input.controls.map(control=>before(tool.first,injections.get(control.inputId))),
    completedBeforeDispatch:input.controls.map(control=>before(tool.completed,control.rawCursor)),
    completedBeforeInjection:input.controls.map(control=>before(tool.completed,injections.get(control.inputId)))})),
    ordinaryVisiblePartMatches:[...visible.values()].map(text=>[input.finalText,...input.markers].map(part=>text.includes(part))),
    ordinaryVisibleUnboundFrames:unboundVisibleFrames};
}
export function proveSteerInputs(input:Pick<SteeredFormatterObservation,'sessionRef'|'runRef'|'controls'|'messages'>) {
  const controls=new Map(input.controls.map(control=>[control.operationId,control]));
  const validControls=input.controls.length===2&&controls.size===2&&new Set(input.controls.map(control=>control.inputId)).size===2;
  const receiptsMatched=validControls&&input.controls.every(control=>{
    const receipt=control.receipt,params=record(control.rawParams),result=record(control.rawResult),meta=record(params['_meta']),marker=record(meta['agent-courier']);
    const blocks=params['contentBlocks'];
    return receipt?.status==='accepted'&&receipt.sessionRef===input.sessionRef&&receipt.runRef===input.runRef&&
      params['sessionId']===input.sessionRef&&typeof params['expectedRequestId']==='string'&&params['clientUserMessageId']===control.inputId&&
      Array.isArray(blocks)&&blocks.length===1&&record(blocks[0])['type']==='text'&&record(blocks[0])['text']===control.text&&
      record(meta['codebuddy.ai'])['queueOrigin']==='steer'&&marker['operationId']===control.operationId&&marker['inputId']===control.inputId&&marker['runRef']===input.runRef&&
      result['steered']===true&&result['ownerRequestId']===params['expectedRequestId'];
  });
  const owners=new Map<string,number>([[input.runRef,-1]]),transitions=new Map<string,string>(),applied=new Map<string,string>();
  const injections=new Map<string,number>();
  let current=input.runRef,conflict=false;
  for(const [index,message] of input.messages.entries()) {
    const params=record(message.params),update=record(params['update']);
    if(message.method!=='session/update'||params['sessionId']!==input.sessionRef||internalFrame(params,update)||update['sessionUpdate']!=='user_message_chunk')continue;
    const envelope=record(metaField(update['_meta'],'steerClientMeta')),marker=record(envelope['agent-courier']);
    const operationId=string(marker['operationId']),control=operationId?controls.get(operationId):undefined;if(!control)continue;
    const owner=string(metaField(update['_meta'],'conversationRequestId')),next=string(metaField(update['_meta'],'requestId')),content=record(update['content']);
    if(!receiptsMatched||!owner||!next||!owners.has(owner)||owner!==record(control.rawParams)['expectedRequestId']||
      record(envelope['codebuddy.ai'])['queueOrigin']!=='steer'||marker['runRef']!==input.runRef||marker['inputId']!==control.inputId||
      (string(update['messageId'])??string(metaField(update['_meta'],'messageId')))!==control.inputId||
      metaField(update['_meta'],'messageId')!==control.inputId||metaField(update['_meta'],'messageRequestId')!==control.inputId||
      typeof update['requestId']==='string'&&update['requestId']!==next||
      content['type']!=='text'||content['text']!==control.text) {conflict=true;continue;}
    if(applied.has(control.inputId)) {if(applied.get(control.inputId)!==next)conflict=true;continue;}
    if(owner!==next) {
      const previous=transitions.get(owner);
      if(previous!==undefined&&previous!==next||previous===undefined&&(owner!==current||owners.has(next))){conflict=true;continue;}
      if(previous===undefined){transitions.set(owner,next);owners.set(next,index);current=next;}
    }
    applied.set(control.inputId,next);
    injections.set(control.inputId,index);
  }
  return {receiptsMatched,owners,injections,applied,conflict};
}

export function summarizeSteeredFormatterObservation(input:SteeredFormatterObservation):Record<string,unknown> {
  const own=(event:HarnessEvent)=>event.sessionRef===input.sessionRef&&event.runRef===input.runRef;
  const controls=new Map(input.controls.map(control=>[control.operationId,control]));
  const validControls=input.controls.length===2&&controls.size===2&&new Set(input.controls.map(control=>control.inputId)).size===2&&
    input.markers.length===2&&new Set(input.markers).size===2&&input.markers.every(marker=>marker.length>0);
  const firstProgress=input.events.find(event=>own(event)&&event.eventType==='message.fragment'&&event.payload.text===`${input.progressText}-1`);
  const firstId=firstProgress?.eventType==='message.fragment'?firstProgress.payload.messageId:undefined;
  const pending=validControls&&input.controls.every(control=>control.pendingAtDispatch&&Number.isInteger(control.eventCursor)&&control.eventCursor>=0&&
    control.eventCursor<=input.events.length&&input.events.slice(0,control.eventCursor).some(event=>own(event)&&event.eventType==='message.completed'&&event.payload.messageId===firstId)&&
    !input.events.slice(0,control.eventCursor).some(event=>own(event)&&['run.completed','run.failed','connection.lost','input.requested'].includes(event.eventType)));
  const {owners,injections,applied,conflict,receiptsMatched:rawReceiptsMatched}=proveSteerInputs(input);
  const receiptsMatched=validControls&&rawReceiptsMatched&&input.controls.every((control,index)=>control.text.includes(input.markers[index]!));
  const appliedCount=input.controls.filter(control=>applied.has(control.inputId)&&input.events.some(event=>own(event)&&event.eventType==='input.applied'&&
    event.payload.inputId===control.inputId)).length;
  const expected=[...Array.from({length:8},(_,index)=>({kind:'progress' as const,text:`${input.progressText}-${index+1}`})),
    {kind:'final' as const,text:[input.finalText,...input.markers]}];
  const sequence=summarizeFormatterObservation(input,{expected,ownerProofs:owners});
  const finalIds=new Set(input.events.filter(event=>own(event)&&event.eventType==='message.started'&&event.payload.kind==='final')
    .map(event=>event.eventType==='message.started'?event.payload.messageId:''));
  const finalContainsBoth=input.events.some(event=>own(event)&&event.eventType==='message.fragment'&&finalIds.has(event.payload.messageId)&&
    [input.finalText,...input.markers].every(part=>event.payload.text.includes(part)));
  const status=sequence['status']==='observed'&&receiptsMatched&&pending&&!conflict&&appliedCount===2&&
    Number(sequence['nativeAliasCalls'])>0&&finalContainsBoth?'observed':'unverified';
  const diagnostics=timeline(input,owners,injections);
  return {...sequence,...diagnostics,diagnosticComplete:diagnostics['diagnosticComplete']===true&&sequence['requestMetadataConflictDetailsComplete']===true,
    status,controlReceiptsMatched:receiptsMatched,controlsApplied:appliedCount,promptPendingAtBothDispatches:pending,
    ownerProofConflict:conflict,finalContainsBoth,controlCalls:input.controls.length};
}

export async function formatterSteerExperiment(adapter:Pick<HarnessPort,'start'|'steer'|'subscribe'>,
  connection:Pick<AcpConnection,'call'|'onMessage'>,sessionRef:string,timeoutMs=120000):Promise<Record<string,unknown>> {
  const suffix=randomUUID(),progressText=`CourierFormatterProgress-${suffix}`,finalText=`CourierFormatterFinal-${suffix}`;
  const markers=[`CourierFormatterSteerA-${randomUUID()}`,`CourierFormatterSteerB-${randomUUID()}`],operationId=randomUUID();
  const events:HarnessEvent[]=[],messages:RpcMessage[]=[],controls:FormatterControl[]=[];
  const previous=connection.onMessage,previousCall=connection.call,deadline=Date.now()+timeoutMs;
  let overflow=false,rawStopReason:string|undefined,promptSettled=false,wake:(()=>void)|undefined;
  const capture=(message:RpcMessage)=>{if(messages.length<4096)messages.push(message);else overflow=true;previous(message);wake?.();};
  const captureCall:AcpConnection['call']=(method,params,id,timeout)=>{
    const result=previousCall.call(connection,method,params,id,timeout);
    if(method==='session/prompt'&&id===operationId)void result.then(value=>{
      promptSettled=true;const stop=string(record(value)['stopReason']);
      rawStopReason=stop&&['end_turn','cancelled','failed','refusal','max_tokens','max_turn_requests'].includes(stop)?stop:'other';wake?.();
    }).catch(()=>{promptSettled=true;wake?.();});
    const control=method==='session/steer'?controls.find(control=>control.operationId===id):undefined;
    if(control){control.rawParams=params;void result.then(value=>{control.rawResult=value;wake?.();}).catch(()=>{wake?.();});}
    return result;
  };
  connection.call=captureCall;connection.onMessage=capture;
  const unsubscribe=adapter.subscribe(sessionRef,event=>{if(events.length<4096)events.push(event);else overflow=true;wake?.();});
  const waitFor=async<T>(read:()=>T|undefined):Promise<T|undefined>=>{
    while(!overflow&&Date.now()<deadline) {
      const value=read();if(value!==undefined)return value;
      let timer:NodeJS.Timeout|undefined;
      try{await new Promise<void>(resolve=>{wake=resolve;timer=setTimeout(resolve,Math.max(1,deadline-Date.now()));});}
      finally{if(timer)clearTimeout(timer);wake=undefined;}
    }
    return undefined;
  };
  try {
    const started=await adapter.start({sessionRef,operationId,inputId:randomUUID(),clientRunId:randomUUID(),
      text:`Use only the pure MCP tool ${formatterFullToolName}. Make exactly eight progress calls with text ${progressText}-1 through ${progressText}-8, one at a time. `+
        'Read each tool result before making the next call; do not batch or parallelize these calls. '+
        `After all eight, call it exactly once with kind="final". Its initial text is "${finalText}". `+
        'Updates received during this Run override that initial final-text requirement; apply all such additions in the same single final call, preserving earlier additions. '+
        'You may use ToolSearch to find this tool. '+
        'Do not use other tools, read or write files, execute commands, contact the network or change permission settings. '+
        'Do not make an early or additional final call. After the final tool call, reply only: Courier formatter complete.'}).receipt;
    if(started.status!=='accepted'||started.sessionRef!==sessionRef||!started.runRef)return {status:'unverified',
      start:{status:started.status},controlCalls:0,executionPermissionApprovals:0};
    const own=(event:HarnessEvent)=>event.sessionRef===sessionRef&&event.runRef===started.runRef;
    const unsafe=()=>overflow||promptSettled||events.some(event=>own(event)&&['run.completed','run.failed','connection.lost','input.requested'].includes(event.eventType));
    const first=await waitFor(()=>{
      if(unsafe())return false;
      const fragment=events.find(event=>own(event)&&event.eventType==='message.fragment'&&event.payload.text===`${progressText}-1`);
      return fragment?.eventType==='message.fragment'&&events.some(event=>own(event)&&event.eventType==='message.completed'&&
        event.payload.messageId===fragment.payload.messageId)?true:undefined;
    });
    if(first===true)for(const marker of markers) {
      if(unsafe())break;
      const control:FormatterControl={operationId:randomUUID(),inputId:randomUUID(),pendingAtDispatch:!promptSettled,eventCursor:events.length,rawCursor:messages.length,
        text:`Update the original final-text requirement: append this exact marker to the same single final formatter call, preserving earlier additions: ${marker}. Apply this change before the original task completes; do not start a new task or make an additional final call.`};
      controls.push(control);
      control.receipt=await adapter.steer({sessionRef,expectedRunRef:started.runRef,operationId:control.operationId,inputId:control.inputId,text:control.text}).receipt;
      if(control.receipt.status!=='accepted'||control.receipt.sessionRef!==sessionRef||control.receipt.runRef!==started.runRef)break;
    }
    const end=await waitFor(()=>events.find(event=>own(event)&&['run.completed','run.failed','connection.lost','input.requested'].includes(event.eventType)));
    if(end&&end.eventType!=='connection.lost'&&end.eventType!=='input.requested')await waitFor(()=>rawStopReason);
    return summarizeSteeredFormatterObservation({sessionRef,runRef:started.runRef,progressText,finalText,markers,controls,events,messages,
      ...(rawStopReason?{rawStopReason}:{}),traceComplete:!overflow&&Date.now()<=deadline});
  }catch{return {status:'unknown',controlCalls:controls.length,executionPermissionApprovals:0};}
  finally{unsubscribe();if(connection.onMessage===capture)connection.onMessage=previous;if(connection.call===captureCall)connection.call=previousCall;}
}
