import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';
import type { RpcMessage } from '../../src/adapters/workbuddy-experimental/connection.js';
import { ManagedWorkBuddy,workBuddyManagedOptions } from '../../src/adapters/workbuddy-experimental/managed.js';
import { managedRuntimeStore } from '../../src/adapters/workbuddy-experimental/managed-runtime.js';
import { interaction } from '../../src/adapters/workbuddy-experimental/interaction.js';
import { record,metaField,internalFrame } from '../../src/adapters/workbuddy-experimental/metadata.js';
import { assertOutsideRepository } from '../../src/config/private.js';
import { privateDirectory } from '../../src/storage/private-state.js';
import { acquireInstanceLock } from '../../src/storage/instance-lock.js';
import { openDatabase,type Connection } from '../../src/storage/database.js';
import { migrate } from '../../src/storage/migrate.js';
import { adapterMappings } from '../../src/storage/adapter-mappings.js';
import { acpQuestionExperiment,type PendingQuestionObservation } from './workbuddy-acp-question.js';
import { observedInteraction } from './workbuddy-interaction.js';
import { prepareObservedQuestion } from './workbuddy-question.js';
import { summarizeQuestionResult } from './workbuddy-question-result.js';
import { desktopBootstrapReady } from '../../src/adapters/workbuddy-experimental/authentication.js';
import { bootstrapProvenance } from '../../src/adapters/workbuddy-experimental/bootstrap-provenance.js';
import { inspectRuntimeProcess } from '../../src/adapters/workbuddy-experimental/runtime-discovery.js';
import { z } from 'zod';
import { recoverManagedBackend } from './workbuddy-managed-recovery.js';

