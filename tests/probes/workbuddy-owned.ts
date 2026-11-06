import { randomUUID } from 'node:crypto';
import { AcpConnection } from '../../src/adapters/workbuddy-experimental/connection.js';
import { WorkBuddyAdapter } from '../../src/adapters/workbuddy-experimental/session.js';
import { record,string,metaField,internalFrame } from '../../src/adapters/workbuddy-experimental/metadata.js';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';
import type { Receipt } from '../../src/adapters/harness/port.js';
import { safeCode } from '../../src/domain/errors.js';
import { ownRuntimeEndpoints,identifyOwnAcpTransport } from './workbuddy-acp.js';
import { acpQuestionExperiment } from './workbuddy-acp-question.js';
import { acpPermissionDenialExperiment } from './workbuddy-acp-permission.js';
import { summarizeClassicHooks } from './workbuddy-classic-hooks.js';

interface Diagnostic {evaluate(expression:string,timeout?:number):Promise<unknown>}
export async function initializeOwnedBootstrap(connection:Pick<AcpConnection,'call'>,cwd:string,bootstrap:string):Promise<'matched'|'identity_mismatch'|'unknown'|'invalid'> {
  if(!cwd||!bootstrap)return 'invalid';
  try {
    const result=record(await connection.call('session/new',{cwd,mcpServers:[]},randomUUID()));
    return result['sessionId']===bootstrap?'matched':'identity_mismatch';
  }catch{return 'unknown';}
}
export function freshOwnedSession(receipt:unknown,bootstrap:string):string|undefined {
  const value=record(receipt),session=string(value['sessionRef']);
  return bootstrap&&value['status']==='accepted'&&session&&session!==bootstrap?session:undefined;
}
const summary=(receipt:Receipt)=>({status:receipt.status,...(receipt.status==='accepted'?{}:{code:receipt.errorCode})});
export async function ownedSessionExperiment(diagnostic:Diagnostic,cwd:string,options:{initializeBootstrap?:boolean;exerciseQuestion?:boolean;
  exercisePermission?:boolean;observeHooks?:boolean}={}):Promise<Record<string,unknown>> {
  const {initializeBootstrap=false,exerciseQuestion=false,exercisePermission=false,observeHooks=false}=options;
  const bootstrap=await diagnostic.evaluate(`(async()=>{const p=globalThis.__courierCapabilityProbe;if(typeof p?.sessionId!=='string')return;
    const s=await globalThis.__wbInvoke('session:get',{},p.sessionId);
    return !s?.__wbError&&s?.sessionId===p.sessionId&&s?.cwd===${JSON.stringify(cwd)}&&s?.isProcessing===false?p.sessionId:undefined;})()`);
  if(typeof bootstrap!=='string')return {status:'bootstrap_unverified'};
  const runtime=ownRuntimeEndpoints(cwd,'/proc',bootstrap),identified=await identifyOwnAcpTransport(runtime.endpoints);
  if(!identified.endpoint)return {status:'endpoint_unverified'};
  const data=new Map<string,unknown>(),adapters:WorkBuddyAdapter[]=[],rawStops=new Map<string,string>(),counts={new:0,load:0,prompt:0};
  // 已实际观察的桌面启动会话不是待新建的 Courier 绑定，返回它时不能覆盖该归属。
  data.set(`session:${bootstrap}`,{kind:'desktop_bootstrap_observed'});
  let owned:string|undefined,bootstrapReused=false,returnedSession=false,toolFrames=0,typedFrames=0,visibleFrames=0,
    fragmentIdentityFrames=0,promptLinkedFrames=0,rawFailure=false;
  let bootstrapInitialization:Awaited<ReturnType<typeof initializeOwnedBootstrap>>|'not_requested'='not_requested';
  const build=()=>{
    const connection=new AcpConnection({endpoint:identified.endpoint!,timeoutMs:5000}),call=connection.call.bind(connection);
    connection.call=(method,params,id,timeout)=>{
      if(method==='session/new')counts.new++;if(method==='session/load')counts.load++;if(method==='session/prompt')counts.prompt++;
      const result=call(method,params,id,timeout);
      void result.then(value=>{
        const r=record(value);
        if(method==='session/new'){returnedSession=typeof r['sessionId']==='string';bootstrapReused=r['sessionId']===bootstrap;}
        if(method==='session/prompt'&&id) {
          const stop=string(r['stopReason']);if(stop)rawStops.set(id,['end_turn','max_tokens','max_turn_requests','refusal','cancelled','failed'].includes(stop)?stop:'other');
        }
      }).catch(()=>{if(method==='session/prompt')rawFailure=true;});
      return result;
    };
    const adapter=new WorkBuddyAdapter({connection,store:{get:key=>data.get(key),set:(key,value)=>{data.set(key,value);}},cwd,
      instanceId:'independent-owned-acp',contextFingerprint:'independent-owned-observation-only',evidence:[],receiptTimeoutMs:20000});
    const consume=connection.onMessage;
    connection.onMessage=message=>{
      const params=record(message.params),update=record(params['update']);
      if(owned&&params['sessionId']===owned&&message.method==='session/update'&&!internalFrame(params,update)) {
        if(update['sessionUpdate']==='tool_call')toolFrames++;
        if(['agent_message_chunk','assistant_message_chunk'].includes(String(update['sessionUpdate']))) {
          visibleFrames++;
          const metas=[update['_meta'],params['_meta'],record(update['content'])['_meta']];
          if(metas.some(meta=>['kind','phase'].some(key=>['progress','final'].includes(String(metaField(meta,key))))))typedFrames++;
          if(metas.some(meta=>['fragmentId','chunkId','fragmentIndex','sequence'].some(key=>{
            const value=metaField(meta,key);return typeof value==='string'&&value.length>0||typeof value==='number'&&Number.isInteger(value)&&value>=0;
          })))fragmentIdentityFrames++;
          if(metas.some(meta=>typeof metaField(meta,'promptRequestId')==='string'))promptLinkedFrames++;
        }
      }
      consume(message);
    };
    adapters.push(adapter);return {adapter,connection};
  };
  const finish=(result:Record<string,unknown>)=>({...result,counts:{...counts},bootstrapInitialization,bootstrapReused,returnedSession,toolCallFrames:toolFrames,
    visibleFrames,typedProgressFinalFrames:typedFrames,fragmentIdentityFrames,promptRequestIdFrames:promptLinkedFrames,
    rawPromptFailureObserved:rawFailure,executionPermissionApprovals:0});
  const run=async(adapter:WorkBuddyAdapter,text:string,marker:string)=>{
    const operationId=randomUUID(),events:HarnessEvent[]=[],beforeTools=toolFrames;
    let complete!:(event:HarnessEvent|undefined)=>void;
    const terminal=new Promise<HarnessEvent|undefined>(resolve=>{complete=resolve;}),timer=setTimeout(()=>complete(undefined),90000);
    const unsubscribe=adapter.subscribe(owned!,event=>{
      events.push(event);if(['run.completed','run.failed','connection.lost','input.requested'].includes(event.eventType))complete(event);
    });
    try {
      const receipt=await adapter.start({operationId,inputId:randomUUID(),sessionRef:owned!,text,clientRunId:randomUUID()}).receipt;
      if(receipt.status!=='accepted')return {...summary(receipt),completion:'unverified',rawPromptStop:rawStops.get(operationId)??'not_observed',markerObserved:false};
      const end=await terminal,own=events.filter(event=>event.runRef===receipt.runRef);
      const messages=new Map<string,string>();let bounded=true;
      for(const event of own)if(event.eventType==='message.fragment') {
        const prior=messages.get(event.payload.messageId)??'',next=prior+event.payload.text;
        if(next.length>65536){bounded=false;break;}messages.set(event.payload.messageId,next);
      }
      return {status:receipt.status,completion:end?.eventType==='run.completed'&&end.runRef===receipt.runRef?'completed':
        end?.eventType==='run.failed'?'failed':end?.eventType==='input.requested'?'unexpected_human_input':'unverified',
        rawPromptStop:rawStops.get(operationId)??'not_observed',markerObserved:bounded&&[...messages.values()].some(body=>body.includes(marker)),
        toolCallFrames:toolFrames-beforeTools,...(observeHooks?{hookObservation:summarizeClassicHooks(cwd,owned!,receipt.runRef!,marker)}:{})};
    }finally{clearTimeout(timer);unsubscribe();}
  };
  try {
    const {adapter:first,connection}=build();await first.connect();
    if(initializeBootstrap) {
      // This explicit initialization is confined to the probe's own idle bootstrap.
      // A second new-session operation is allowed only after its identity is confirmed.
      bootstrapInitialization=await initializeOwnedBootstrap(connection,cwd,bootstrap);
      if(bootstrapInitialization!=='matched')return finish({status:'bootstrap_initialization_unverified',agentRunStarts:0});
    }
    const created=await first.createSession({operationId:randomUUID(),courierSessionId:randomUUID()}).receipt;
    owned=freshOwnedSession(created,bootstrap);
    if(!owned)return finish({status:'new_session_not_established',creation:summary(created),agentRunStarts:0});
    const marker=`CourierOwnedContext-${randomUUID()}`;
    const firstRun=await run(first,`Remember this exact synthetic context marker for later turns: ${marker}. `+
      'Do not use tools, read or write files, or contact the network. Reply only with that marker.',marker);
    if(firstRun.status!=='accepted'||firstRun.completion!=='completed'||firstRun.rawPromptStop!=='end_turn'||!firstRun.markerObserved||toolFrames!==0)
      return finish({status:'first_task_unverified',newSessionDistinct:true,firstRun});
    await first.disconnect('independent-owned-acp');
    const {adapter:second,connection:resumedConnection}=build();await second.connect();
    const resumed=await second.resumeSession({operationId:randomUUID(),sessionRef:owned}).receipt;
    if(resumed.status!=='accepted')return finish({status:'resume_unverified',newSessionDistinct:true,firstRun,resume:summary(resumed)});
    const continuation=await run(second,'Without using tools, reading files or contacting the network, reply only with the exact synthetic context marker '+
      'I asked you to remember in the previous turn. The marker is not repeated in this input.',marker);
    const contextRoundtripObserved=continuation.status==='accepted'&&continuation.completion==='completed'&&
      continuation.rawPromptStop==='end_turn'&&continuation.markerObserved&&toolFrames===0;
    const questionObservation=exerciseQuestion?(contextRoundtripObserved?await acpQuestionExperiment(second,owned):{status:'skipped_incomplete_original_task'}):undefined;
    const permissionObservation=exercisePermission?(contextRoundtripObserved?await acpPermissionDenialExperiment(second,resumedConnection,owned):
      {status:'skipped_incomplete_original_task'}):undefined;
    return finish({status:'observed',newSessionDistinct:true,firstRun,resume:summary(resumed),continuation,contextRoundtripObserved,
      ...(questionObservation?{questionObservation}:{}),...(permissionObservation?{permissionObservation}:{})});
  }catch(error){return finish({status:'unavailable',code:safeCode(error)});}
  finally{await Promise.allSettled(adapters.map(adapter=>adapter.disconnect('independent-owned-acp')));}
}
