import { randomUUID } from 'node:crypto';
import type { HarnessPort,Receipt } from '../../src/adapters/harness/port.js';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';
import type { AcpConnection,RpcMessage } from '../../src/adapters/workbuddy-experimental/connection.js';
import { formatterFullToolName,formatterInputSchema,decodeFormatterResult } from '../../src/adapters/workbuddy-experimental/formatter.js';
import { interaction,isInteractionRequest,mergeInteraction,type InteractionMapping } from '../../src/adapters/workbuddy-experimental/interaction.js';
import { record,string,requestRef,metaField,internalFrame } from '../../src/adapters/workbuddy-experimental/metadata.js';

type Request=Extract<HarnessEvent,{eventType:'input.requested'}>;
export const formatterPermissionDecision='approve-one-synthetic-formatter-call' as const;

function compatible(params:Record<string,unknown>,run:string,permissionRpc=false):boolean {
  return [params,record(params['update']),record(params['toolCall'])].every((value,index)=>{
    const request=metaField(value['_meta'],'requestId'),permissionCorrelation=permissionRpc&&index===0;
    // 本版本标准权限 RPC 顶层的 requestId 来自独立 UUID；它不是 Run 标识。
    if(permissionCorrelation&&request!==undefined&&(typeof request!=='string'||!request||request.length>1024))return false;
    return [value['requestId'],metaField(value['_meta'],'conversationRequestId'),...(permissionCorrelation?[]:[request]),metaField(value['_meta'],'messageRequestId')]
      .every(ref=>ref===undefined||ref===run);
  });
}
function owned(params:Record<string,unknown>,run:string):boolean {
  const update=record(params['update']);
  return !internalFrame(params,update)&&requestRef(update)===run&&compatible(params,run);
}
export function exactFormatterPermission(request:Request,messages:RpcMessage[],text:string):InteractionMapping|undefined {
  if(request.payload.kind!=='permission')return undefined;
  let combined:InteractionMapping|undefined;
  for(const message of messages){
    const params=record(message.params),update=record(params['update']);
    if(params['sessionId']!==request.sessionRef)continue;
    const mapping=interaction(message,request.sessionRef,request.runRef,'independent-formatter-permission');
    if(isInteractionRequest(message)&&(!mapping||mapping.vendorRequestId!==request.payload.vendorRequestId||!compatible(params,request.runRef,message.method==='session/request_permission')))return undefined;
    if(!mapping||mapping.vendorRequestId!==request.payload.vendorRequestId)continue;
    const input=formatterInputSchema.safeParse(mapping.nativeInput);
    if(mapping.kind!=='permission'||mapping.nativeToolName!==formatterFullToolName||!input.success||input.data.kind!=='final'||input.data.text!==text)return undefined;
    combined=combined?mergeInteraction(combined,mapping):mapping;if(!combined)return undefined;
    // 原生 interruption 广播可不带 Run；其准确工具和正文仍须由下面原 Run 的 tool_call 证明。
    if(update['sessionUpdate']==='session_info_update'&&requestRef(update)!==undefined&&!owned(params,request.runRef))return undefined;
  }
  if(!combined||combined.wireMethod!=='interruption')return undefined;
  const tool=combined.toolCallId;
  const source=messages.some(message=>{const params=record(message.params),update=record(params['update']),input=formatterInputSchema.safeParse(update['rawInput']);
    return message.method==='session/update'&&params['sessionId']===request.sessionRef&&owned(params,request.runRef)&&
      update['sessionUpdate']==='tool_call'&&update['toolCallId']===tool&&metaField(update['_meta'],'toolName')===formatterFullToolName&&
      metaField(update['_meta'],'toolArgumentsComplete')===true&&input.success&&input.data.kind==='final'&&input.data.text===text;});
  const closed=messages.some(message=>{const params=record(message.params),update=record(params['update']);return params['sessionId']===request.sessionRef&&
    !internalFrame(params,update)&&update['toolCallId']===tool&&['completed','failed','cancelled'].includes(String(update['status']));});
  let completeParameters=false,conflict=false;
  for(const message of messages){const params=record(message.params),update=record(params['update']);
    if(params['sessionId']!==request.sessionRef||internalFrame(params,update)||update['toolCallId']!==tool)continue;
    const name=metaField(update['_meta'],'toolName'),argumentsComplete=metaField(update['_meta'],'toolArgumentsComplete'),input=formatterInputSchema.safeParse(update['rawInput']);
    if(!compatible(params,request.runRef)||name!==undefined&&name!==formatterFullToolName){conflict=true;break;}
    if(update['rawInput']===undefined)continue;
    if(argumentsComplete!==undefined&&typeof argumentsComplete!=='boolean'||completeParameters&&argumentsComplete===false){conflict=true;break;}
    if(input.success&&input.data.kind==='final'&&input.data.text===text){if(argumentsComplete===true)completeParameters=true;continue;}
    const raw=update['rawInput'],partial=record(raw);
    const validPrefix=!completeParameters&&argumentsComplete!==true&&raw!==null&&typeof raw==='object'&&!Array.isArray(raw)&&
      Object.keys(partial).every(key=>key==='kind'||key==='text')&&(partial['kind']===undefined||typeof partial['kind']==='string'&&'final'.startsWith(partial['kind']))&&
      (partial['text']===undefined||typeof partial['text']==='string'&&text.startsWith(partial['text']));
    if(!validPrefix){conflict=true;break;}
  }
  const once=combined.options?.filter(option=>option.decision==='approve'&&combined!.wireOptions[option.code]==='allow');
  if(!source||closed||conflict||once?.length!==1||!request.payload.options?.some(option=>option.code===once[0]!.code&&option.decision==='approve'))return undefined;
  return combined;
}