const terminal=(event:HarnessEvent)=>['run.completed','run.failed','connection.lost'].includes(event.eventType);
const recall='Without tools, files or network access, reply only with the exact synthetic context marker you remembered in this Harness session. This input does not repeat the marker.';
interface Diagnostic {evaluate(expression:string,timeout?:number):Promise<unknown>}
const identitySchema=z.strictObject({pid:z.number().int().positive(),startTime:z.string().regex(/^\d+$/),bootId:z.string().uuid()});
export async function automaticManagedExperiment(desktopDebugUrl:string,workspace:string,mode:'interleaved'|'text'|'question'|'recovery'='interleaved',diagnostic?:Diagnostic):Promise<Record<string,unknown>> {
  const report:Record<string,unknown>={status:'unverified',executionPermissionApprovals:0,dingtalkSends:0};
  const namespace='independent-managed-acp',databasePath=join(workspace,'managed.sqlite');
  let db:Connection|undefined,release:(()=>void)|undefined,managed:ManagedWorkBuddy|undefined,bytes=0,frameCount=0,overflow=false,generation=0;
  const frames=new Map<string,RpcMessage[]>();
  const native=new Map<string,{prompts:number;settled:number;stop:string;answerResolved:boolean;answerQueued:boolean}>();
  const runtimeOwners=new Map<string,{host:string;pid:number}>();
  let questionRef='',questionTool='',selected='',unselected='',questionFrames:RpcMessage[]=[],questionSnapshot:Record<string,unknown>|undefined;
  const profile={cwd:workspace,cliVersion:null,bootstrapPermissionMode:'default' as const,authorizationScope:[],
    desktopDebugUrl,ownership:{mode:'courier-exclusive' as const},output:{mode:'acp-text' as const,contractVersion:1 as const}};
  const open=async()=>{
    generation++;
    release=acquireInstanceLock(databasePath);db=openDatabase(databasePath);migrate(db);
    const store=adapterMappings(db,namespace);
    const options=workBuddyManagedOptions({profile,store,instanceId:namespace,evidence:[]});
    const adapter=new ManagedWorkBuddy({...options,connect:async(ref,owner)=>{
      const courierSessionId=ref?record(store.get(`session:${ref}`))['courierSessionId']:owner;
      if(courierSessionId!==undefined&&typeof courierSessionId!=='string')throw new Error('managed_scope_unknown');
      const required=ref!==undefined&&courierSessionId!==undefined&&record(store.get(`managed-owner:${courierSessionId}`))['runtimeIsolation']===true;
      const runtimeStore=managedRuntimeStore(store,courierSessionId,required);
      const endpoint=await options.connect(ref,owner);
      if(ref){const previous=endpoint.connection.onMessage,messages:RpcMessage[]=[];frames.set(ref,messages);
        const host=record(runtimeStore.get('desktop-host')),pid=record(host['processIdentity'])['pid'];
        if(typeof host['sessionRef']==='string'&&typeof pid==='number'){
          const old=runtimeOwners.get(ref),current={host:host['sessionRef'],pid};
          if(old&&generation>1)report['sameUserHostsAfterReopen']=report['sameUserHostsAfterReopen']!==false&&old.host===current.host&&old.pid===current.pid;
          runtimeOwners.set(ref,current);
        }
        const previousCall=endpoint.connection.call,state=native.get(ref)??{prompts:0,settled:0,stop:'not_observed',answerResolved:false,answerQueued:false};native.set(ref,state);
        endpoint.connection.call=(method,params,id,timeout)=>{
          const result=previousCall.call(endpoint.connection,method,params,id,timeout);
          if(method==='session/prompt'){state.prompts++;void result.then(value=>{state.settled++;const stop=record(value)['stopReason'];
            state.stop=typeof stop==='string'&&['end_turn','cancelled','refusal','failed'].includes(stop)?stop:'other';}).catch(()=>{state.settled++;state.stop='unknown';});}
          if(method==='_codebuddy.ai/resolveInterruption')void result.then(value=>{state.answerResolved=record(value)['resolved']===true;state.answerQueued=record(value)['queued']===true;}).catch(()=>{});
          return result;
        };
        endpoint.connection.onMessage=message=>{
          const params=record(message.params),update=record(params['update']);
          if(!internalFrame(params,update)){
            try{bytes+=Buffer.byteLength(JSON.stringify(message));}catch{overflow=true;}
            if(messages.length<4096&&bytes<=8388608){messages.push(message);frameCount++;}else overflow=true;
          }previous(message);
        };}
      return endpoint;
    }});
    managed=adapter;await adapter.connect();return adapter;
  };
  const close=async()=>{await managed?.disconnect(namespace);managed=undefined;db?.close();db=undefined;release?.();release=undefined;};
  const toolsSafe=(ref:string,allowed:string[],cursor=0)=>!overflow&&(frames.get(ref)??[]).slice(cursor).every(message=>{
    const params=record(message.params),update=record(params['update']);if(internalFrame(params,update))return true;
    if(message.method==='session/request_permission'&&!allowed.includes('AskUserQuestion'))return false;
    if(update['sessionUpdate']!=='tool_call')return true;
    const name=metaField(update['_meta'],'toolName');return typeof name==='string'&&allowed.includes(name);
  });
  const nativeQuestion=(ref:string,observation:PendingQuestionObservation)=>{
    const messages=frames.get(ref)??[],toolUpdates=messages.map(message=>record(record(message.params)['update']));
    for(const message of messages){
      const mapping=interaction(message,ref,observation.request.runRef,'independent-managed-question');
      if(!mapping||mapping.vendorRequestId!==observation.request.payload.vendorRequestId)continue;
      const snapshot={sessionRef:ref,toolCallId:mapping.toolCallId,messages,toolUpdates};
      const source=observedInteraction(snapshot,'question','AskUserQuestion'),prepared=prepareObservedQuestion(snapshot,observation.selected);
      const questions=source?.mapping.nativeInput['questions'];
      if(!source||!prepared||!Array.isArray(questions)||questions.length!==1)continue;
      const question=record(questions[0]),options=question['options'];
      const matched=question['question']===observation.questionText&&Array.isArray(options)&&options.length===2&&
        observation.labels.every(label=>options.some(option=>record(option)['label']===label));
      if(matched){questionRef=ref;questionTool=mapping.toolCallId;selected=observation.selected;unselected=observation.labels[0]!;questionFrames=messages;}return matched;
    }return false;
  };
  const textRun=async(adapter:ManagedWorkBuddy,ref:string,text:string,marker:string,forbidden:string)=>{
    const originalFrames=frames.get(ref),frameCursor=originalFrames?.length??0;
    const events:HarnessEvent[]=[];let wake:(()=>void)|undefined;
    const unsubscribe=adapter.subscribe(ref,event=>{if(events.length<2048)events.push(event);else overflow=true;wake?.();});
    try{
      const receipt=await adapter.start({sessionRef:ref,operationId:randomUUID(),clientRunId:randomUUID(),inputId:randomUUID(),text}).receipt;
      if(receipt.status!=='accepted')return false;
      const deadline=Date.now()+75000,own=(event:HarnessEvent)=>event.runRef===receipt.runRef&&event.sessionRef===ref;
      while(!overflow&&Date.now()<deadline&&!events.some(event=>own(event)&&terminal(event))){let timer:NodeJS.Timeout|undefined;
        try{await new Promise<void>(resolve=>{wake=resolve;timer=setTimeout(resolve,Math.max(1,deadline-Date.now()));});}
        finally{if(timer)clearTimeout(timer);wake=undefined;}}
      const end=events.find(event=>own(event)&&terminal(event)),messages=new Map<string,string>();
      for(const event of events)if(own(event)&&event.eventType==='message.fragment')messages.set(event.payload.messageId,(messages.get(event.payload.messageId)??'')+event.payload.text);
      return !overflow&&end?.eventType==='run.completed'&&end.payload.stopReason==='end_turn'&&toolsSafe(ref,[],frames.get(ref)===originalFrames?frameCursor:0)&&
        [...messages.values()].some(body=>body.trim()===marker)&&![...messages.values()].some(body=>body.includes(forbidden));
    }finally{unsubscribe();}
  };
  try{
    if(mode==='recovery'&&!diagnostic)return report;
    assertOutsideRepository(workspace);privateDirectory(workspace);
    const first=await open(),probe=await first.probe(namespace);report['cliVersion']=probe.cliVersion;
    report['requiredCapabilitiesUnverified']=['typedVisibleOutput','messageAssembly','humanInteraction'].every(name=>probe.capabilities[name as keyof typeof probe.capabilities]==='unverified');
    const createdA=await first.createSession({operationId:randomUUID(),courierSessionId:randomUUID()}).receipt;
    report['firstContextPrepared']=createdA.status==='accepted';if(createdA.status!=='accepted')return report;
    const a=createdA.sessionRef,markerB=`CourierManagedB-${randomUUID()}`;let b='',markerA='';
    if(mode==='question'){
      const question=await acpQuestionExperiment(first,a,90000,async observation=>nativeQuestion(a,observation)&&toolsSafe(a,['AskUserQuestion','ToolSearch']));
      questionSnapshot={...native.get(a)};
      report['question']=question;if(question['status']==='observed')report['status']='observed';return report;
    }
    if(mode==='text'||mode==='recovery'){
      markerA=`CourierManagedA-${randomUUID()}`;
      report['originalSeed']=await textRun(first,a,`Remember this exact synthetic context marker for later turns: ${markerA}. Do not use tools, files or network. Reply only with that marker.`,markerA,markerB);
      if(report['originalSeed']!==true)return report;
      const peer=await first.createSession({operationId:randomUUID(),courierSessionId:randomUUID()}).receipt;
      report['peerContextPrepared']=peer.status==='accepted';if(peer.status!=='accepted'||peer.sessionRef===a)return report;b=peer.sessionRef;
      report['peerSeed']=await textRun(first,b,`Remember this exact synthetic context marker for later turns: ${markerB}. Do not use tools, files or network. Reply only with that marker.`,markerB,markerA);
      if(report['peerSeed']!==true)return report;
    }else{
      const question=await acpQuestionExperiment(first,a,90000,async observation=>{
      report['nativeQuestionMatched']=nativeQuestion(a,observation)&&toolsSafe(a,['AskUserQuestion','ToolSearch']);
      if(report['nativeQuestionMatched']!==true)return false;markerA=observation.selected;
      const createdB=await first.createSession({operationId:randomUUID(),courierSessionId:randomUUID()}).receipt;
      report['peerCreatedWhileQuestionPending']=createdB.status==='accepted';
      if(createdB.status!=='accepted'||createdB.sessionRef===a)return false;b=createdB.sessionRef;
      const firstHost=runtimeOwners.get(a),peerHost=runtimeOwners.get(b);
      report['distinctUserHosts']=!!firstHost&&!!peerHost&&firstHost.host!==peerHost.host;
      report['distinctBackendProcesses']=!!firstHost&&!!peerHost&&firstHost.pid!==peerHost.pid;
      const seeded=await textRun(first,b,`Remember this exact synthetic context marker for later turns: ${markerB}. Do not use tools, read or write files, or contact the network. Reply only with that marker.`,markerB,markerA);
      report['peerRanWhileQuestionPending']=seeded;return seeded&&report['distinctUserHosts']===true&&report['distinctBackendProcesses']===true&&nativeQuestion(a,observation)&&toolsSafe(a,['AskUserQuestion','ToolSearch']);
      });report['question']=question;questionSnapshot={...native.get(a)};
      if(question['status']!=='observed'||!b||!markerA)return report;
    }
    if(mode==='recovery'){
      const store=adapterMappings(db!,namespace),ownerA=record(store.get(`session:${a}`))['courierSessionId'],ownerB=record(store.get(`session:${b}`))['courierSessionId'];
      if(typeof ownerA!=='string'||typeof ownerB!=='string'||ownerA===ownerB)return report;
      const runtimeA=managedRuntimeStore(store,ownerA,true),runtimeB=managedRuntimeStore(store,ownerB,true),oldA=record(runtimeA.get('desktop-host')),oldB=record(runtimeB.get('desktop-host'));
      const identityA=identitySchema.safeParse(oldA['processIdentity']),identityB=identitySchema.safeParse(oldB['processIdentity']);
      if(!identityA.success||!identityB.success||typeof oldA['sessionRef']!=='string'||typeof oldB['sessionRef']!=='string'||
        typeof oldA['operationId']!=='string'||oldA['sessionRef']===oldB['sessionRef']||identityA.data.pid===identityB.data.pid)return report;
      const question=await acpQuestionExperiment(first,b,90000,async observation=>{
        if(!nativeQuestion(b,observation)||!toolsSafe(b,['AskUserQuestion','ToolSearch']))return false;
        const peerPending=async()=>observation.isPending()&&nativeQuestion(b,observation)&&toolsSafe(b,['AskUserQuestion','ToolSearch'])&&
          record(runtimeB.get('desktop-host'))['sessionRef']===oldB['sessionRef']&&
          JSON.stringify(record(runtimeB.get('desktop-host'))['processIdentity'])===JSON.stringify(identityB.data)&&await inspectRuntimeProcess(identityB.data)==='alive';
        const recovery=await recoverManagedBackend(a,{
          ownIdle:async()=>record(store.get(`managed-run:${a}`))['status']==='idle'&&
            record(store.get(`session:${a}`))['courierSessionId']===ownerA&&
            await inspectRuntimeProcess(identityA.data)==='alive'&&
            await desktopBootstrapReady(desktopDebugUrl,workspace,oldA['sessionRef'] as string,fetch,WebSocket,bootstrapProvenance(store,oldA['sessionRef'] as string)),
          peerPending,
          shutdown:async()=>{
            if(!await peerPending()||record(store.get(`managed-run:${a}`))['status']!=='idle')return false;
            return (await diagnostic!.evaluate(`(async()=>{try{
              const s=await globalThis.__wbInvoke('session:get',{},${JSON.stringify(oldA['sessionRef'])});
              if(s?.__wbError||s?.sessionId!==${JSON.stringify(oldA['sessionRef'])}||s.cwd!==${JSON.stringify(workspace)}||s.isProcessing!==false)return false;
              for(const key of ['pendingPermissions','pendingQuestions','pendingElicitations'])if(!Array.isArray(s[key])||s[key].length)return false;
              const r=await globalThis.__wbInvoke('session:destroy',{},s.sessionId);return r===undefined||r===null||r===true;
            }catch{return false;}})()`,15000))===true;
          },
          inspectOld:async()=>inspectRuntimeProcess(identityA.data),pause:()=>new Promise(resolve=>setTimeout(resolve,100)),
          restore:()=>first.resumeSession({sessionRef:a,operationId:randomUUID()}).receipt,
          replacementMatches:async()=>{
            const current=record(runtimeA.get('desktop-host')),identity=identitySchema.safeParse(current['processIdentity']);
            return typeof current['sessionRef']==='string'&&current['sessionRef']!==oldA['sessionRef']&&current['sessionRef']!==a&&
              current['previousSessionRef']===oldA['sessionRef']&&current['previousOperationId']===oldA['operationId']&&
              record(runtimeA.get(`desktop-host-operation:${oldA['operationId']}`))['status']==='retired'&&
              identity.success&&JSON.stringify(identity.data)!==JSON.stringify(identityA.data)&&await inspectRuntimeProcess(identity.data)==='alive'&&
              record(store.get(`session:${a}`))['courierSessionId']===ownerA;
          },
          recall:()=>textRun(first,a,recall,markerA,markerB),
        });report['backendRecovery']=recovery;return recovery['status']==='observed';
      });report['questionDuringRecovery']=question;questionSnapshot={...native.get(b)};
      if(question['status']!=='observed')return report;
    }
    report['peerRecall']=await textRun(first,b,recall,markerB,markerA);if(report['peerRecall']!==true)return report;
    const current=await first.probe(namespace);report['liveContextAuthentication']=current.authenticationStatus==='authenticated';
    report['configuredTargetStable']=current.contextFingerprint===probe.contextFingerprint;
    await close();const second=await open();report['privateDatabaseReopened']=true;
    report['configuredTargetStable']=report['configuredTargetStable']===true&&(await second.probe(namespace)).contextFingerprint===probe.contextFingerprint;
    const loadA=await second.resumeSession({sessionRef:a,operationId:randomUUID()}).receipt;
    report['originalContextReloaded']=loadA.status==='accepted'&&loadA.sessionRef===a;
    if(report['originalContextReloaded']!==true)return report;
    report['originalRecall']=await textRun(second,a,mode==='text'||mode==='recovery'?recall:'Without tools, files or network access, reply only with the exact option label I selected in the previous question. This input does not repeat the label.',markerA,markerB);
    if(report['originalRecall']!==true)return report;
    const loadB=await second.resumeSession({sessionRef:b,operationId:randomUUID()}).receipt;
    report['peerContextReloaded']=loadB.status==='accepted'&&loadB.sessionRef===b;
    if(report['peerContextReloaded']!==true)return report;
    report['peerRecallAfterReopen']=await textRun(second,b,recall,markerB,markerA);
    report['configuredTargetStable']=report['configuredTargetStable']===true&&(await second.probe(namespace)).contextFingerprint===probe.contextFingerprint;
    if(!overflow&&report['peerRecallAfterReopen']===true&&report['liveContextAuthentication']===true&&report['configuredTargetStable']===true)report['status']='observed';
    return report;
  }catch{report['error']='managed_observation_unavailable';return report;}
  finally{
    report['traceComplete']=!overflow;report['rawFrames']=frameCount;
    if(questionRef){report['nativeQuestionChannel']=questionSnapshot??{...native.get(questionRef)};report['nativeQuestionResults']=questionFrames.map(message=>record(record(message.params)['update']))
      .filter(update=>update['toolCallId']===questionTool&&['completed','failed','cancelled'].includes(String(update['status'])))
      .slice(0,8).map(update=>summarizeQuestionResult(update,selected,unselected));}
    await close().catch(()=>{});db?.close();release?.();
  }
}
