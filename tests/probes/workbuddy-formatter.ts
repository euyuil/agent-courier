import { randomUUID } from 'node:crypto';
import type { HarnessPort,Receipt } from '../../src/adapters/harness/port.js';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';
import type { AcpConnection,RpcMessage } from '../../src/adapters/workbuddy-experimental/connection.js';
import { formatterFullToolName,formatterInputSchema,decodeFormatterResult,type FormatterPayload } from '../../src/adapters/workbuddy-experimental/formatter.js';
import { record,string,requestRef,metaField,internalFrame } from '../../src/adapters/workbuddy-experimental/metadata.js';

export interface FormatterObservation {
  sessionRef:string;runRef:string;progressText:string;finalText:string;
  events:HarnessEvent[];messages:RpcMessage[];rawStopReason?:string;traceComplete:boolean;
}
export interface FormatterSequence {
  expected:{kind:'progress'|'final';text:string|string[]}[];
  ownerProofs:ReadonlyMap<string,number>;
}

export function summarizeFormatterObservation(input:FormatterObservation,sequence?:FormatterSequence):Record<string,unknown> {
  const events=input.events.filter(e=>e.sessionRef===input.sessionRef&&e.runRef===input.runRef);
  const tools=new Map<string,{input?:{kind:'progress'|'final';text:string};result?:FormatterPayload;completed:boolean}>();
  const names=new Map<string,string>(),bound=new Set<string>(),aliases=new Set<string>(),conflicts=new Set<string>();let conflict=false;
  const requestMetadataConflicts:Record<string,unknown>[]=[];
  let requestMetadataConflictCount=0;
  const fail=(reason:string)=>{conflict=true;conflicts.add(reason);};
  for(const [index,message] of input.messages.entries()) {
    const params=record(message.params),update=record(params['update']),ref=requestRef(update)??requestRef(params);
    const proof=ref?sequence?.ownerProofs.get(ref):undefined;
    const alias=ref!==undefined&&ref!==input.runRef&&proof!==undefined&&proof<index&&
      metaField(update['_meta'],'messageRequestId')===input.runRef;
    if(message.method!=='session/update'||params['sessionId']!==input.sessionRef||internalFrame(params,update)||
      ref!==undefined&&ref!==input.runRef&&!alias||!['tool_call','tool_call_update'].includes(String(update['sessionUpdate'])))continue;
    const id=string(update['toolCallId']);if(!id)continue;
    const references=[update['requestId'],metaField(update['_meta'],'conversationRequestId'),metaField(update['_meta'],'requestId')];
    const known=(value:unknown)=>{
      if(value===input.runRef)return true;
      const proof=typeof value==='string'?sequence?.ownerProofs.get(value):undefined;return proof!==undefined&&proof<index;
    };
    const provenCombination=sequence!==undefined&&metaField(update['_meta'],'messageRequestId')===input.runRef&&
      references.every(value=>typeof value!=='string'||known(value));
    if(references.some(value=>typeof value==='string'&&value!==ref)&&!provenCombination) {
      fail('request_metadata');
      requestMetadataConflictCount++;
      if(requestMetadataConflicts.length<32) {
        const name=metaField(update['_meta'],'toolName')??names.get(id),match=(value:unknown)=>typeof value==='string'?value===ref:null;
        const request=metaField(update['_meta'],'requestId'),ownerProof=typeof request==='string'?sequence?.ownerProofs.get(request):undefined;
        requestMetadataConflicts.push({frame:index,frameType:update['sessionUpdate'],bound:bound.has(id),
          tool:name===formatterFullToolName?'formatter':name==='ToolSearch'?'tool_search':'other',
          topLevelMatches:match(update['requestId']),conversationMatches:match(metaField(update['_meta'],'conversationRequestId')),
          metadataRequestMatches:match(request),metadataRequestOriginal:request===input.runRef,
          metadataRequestKnownOwner:request===input.runRef||ownerProof!==undefined&&ownerProof<index,
          originalInput:metaField(update['_meta'],'messageRequestId')===input.runRef});
      }
      continue;
    }
    if(update['sessionUpdate']==='tool_call'&&(ref===input.runRef||alias)){
      bound.add(id);if(alias||provenCombination&&references.some(value=>typeof value==='string'&&value!==input.runRef))aliases.add(id);
    }
    if(!bound.has(id))continue;
    const name=string(metaField(update['_meta'],'toolName'));
    if(name){if(names.has(id)&&names.get(id)!==name)fail('tool_name');names.set(id,name);}
    if(names.get(id)!==formatterFullToolName)continue;
    const tool=tools.get(id)??{completed:false};tools.set(id,tool);
    if(['failed','cancelled'].includes(String(update['status'])))fail('tool_status');
    if(tool.completed&&update['status']!=='completed')continue;
    const parsed=formatterInputSchema.safeParse(update['rawInput']);
    if(parsed.success)tool.input=parsed.data;
    if(update['status']!=='completed')continue;
    if(tool.completed&&update['rawOutput']===undefined&&update['rawInput']===undefined)continue;
    const result=decodeFormatterResult(update['rawOutput']);
    if(!result||!tool.input||result.kind!==tool.input.kind||result.text!==tool.input.text||
      tool.result&&(tool.result.kind!==result.kind||tool.result.text!==result.text))fail('result_payload');
    else{tool.result=result;tool.completed=true;}
  }
  const starts=events.filter(e=>e.eventType==='message.started');
  const fragments=events.filter(e=>e.eventType==='message.fragment');
  const completed=events.filter(e=>e.eventType==='message.completed');
  const ends=events.filter(e=>['run.completed','run.failed','connection.lost'].includes(e.eventType));
  const expected=sequence?.expected??[{kind:'progress',text:input.progressText},{kind:'progress',text:input.progressText},{kind:'final',text:input.finalText}];
  const nativeIds=new Set<string>();
  const matched=starts.length===expected.length&&starts.every((event,index)=>{
    if(event.eventType!=='message.started')return false;
    const id=event.payload.messageId,toolId=id.startsWith('formatter:')?id.slice('formatter:'.length):'',tool=tools.get(toolId),want=expected[index]!;
    if(!toolId||nativeIds.has(toolId))return false;nativeIds.add(toolId);
    const body=fragments.filter(e=>e.eventType==='message.fragment'&&e.payload.messageId===id);
    const end=completed.filter(e=>e.eventType==='message.completed'&&e.payload.messageId===id);
    const text=tool?.result?.text,textMatches=typeof text==='string'&&(typeof want.text==='string'?text===want.text:want.text.every(part=>text.includes(part)));
    return event.payload.kind===want.kind&&event.payload.userVisible&&event.payload.logicalOrder===index&&tool?.completed===true&&
      tool.result?.kind===want.kind&&textMatches&&body.length===1&&body[0]!.eventType==='message.fragment'&&
      body[0]!.payload.text===text&&body[0]!.payload.fragmentIndex===0&&body[0]!.payload.fragmentKey===`${id}:snapshot`&&
      end.length===1&&end[0]!.eventType==='message.completed'&&end[0]!.payload.finalFragmentIndex===0&&
      events.indexOf(event)<events.indexOf(body[0]!)&&events.indexOf(body[0]!)<events.indexOf(end[0]!);
  });
  const runEnd=ends.length===1&&ends[0]?.eventType==='run.completed'&&ends[0].payload.stopReason==='end_turn';
  const terminalIndex=ends.length===1?events.indexOf(ends[0]!):-1;
  const last=starts[expected.length-1],finalId=last?.eventType==='message.started'?last.payload.messageId:undefined;
  const finalIndex=events.findIndex(e=>e.eventType==='message.completed'&&e.payload.messageId===finalId);
  const finalBeforeRunEnd=finalIndex>=0&&terminalIndex>finalIndex;
  const allMessagesBeforeEnd=completed.length===expected.length&&completed.every(event=>events.indexOf(event)<terminalIndex);
  const unexpectedTools=[...bound].filter(id=>!['ToolSearch',formatterFullToolName].includes(names.get(id)??'')).length;
  const humanRequests=events.filter(e=>e.eventType==='input.requested').length;
  const observed=input.traceComplete&&!conflict&&matched&&tools.size===expected.length&&fragments.length===expected.length&&completed.length===expected.length&&
    runEnd&&input.rawStopReason==='end_turn'&&finalBeforeRunEnd&&allMessagesBeforeEnd&&unexpectedTools===0&&humanRequests===0;
  const finalParts=expected.at(-1)?.text;
  return {status:observed?'observed':'unverified',traceComplete:input.traceComplete,rawFrames:input.messages.length,
    nativeFormatterCalls:tools.size,nativeCompletedCalls:[...tools.values()].filter(tool=>tool.completed).length,
    normalizedMessages:starts.length,normalizedKinds:starts.map(e=>e.eventType==='message.started'?e.payload.kind:'other'),
    originalIdentitiesAndBodiesMatched:matched,completedSnapshots:completed.length,conflictingResult:conflict,
    finalBeforeRunEnd,allMessagesBeforeEnd,originalRunCompleted:runEnd,rawPromptStop:input.rawStopReason??'not_observed',
    unexpectedTools,humanRequests,...(sequence?{nativeAliasCalls:aliases.size,conflictReasons:[...conflicts],requestMetadataConflicts,requestMetadataConflictCount,
      requestMetadataConflictDetailsComplete:requestMetadataConflictCount===requestMetadataConflicts.length,
      nativeFinalPartMatches:[...tools.values()].filter(tool=>tool.result?.kind==='final').map(tool=>
        (Array.isArray(finalParts)?finalParts:[finalParts??'']).map(part=>tool.result!.text.includes(part)))}:{}),executionPermissionApprovals:0};
}

