import type { HarnessPort } from '../../src/adapters/harness/port.js';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';
import type { AcpConnection,RpcMessage } from '../../src/adapters/workbuddy-experimental/connection.js';
import { formatterExperiment,summarizeFormatterObservation,type FormatterObservation } from './workbuddy-formatter.js';
import { record,string,metaField,internalFrame } from '../../src/adapters/workbuddy-experimental/metadata.js';
import { decodeFormatterResult,type FormatterPayload } from '../../src/adapters/workbuddy-experimental/formatter.js';
import { isInteractionRequest } from '../../src/adapters/workbuddy-experimental/interaction.js';
import { randomUUID } from 'node:crypto';

export interface FormatterEndpoint {
  adapter:Pick<HarnessPort,'start'|'subscribe'|'resumeSession'|'disconnect'>&{connect():Promise<void>};
  connection:Pick<AcpConnection,'call'|'onMessage'>;
}
export interface FormatterReloadObservation {
  original:FormatterObservation;next:FormatterObservation;messages:RpcMessage[];events:HarnessEvent[];
  loadBoundary:number;traceComplete:boolean;
}
function toolIds(input:FormatterObservation):Set<string> {
  return new Set(input.events.filter(event=>event.sessionRef===input.sessionRef&&event.runRef===input.runRef&&event.eventType==='message.started')
    .flatMap(event=>event.eventType==='message.started'&&event.payload.messageId.startsWith('formatter:')?[event.payload.messageId.slice('formatter:'.length)]:[]));
}
function replay(params:Record<string,unknown>,update:Record<string,unknown>):boolean {
  return [params['_meta'],update['_meta'],record(update['content'])['_meta']].some(meta=>metaField(meta,'mode')==='history'||
    ['historyReplay','rendererHistoryReplay','ownerSnapshotHistoryReplay'].some(key=>metaField(meta,key)===true));
}
export function summarizeFormatterReload(input:FormatterReloadObservation):Record<string,unknown> {
  const ids=toolIds(input.original),expected=new Map<string,FormatterPayload>(),seen=new Set<string>(),matched=new Set<string>();
  for(const message of input.original.messages) {
    const params=record(message.params),update=record(params['update']),id=string(update['toolCallId']);
    if(params['sessionId']!==input.original.sessionRef||internalFrame(params,update)||!id||!ids.has(id)||update['status']!=='completed')continue;
    const payload=decodeFormatterResult(update['rawOutput']);if(payload)expected.set(id,payload);
  }
  let historyFrames=0,lateHistoryFrames=0,visibleHistoryFrames=0,unflaggedKnownFrames=0,conflict=false;
  for(const [index,message] of input.messages.entries()) {
    const params=record(message.params),update=record(params['update']);if(params['sessionId']!==input.original.sessionRef)continue;
    const metas=[params['_meta'],update['_meta'],record(update['content'])['_meta']];
    if(metas.some(meta=>['isSubAgent','isTeamMember','parentSessionId','parentToolCallId','memberEvent','teamUpdate','isCompactInternal','compactType','isSessionSeparator']
      .some(key=>{const value=metaField(meta,key);return value!==undefined&&value!==false;})))continue;
    const historical=replay(params,update),id=string(update['toolCallId']);
    if(historical){historyFrames++;if(index>=input.loadBoundary)lateHistoryFrames++;
      if(['agent_message_chunk','assistant_message_chunk'].includes(String(update['sessionUpdate'])))visibleHistoryFrames++;}
    if(!id||!ids.has(id))continue;
    if(!historical){unflaggedKnownFrames++;continue;}seen.add(id);
    if(update['status']!=='completed'||update['rawOutput']===undefined)continue;
    const result=decodeFormatterResult(update['rawOutput']),prior=expected.get(id);
    if(!result||!prior||result.kind!==prior.kind||result.text!==prior.text)conflict=true;else matched.add(id);
  }
  const oldMessageIds=new Set([...ids].map(id=>`formatter:${id}`));
  const duplicateNormalizedEvents=input.events.filter(event=>['message.started','message.fragment','message.completed'].includes(event.eventType)&&
    'messageId' in event.payload&&oldMessageIds.has(event.payload.messageId)).length;
  const nextIds=toolIds(input.next),distinct=input.next.sessionRef===input.original.sessionRef&&input.next.runRef!==input.original.runRef&&
    nextIds.size===1&&[...nextIds].every(id=>!ids.has(id));
  const original=summarizeFormatterObservation(input.original),continuation=summarizeFormatterObservation(input.next,{
    expected:[{kind:'final',text:input.original.finalText}],ownerProofs:new Map([[input.next.runRef,-1]])});
  const complete=input.traceComplete&&input.messages.length<=4096&&input.events.length<=4096&&Number.isInteger(input.loadBoundary)&&input.loadBoundary>=0&&input.loadBoundary<=input.messages.length;
  return {status:complete&&original['status']==='observed'&&continuation['status']==='observed'&&ids.size===3&&expected.size===3&&seen.size===3&&matched.size===3&&
      distinct&&!conflict&&unflaggedKnownFrames===0&&duplicateNormalizedEvents===0?'observed':'unverified',
    traceComplete:complete,historyFrames,lateHistoryFrames,visibleHistoryFrames,matchedHistoryTools:seen.size,matchedHistoryPayloads:matched.size,
    historyPayloadConflict:conflict,unflaggedKnownFrames,duplicateNormalizedEvents,newRunAndToolsDistinct:distinct,
    originalSourceMatched:original['status']==='observed',continuationSourceAndContextMatched:continuation['status']==='observed',
    loadReplyIsGlobalReplayBarrier:false,executionPermissionApprovals:0};
}
export async function formatterHistoryExperiment(initial:FormatterEndpoint,reopen:()=>FormatterEndpoint,sessionRef:string,timeoutMs=90000):Promise<Record<string,unknown>> {
  let original:FormatterObservation|undefined;
  const baseline=await formatterExperiment(initial.adapter,initial.connection,sessionRef,timeoutMs,true,{observe:input=>{original=structuredClone(input);}});
  const report:Record<string,unknown>={status:'unverified',baseline,executionPermissionApprovals:0};
  if(baseline['status']!=='observed'||!original)return report;
  await initial.adapter.disconnect('independent-owned-acp');
  let next:FormatterEndpoint;
  try{next=reopen();}catch{return {...report,error:'reopen_unavailable'};}
  if(next.adapter===initial.adapter||next.connection===initial.connection)return {...report,error:'connection_not_replaced'};
  const messages:RpcMessage[]=[],events:HarnessEvent[]=[],previous=next.connection.onMessage;
  let overflow=false,bytes=0;
  const capture=(message:RpcMessage)=>{
    try{bytes+=Buffer.byteLength(JSON.stringify(message));}catch{overflow=true;}
    if(messages.length<4096&&bytes<=8388608)messages.push(message);else overflow=true;previous(message);
  };
  next.connection.onMessage=capture;
  const release=next.adapter.subscribe(sessionRef,event=>{if(events.length<4096)events.push(event);else overflow=true;});
  try {
    await next.adapter.connect();
    const resumed=await next.adapter.resumeSession({operationId:randomUUID(),sessionRef}).receipt;
    report['resume']={status:resumed.status};report['newConnectionInstance']=true;
    if(resumed.status!=='accepted'||resumed.sessionRef!==sessionRef||overflow)return report;
    const loadBoundary=messages.length;
    report['idleEventsAfterLoad']=events.length;
    if(events.length||messages.some(message=>record(message.params)['sessionId']===sessionRef&&isInteractionRequest(message)))return report;
    let continuationInput:FormatterObservation|undefined;
    const continuation=await formatterExperiment(next.adapter,next.connection,sessionRef,timeoutMs,true,{
      recallFinalText:original.finalText,observe:input=>{continuationInput=structuredClone(input);}});
    report['continuation']=continuation;
    if(!continuationInput)return report;
    return {...report,...summarizeFormatterReload({original,next:continuationInput,messages,events,loadBoundary,traceComplete:!overflow})};
  }catch{return {...report,error:'reload_observation_unavailable'};}
  finally{release();if(next.connection.onMessage===capture)next.connection.onMessage=previous;await next.adapter.disconnect('independent-owned-acp').catch(()=>{});}
}