// 此入口必须有操作者对准确范围的明确授权；默认不提交任务，更不发送权限决定。
export async function formatterPermissionExperiment(adapter:Pick<HarnessPort,'start'|'answer'|'subscribe'>,
  connection:Pick<AcpConnection,'call'|'onMessage'>,sessionRef:string,operatorDecision?:typeof formatterPermissionDecision,timeoutMs=90000):Promise<Record<string,unknown>>{
  const report:Record<string,unknown>={status:'unverified',executionPermissionApprovals:0,dingtalkSends:0};
  if(operatorDecision!==formatterPermissionDecision)return {...report,authorizationRequired:true};
  const text=`CourierFormatterPermission-${randomUUID()}`,operationId=randomUUID(),messages:RpcMessage[]=[],events:HarnessEvent[]=[];
  const previous=connection.onMessage,previousCall=connection.call,deadline=Date.now()+timeoutMs;
  report['phase']='starting';
  let runRef='',overflow=false,bytes=0,rawStop:string|undefined,wake:(()=>void)|undefined,answerOperation:string|undefined,
    rawAnswerMatched=false,rawAnswerAccepted=false,answerReceipt:Receipt|undefined,mapping:InteractionMapping|undefined,answerCursor=-1,decisionViolation=false;
  const own=(event:HarnessEvent)=>event.sessionRef===sessionRef&&event.runRef===runRef;
  const ended=()=>events.some(event=>own(event)&&['run.completed','run.failed','connection.lost'].includes(event.eventType));
  const capture=(message:RpcMessage)=>{
    try{bytes+=Buffer.byteLength(JSON.stringify(message));}catch{overflow=true;}
    if(messages.length<2048&&bytes<=8388608)messages.push(message);else overflow=true;previous(message);wake?.();
  };
  const call:AcpConnection['call']=(method,params,id,timeout)=>{
    if(method==='_codebuddy.ai/resolveInterruption'||id===answerOperation&&answerOperation!==undefined){
      const value=record(params),exact=id===answerOperation&&method==='_codebuddy.ai/resolveInterruption'&&value['sessionId']===sessionRef&&
        value['toolCallId']===mapping?.toolCallId&&value['decision']==='allow'&&Object.keys(value).sort().join(',')==='decision,sessionId,toolCallId';
      if(!exact||report['executionPermissionApprovals']!==0){decisionViolation=true;return Promise.reject(new Error('decision_outside_operator_scope'));}
      report['executionPermissionApprovals']=1;rawAnswerMatched=true;
    }
    const result=previousCall.call(connection,method,params,id,timeout);
    if(method==='session/prompt'&&id===operationId)void result.then(value=>{rawStop=string(record(value)['stopReason']);wake?.();}).catch(()=>{wake?.();});
    if(id===answerOperation){
      void result.then(value=>{rawAnswerAccepted=record(value)['resolved']===true&&record(value)['queued']===false;wake?.();}).catch(()=>{});
    }
    return result;
  };
  connection.onMessage=capture;connection.call=call;
  const unsubscribe=adapter.subscribe(sessionRef,event=>{if(events.length<2048)events.push(event);else overflow=true;wake?.();});
  const wait=async<T>(read:()=>T|undefined):Promise<T|undefined>=>{
    while(!overflow&&Date.now()<deadline){const result=read();if(result!==undefined)return result;let timer:NodeJS.Timeout|undefined;
      try{await new Promise<void>(resolve=>{wake=resolve;timer=setTimeout(resolve,Math.max(1,deadline-Date.now()));});}
      finally{if(timer)clearTimeout(timer);wake=undefined;}}
    return undefined;
  };
  try{
    const started=await adapter.start({operationId,inputId:randomUUID(),clientRunId:randomUUID(),sessionRef,
      text:`Use ${formatterFullToolName} exactly once with kind="final" and text exactly "${text}". `+
        'You may use ToolSearch to discover that tool. Do not use any other tool, read or write files, execute commands, contact the network, or change permission settings. '+
        'After the single formatter call, end this task.'}).receipt;
    if(started.status!=='accepted'||started.sessionRef!==sessionRef||!started.runRef)return report;runRef=started.runRef;report['phase']='waiting_request';
    const request=await wait(()=>events.find((event):event is Request=>own(event)&&event.eventType==='input.requested')??(ended()?false:undefined));
    if(!request||ended())return report;report['phase']='matching_permission';
    const ready=await wait(()=>{
      if(ended()||events.filter(event=>own(event)&&event.eventType==='input.requested').length!==1||
        events.some(event=>own(event)&&event.eventType==='input.invalidated'&&event.payload.vendorRequestId===request.payload.vendorRequestId))return false;
      const exact=exactFormatterPermission(request,messages,text);
      return exact&&events.some(event=>own(event)&&event.eventType==='message.completed'&&event.payload.messageId===request.payload.messageId)?exact:undefined;
    });
    mapping=ready?exactFormatterPermission(request,messages,text):undefined;
    const once=mapping?.options?.find(option=>option.decision==='approve'&&mapping!.wireOptions[option.code]==='allow');
    const forbidden=()=>events.filter(event=>own(event)&&event.eventType==='input.requested').length!==1||
      events.some(event=>own(event)&&event.eventType==='input.invalidated'&&event.payload.vendorRequestId===request.payload.vendorRequestId)||
      messages.some(message=>{const params=record(message.params),update=record(params['update']),other=interaction(message,sessionRef,runRef,'independent-formatter-permission');
        if(params['sessionId']!==sessionRef||internalFrame(params,update))return false;
        if(isInteractionRequest(message)&&(!other||other.vendorRequestId!==request.payload.vendorRequestId||!compatible(params,runRef,message.method==='session/request_permission')))return true;
        const name=metaField(update['_meta'],'toolName');return update['sessionUpdate']==='tool_call'&&
          (name!==formatterFullToolName&&name!=='ToolSearch'||name===formatterFullToolName&&update['toolCallId']!==mapping?.toolCallId);});
    if(!mapping||!once||forbidden()||overflow||ended()||Date.now()>deadline||!events.some(event=>own(event)&&event.eventType==='message.completed'&&event.payload.messageId===request.payload.messageId))return report;
    answerOperation=randomUUID();const inputId=randomUUID();answerCursor=messages.length;report['permissionDecisionsSubmitted']=1;report['phase']='submitting_decision';
    answerReceipt=await adapter.answer({operationId:answerOperation,inputId,sessionRef,runRef,vendorRequestId:request.payload.vendorRequestId,
      answer:{kind:'permission',decision:'approve',optionCode:once.code}}).receipt;
    if(answerReceipt.status!=='accepted'||answerReceipt.sessionRef!==sessionRef||answerReceipt.runRef!==runRef||answerReceipt.vendorRequestId!==request.payload.vendorRequestId)return report;
    report['phase']='waiting_completion';
    await wait(()=>ended()||forbidden()?true:undefined);if(ended())await wait(()=>rawStop!==undefined?true:undefined);
    const native=messages.flatMap((message,index)=>{const params=record(message.params),update=record(params['update']);
      if(index<answerCursor||message.method!=='session/update'||params['sessionId']!==sessionRef||internalFrame(params,update)||
        update['toolCallId']!==mapping!.toolCallId)return [];
      if(['failed','cancelled'].includes(String(update['status'])))return [{index,matched:false}];
      if(update['status']!=='completed')return [];
      if(update['rawOutput']===undefined)return [];
      const result=decodeFormatterResult(update['rawOutput']);return [{index,matched:compatible(params,runRef)&&result?.kind==='final'&&result.text===text}];});
    const id=`formatter:${mapping.toolCallId}`,starts=events.filter(event=>own(event)&&event.eventType==='message.started'&&event.payload.messageId===id),
      body=events.filter((event):event is Extract<HarnessEvent,{eventType:'message.fragment'}>=>own(event)&&event.eventType==='message.fragment'&&event.payload.messageId===id),
      complete=events.filter(event=>own(event)&&event.eventType==='message.completed'&&event.payload.messageId===id),
      accepted=events.filter(event=>own(event)&&event.eventType==='input.accepted'&&event.payload.operationId===answerOperation&&event.payload.inputId===inputId),
      end=events.filter(event=>own(event)&&['run.completed','run.failed','connection.lost'].includes(event.eventType));
    const allStarts=events.filter(event=>own(event)&&event.eventType==='message.started');
    const normalized=allStarts.length===2&&allStarts.every(event=>event.eventType==='message.started'&&[id,request.payload.messageId].includes(event.payload.messageId))&&
      starts.length===1&&starts[0]!.eventType==='message.started'&&starts[0]!.payload.kind==='final'&&starts[0]!.payload.userVisible&&
      body.length===1&&body[0]!.payload.text===text&&body[0]!.payload.fragmentIndex===0&&body[0]!.payload.fragmentKey===`${id}:snapshot`&&
      complete.length===1&&complete[0]!.eventType==='message.completed'&&complete[0]!.payload.finalFragmentIndex===0&&
      events.indexOf(starts[0]!)<events.indexOf(body[0]!)&&events.indexOf(body[0]!)<events.indexOf(complete[0]!);
    const originalEnd=end.length===1&&end[0]!.eventType==='run.completed'&&end[0]!.payload.stopReason==='end_turn'&&
      complete.length===1&&events.indexOf(complete[0]!)<events.indexOf(end[0]!);
    Object.assign(report,{traceComplete:!overflow&&Date.now()<=deadline,rawFrames:messages.length,rawDecisionMatched:rawAnswerMatched,decisionScopeViolation:decisionViolation,
      rawDecisionAccepted:rawAnswerAccepted,normalizedAcceptance:accepted.length===1,originalToolCompleted:native.some(value=>value.matched)&&native.every(value=>value.matched),
      originalOutputMatched:normalized,originalRunCompleted:originalEnd,rawPromptEndTurn:rawStop==='end_turn',unexpectedRequests:forbidden()});
    if(report['traceComplete']&&!decisionViolation&&rawAnswerMatched&&rawAnswerAccepted&&accepted.length===1&&report['originalToolCompleted']&&normalized&&originalEnd&&rawStop==='end_turn'&&!forbidden())report['status']='observed';
    return report;
  }catch{report['error']='formatter_permission_observation_unavailable';return report;}
  finally{
    const toolSources=messages.flatMap(message=>{const params=record(message.params),update=record(params['update']);
      if(message.method!=='session/update'||params['sessionId']!==sessionRef||internalFrame(params,update)||update['sessionUpdate']!=='tool_call'||metaField(update['_meta'],'toolName')!==formatterFullToolName)return [];
      const input=formatterInputSchema.safeParse(update['rawInput']);return [{id:typeof update['toolCallId']==='string'?update['toolCallId']:undefined,
        bound:owned(params,runRef),argumentsComplete:metaField(update['_meta'],'toolArgumentsComplete')===true,inputMatched:input.success&&input.data.kind==='final'&&input.data.text===text}];});
    const requests=messages.flatMap(message=>{const params=record(message.params),update=record(params['update']);
      if(params['sessionId']!==sessionRef||!isInteractionRequest(message))return [];
      const value=interaction(message,sessionRef,runRef,'independent-formatter-permission'),input=formatterInputSchema.safeParse(value?.nativeInput);
      return [{parsed:!!value,formatterTool:value?.nativeToolName===formatterFullToolName,wireMethod:value?.wireMethod??'unknown',
        inputMatched:input.success&&input.data.kind==='final'&&input.data.text===text,
        boundByOriginalTool:!!value&&toolSources.some(tool=>tool.id===value.toolCallId&&tool.bound&&tool.argumentsComplete&&tool.inputMatched),
        hasRunMetadata:requestRef(update)!==undefined,metadataCompatible:compatible(params,runRef,message.method==='session/request_permission'),
        allowOncePresent:value?.options?.some(option=>option.decision==='approve'&&value.wireOptions[option.code]==='allow')===true}];});
    report['diagnostics']={rawFrames:messages.length,normalizedHumanRequests:events.filter(event=>own(event)&&event.eventType==='input.requested').length,
      observationTimedOut:Date.now()>deadline,traceOverflow:overflow,toolSources:toolSources.slice(0,16).map(({bound,argumentsComplete,inputMatched})=>({bound,argumentsComplete,inputMatched})),
      nativeRequests:requests.slice(0,16),detailsComplete:toolSources.length<=16&&requests.length<=16};
    unsubscribe();if(connection.onMessage===capture)connection.onMessage=previous;if(connection.call===call)connection.call=previousCall;
  }
}