export async function formatterExperiment(adapter:Pick<HarnessPort,'start'|'subscribe'>,
  connection:Pick<AcpConnection,'call'|'onMessage'>,sessionRef:string,timeoutMs=90000,plainUserInput=false,
  options:{recallFinalText?:string;observe?:(observation:FormatterObservation)=>void}={}):Promise<Record<string,unknown>> {
  const suffix=randomUUID(),progressText=`CourierFormatterProgress-${suffix}`,finalText=options.recallFinalText??`CourierFormatterFinal-${suffix}`;
  const operationId=randomUUID(),events:HarnessEvent[]=[],messages:RpcMessage[]=[];
  const previous=connection.onMessage,previousCall=connection.call,deadline=Date.now()+timeoutMs;
  let overflow=false,rawStopReason:string|undefined,wake:(()=>void)|undefined;
  const capture=(message:RpcMessage)=>{if(messages.length<2048)messages.push(message);else overflow=true;previous(message);wake?.();};
  const captureCall:AcpConnection['call']=(method,params,id,timeout)=>{
    const result=previousCall.call(connection,method,params,id,timeout);
    if(method==='session/prompt'&&id===operationId)void result.then(value=>{
      const stop=string(record(value)['stopReason']);rawStopReason=stop&&['end_turn','cancelled','failed','refusal','max_tokens','max_turn_requests'].includes(stop)?stop:'other';wake?.();
    }).catch(()=>{wake?.();});
    return result;
  };
  connection.call=captureCall;connection.onMessage=capture;
  const unsubscribe=adapter.subscribe(sessionRef,event=>{if(events.length<2048)events.push(event);else overflow=true;wake?.();});
  const waitFor=async<T>(read:()=>T|undefined):Promise<T|undefined>=>{
    while(!overflow&&Date.now()<deadline) {
      const value=read();if(value!==undefined)return value;
      let timer:NodeJS.Timeout|undefined;
      try{await new Promise<void>(resolve=>{wake=resolve;timer=setTimeout(resolve,Math.max(1,deadline-Date.now()));});}
      finally{if(timer)clearTimeout(timer);wake=undefined;}
    }
    return undefined;
  };
  const receipt=(value:Receipt)=>value.status==='accepted'?{status:value.status}:{status:value.status,code:value.errorCode};
  try {
    const started=await adapter.start({sessionRef,operationId,inputId:randomUUID(),clientRunId:randomUUID(),
      text:options.recallFinalText!==undefined?
        'Use the pure message formatter once with kind="final". Its text must be exactly the final formatted message from the immediately preceding turn. '+
        'The previous message is not repeated here. Do not use other tools except ToolSearch for that formatter, read or write files, run commands, contact the network or change permissions.':
        plainUserInput?`Report progress twice, with each progress message exactly: ${progressText}. `+
        `Then provide a final response exactly: ${finalText}. `+
        'Do not perform unrelated work, read or write files, run commands, access the network or change permission settings.':
        `Use the pure MCP formatter ${formatterFullToolName} exactly three times, sequentially. `+
        `First use kind="progress" and text="${progressText}". Make a second separate call with exactly the same kind and text. `+
        `Then use kind="final" and text="${finalText}". You may use ToolSearch to discover that exact tool. `+
        'Do not call other tools, read or write files, run commands, contact the network, or change permission settings. '+
        'After the calls, reply only: Courier formatter complete.'}).receipt;
    if(started.status!=='accepted'||started.sessionRef!==sessionRef||!started.runRef)return {status:'unverified',start:receipt(started),executionPermissionApprovals:0};
    const own=(e:HarnessEvent)=>e.sessionRef===sessionRef&&e.runRef===started.runRef;
    const end=await waitFor(()=>events.find(e=>own(e)&&['run.completed','run.failed','connection.lost','input.requested'].includes(e.eventType)));
    if(end&&end.eventType!=='input.requested'&&end.eventType!=='connection.lost')await waitFor(()=>rawStopReason);
    const observation:FormatterObservation={sessionRef,runRef:started.runRef,progressText,finalText,events,messages,
      ...(rawStopReason?{rawStopReason}:{}),traceComplete:!overflow&&Date.now()<=deadline};
    const report=summarizeFormatterObservation(observation,options.recallFinalText!==undefined?
      {expected:[{kind:'final',text:finalText}],ownerProofs:new Map([[started.runRef,-1]])}:undefined);
    options.observe?.(observation);
    return {...report,start:receipt(started)};
  }catch{return {status:'unknown',executionPermissionApprovals:0};}
  finally{unsubscribe();if(connection.onMessage===capture)connection.onMessage=previous;if(connection.call===captureCall)connection.call=previousCall;}
}
