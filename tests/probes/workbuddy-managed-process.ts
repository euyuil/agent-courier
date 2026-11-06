import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join,isAbsolute } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ManagedWorkBuddy,workBuddyManagedOptions } from '../../src/adapters/workbuddy-experimental/managed.js';
import { managedRuntimeStore } from '../../src/adapters/workbuddy-experimental/managed-runtime.js';
import { desktopBootstrapReady } from '../../src/adapters/workbuddy-experimental/authentication.js';
import { bootstrapProvenance } from '../../src/adapters/workbuddy-experimental/bootstrap-provenance.js';
import { inspectRuntimeProcess,type RuntimeProcessIdentity } from '../../src/adapters/workbuddy-experimental/runtime-discovery.js';
import { record,internalFrame } from '../../src/adapters/workbuddy-experimental/metadata.js';
import { assertOutsideRepository } from '../../src/config/private.js';
import { openDatabase,type Connection } from '../../src/storage/database.js';
import { acquireInstanceLock } from '../../src/storage/instance-lock.js';
import { migrate } from '../../src/storage/migrate.js';
import { adapterMappings } from '../../src/storage/adapter-mappings.js';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';

const namespace='independent-managed-process',databaseName='managed-process.sqlite';
const bounded=z.string().min(1).max(1024),identitySchema=z.strictObject({pid:z.number().int().positive(),startTime:z.string().regex(/^\d+$/),bootId:z.string().uuid()});
const snapshotSchema=z.strictObject({sessionRef:bounded,ownerRef:bounded,hostRef:bounded,identity:identitySchema});
const inputSchema=z.strictObject({enableIndependentManagedProcess:z.literal(true),workspace:bounded,desktopDebugUrl:z.string().url(),phase:z.enum(['seed','reuse','replace'])});
type WorkerInput=z.infer<typeof inputSchema>;
export type ManagedProcessSnapshot=z.infer<typeof snapshotSchema>;
const summarySchema=z.strictObject({bothExact:z.boolean(),bothScoped:z.boolean(),bothEndTurn:z.boolean(),nativeEndTurn:z.boolean(),
  noTools:z.boolean(),completeTrace:z.boolean(),requiredCapabilitiesUnverified:z.boolean(),configuredTargetStable:z.boolean(),actualUserCreates:z.number().int().min(0),userContextCount:z.number().int().min(0),
  aHostOperations:z.number().int().min(0),bHostOperations:z.number().int().min(0),events:z.number().int().min(0).max(8192),frames:z.number().int().min(0).max(8192),
  cliVersion:z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/).optional()});
const resultSchema=z.strictObject({status:z.enum(['observed','unverified']),summary:summarySchema,contexts:z.tuple([snapshotSchema,snapshotSchema]).optional(),targetFingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional()});
export type ManagedProcessResult=z.infer<typeof resultSchema>;
export interface ManagedProcessExit {result:ManagedProcessResult;pid:number;exitedNormally:boolean}
interface Diagnostic {evaluate(expression:string,timeout?:number):Promise<unknown>}
export interface ManagedProcessServices {
  worker(input:WorkerInput):Promise<ManagedProcessExit>;
  ready(snapshot:ManagedProcessSnapshot):Promise<boolean>;
  shutdown(snapshot:ManagedProcessSnapshot):Promise<boolean>;
  inspect(identity:RuntimeProcessIdentity):Promise<'alive'|'ended'|'unknown'>;
  pause():Promise<void>;
}
function empty():ManagedProcessResult{return {status:'unverified',summary:{bothExact:false,bothScoped:false,bothEndTurn:false,nativeEndTurn:false,noTools:false,
  completeTrace:false,requiredCapabilitiesUnverified:false,configuredTargetStable:false,actualUserCreates:0,userContextCount:0,aHostOperations:0,bHostOperations:0,events:0,frames:0}};}
function sameIdentity(a:RuntimeProcessIdentity,b:RuntimeProcessIdentity):boolean{return a.pid===b.pid&&a.startTime===b.startTime&&a.bootId===b.bootId;}
function sameContext(a:ManagedProcessSnapshot,b:ManagedProcessSnapshot):boolean{return a.sessionRef===b.sessionRef&&a.ownerRef===b.ownerRef;}
function sameRuntime(a:ManagedProcessSnapshot,b:ManagedProcessSnapshot):boolean{return a.hostRef===b.hostRef&&sameIdentity(a.identity,b.identity);}
function successful(result:ManagedProcessResult):boolean{
  const s=result.summary,pair=result.contexts;
  return result.status==='observed'&&!!pair&&!!result.targetFingerprint&&s.bothExact&&s.bothScoped&&s.bothEndTurn&&s.nativeEndTurn&&s.noTools&&s.completeTrace&&s.requiredCapabilitiesUnverified&&s.configuredTargetStable&&
    s.userContextCount===2&&pair[0].sessionRef!==pair[1].sessionRef&&pair[0].ownerRef!==pair[1].ownerRef&&pair[0].hostRef!==pair[1].hostRef&&pair[0].identity.pid!==pair[1].identity.pid&&
    pair.every(context=>pair.every(other=>context.hostRef!==other.sessionRef));
}
export async function runManagedProcessWorker(input:WorkerInput):Promise<ManagedProcessExit>{
  return new Promise(resolve=>{
    const child=fork(fileURLToPath(import.meta.url),['--internal-managed-process-worker'],{stdio:['ignore','ignore','ignore','ipc'],execArgv:[]});
    let result=empty(),normal=false;
    const timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},180000);
    child.on('message',value=>{try{if(JSON.stringify(value).length>16384)return;const parsed=resultSchema.safeParse(value);if(parsed.success)result=parsed.data;}catch{}});
    child.on('error',()=>{});child.once('exit',(code,signal)=>{normal=code===0&&signal===null;});
    child.once('close',()=>{clearTimeout(timer);resolve({result,pid:child.pid??0,exitedNormally:normal});});
    child.send(input,error=>{if(error)try{child.kill('SIGKILL');}catch{}});
  });
}
export async function managedProcessExperiment(diagnostic:Diagnostic,desktopDebugUrl:string,workspace:string,services?:ManagedProcessServices):Promise<Record<string,unknown>>{
  const report:Record<string,unknown>={status:'unverified',executionPermissionApprovals:0,dingtalkSends:0},workers=new Set<number>();
  const api:ManagedProcessServices=services??{
    worker:runManagedProcessWorker,
    ready:async snapshot=>{
      const db=openDatabase(join(workspace,databaseName));
      try{
        const store=adapterMappings(db,namespace),current=record(managedRuntimeStore(store,snapshot.ownerRef,true).get('desktop-host'));
        const owner=record(store.get(`managed-owner:${snapshot.ownerRef}`));
        if(current['status']!=='ready'||current['sessionRef']!==snapshot.hostRef||record(store.get(`managed-run:${snapshot.sessionRef}`))['status']!=='idle'||
          owner['sessionRef']!==snapshot.sessionRef||owner['runtimeIsolation']!==true||record(store.get(`session:${snapshot.sessionRef}`))['courierSessionId']!==snapshot.ownerRef)return false;
        const identity=identitySchema.safeParse(current['processIdentity']);if(!identity.success||!sameIdentity(identity.data,snapshot.identity))return false;
        return await desktopBootstrapReady(desktopDebugUrl,workspace,snapshot.hostRef,fetch,WebSocket,bootstrapProvenance(store,snapshot.hostRef));
      }finally{db.close();}
    },
    shutdown:async snapshot=>(await diagnostic.evaluate(`(async()=>{try{
      const s=await globalThis.__wbInvoke('session:get',{},${JSON.stringify(snapshot.hostRef)});
      if(s?.__wbError||s?.sessionId!==${JSON.stringify(snapshot.hostRef)}||s.cwd!==${JSON.stringify(workspace)}||s.isProcessing!==false)return false;
      for(const key of ['pendingPermissions','pendingQuestions','pendingElicitations'])if(!Array.isArray(s[key])||s[key].length)return false;
      const r=await globalThis.__wbInvoke('session:destroy',{},s.sessionId);return r===undefined||r===null||r===true;
    }catch{return false;}})()`,15000))===true,
    inspect:async identity=>inspectRuntimeProcess(identity),pause:()=>new Promise(resolve=>setTimeout(resolve,100)),
  };
  try{
    const run=async(phase:WorkerInput['phase'])=>{
      const exit=await api.worker({enableIndependentManagedProcess:true,workspace,desktopDebugUrl,phase}),parsed=resultSchema.safeParse(exit.result);
      if(!exit.exitedNormally||!Number.isSafeInteger(exit.pid)||exit.pid<1||workers.has(exit.pid)||!parsed.success)return undefined;
      workers.add(exit.pid);report[phase]=parsed.data.summary;return parsed.data;
    };
    const seed=await run('seed');if(!seed||!successful(seed)||seed.summary.actualUserCreates!==2||seed.summary.aHostOperations!==1||seed.summary.bHostOperations!==1)return report;
    const reuse=await run('reuse');
    if(!reuse||!successful(reuse)||reuse.targetFingerprint!==seed.targetFingerprint||reuse.summary.cliVersion!==seed.summary.cliVersion||reuse.summary.actualUserCreates!==0||reuse.summary.aHostOperations!==1||reuse.summary.bHostOperations!==1||
      !reuse.contexts!.every((context,index)=>sameContext(context,seed.contexts![index]!)&&sameRuntime(context,seed.contexts![index]!)))return report;
    report['originalContextsAcrossProcesses']=true;
    const [originalA,originalB]=reuse.contexts!;
    if(!await api.ready(originalA)||await api.inspect(originalA.identity)!=='alive'||await api.inspect(originalB.identity)!=='alive')return report;
    report['normalIdleShutdown']=await api.shutdown(originalA);if(report['normalIdleShutdown']!==true)return report;
    let state=await api.inspect(originalA.identity);
    for(let i=0;i<30&&state==='alive';i++){await api.pause();state=await api.inspect(originalA.identity);}
    report['oldProcessDeathProven']=state==='ended';if(state!=='ended'||await api.inspect(originalB.identity)!=='alive')return report;
    const replaced=await run('replace');if(!replaced||!successful(replaced))return report;
    const [newA,newB]=replaced.contexts!;
    if(replaced.targetFingerprint!==seed.targetFingerprint||replaced.summary.cliVersion!==seed.summary.cliVersion||replaced.summary.actualUserCreates!==0||replaced.summary.aHostOperations!==2||replaced.summary.bHostOperations!==1||
      !sameContext(newA,originalA)||newA.hostRef===originalA.hostRef||sameIdentity(newA.identity,originalA.identity)||
      !sameContext(newB,originalB)||!sameRuntime(newB,originalB))return report;
    report['status']='observed';report['separateWorkerProcesses']=workers.size;report['peerBackendUnchanged']=true;report['configuredTargetAcrossProcesses']=true;return report;
  }catch{report['error']='managed_process_observation_unavailable';return report;}
}

async function worker(input:WorkerInput):Promise<ManagedProcessResult>{
  const result=empty();let db:Connection|undefined,release:(()=>void)|undefined,managed:ManagedWorkBuddy|undefined;
  try{
    const debug=new URL(input.desktopDebugUrl);
    if(!isAbsolute(input.workspace)||debug.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(debug.hostname)||debug.username||debug.password||debug.search||debug.hash)return result;
    assertOutsideRepository(input.workspace);
    const path=join(input.workspace,databaseName);release=acquireInstanceLock(path);db=openDatabase(path);migrate(db);
    const store=adapterMappings(db,namespace),step=`probe-step:${input.phase}`,prior=record(store.get('probe-original'));
    if(store.get(step)!==undefined||input.phase==='seed'&&Object.keys(prior).length||input.phase!=='seed'&&prior['status']!=='complete')return result;
    if(input.phase!=='seed'&&record(store.get(`probe-step:${input.phase==='reuse'?'seed':'reuse'}`))['status']!=='complete')return result;
    store.set(step,{status:'dispatching'});
    const contexts:{ownerRef:string;sessionRef:string;marker:string}[]=[];
    if(input.phase!=='seed'){
      const parsed=z.array(z.strictObject({ownerRef:bounded,sessionRef:bounded,marker:bounded})).length(2).safeParse(prior['contexts']);
      if(!parsed.success)return result;contexts.push(...parsed.data);
    }
    let bytes=0,boundedTrace=true,actualCreates=0,totalFrames=0,totalEvents=0;
    const raw=new Map<string,{tools:number;stop:string;frames:number}>();
    const options=workBuddyManagedOptions({profile:{cwd:input.workspace,cliVersion:null,authorizationScope:[],desktopDebugUrl:input.desktopDebugUrl,
      bootstrapPermissionMode:'default',ownership:{mode:'courier-exclusive'},output:{mode:'acp-text'}},store,instanceId:namespace,evidence:[]});
    managed=new ManagedWorkBuddy({...options,connect:async(ref,owner)=>{
      const endpoint=await options.connect(ref,owner),previousCall=endpoint.connection.call;
      const state={tools:0,stop:'not_observed',frames:0};if(ref)raw.set(ref,state);
      endpoint.connection.call=(method,params,id,timeout)=>{
        if(method==='session/new')actualCreates++;
        const promise=previousCall.call(endpoint.connection,method,params,id,timeout);
        if(method==='session/prompt')void promise.then(value=>{state.stop=record(value)['stopReason']==='end_turn'?'end_turn':'other';}).catch(()=>{state.stop='unknown';});
        return promise;
      };
      if(ref){const previous=endpoint.connection.onMessage;endpoint.connection.onMessage=message=>{
        const params=record(message.params),update=record(params['update']);
        if(!internalFrame(params,update)){
          totalFrames++;state.frames++;try{bytes+=Buffer.byteLength(JSON.stringify(message));}catch{boundedTrace=false;}
          if(totalFrames>8192||bytes>8388608)boundedTrace=false;
          if(params['sessionId']===ref&&(update['sessionUpdate']==='tool_call'||message.method==='session/request_permission'))state.tools++;
        }previous(message);
      };}return endpoint;
    }});
    await managed.connect();const probe=await managed.probe(namespace);
    result.targetFingerprint=probe.contextFingerprint;
    result.summary.requiredCapabilitiesUnverified=['typedVisibleOutput','messageAssembly','humanInteraction'].every(name=>probe.capabilities[name as keyof typeof probe.capabilities]==='unverified');
    if(probe.cliVersion)result.summary.cliVersion=probe.cliVersion;
    if(input.phase==='seed'){
      for(let i=0;i<2;i++){
        const ownerRef=randomUUID(),receipt=await managed.createSession({operationId:randomUUID(),courierSessionId:ownerRef}).receipt;
        if(receipt.status!=='accepted')return result;contexts.push({ownerRef,sessionRef:receipt.sessionRef,marker:`CourierManagedProcess-${randomUUID()}`});
        store.set('probe-original',{status:'dispatching',contexts});
      }
    }
    let bothExact=true,bothScoped=true,bothEndTurn=true,nativeEndTurn=true,noTools=true;
    for(const [index,context] of contexts.entries()){
      if(input.phase!=='seed'){
        const receipt=await managed.resumeSession({operationId:randomUUID(),sessionRef:context.sessionRef}).receipt;
        if(receipt.status!=='accepted'||receipt.sessionRef!==context.sessionRef)return result;
      }
      const events:HarnessEvent[]=[],messages=new Map<string,string>();let settle!:(event?:HarnessEvent)=>void;
      const end=new Promise<HarnessEvent|undefined>(resolve=>{settle=resolve;}),timer=setTimeout(()=>settle(),75000);
      const unsubscribe=managed.subscribe(context.sessionRef,event=>{
        if(events.length<4096)events.push(event);else{boundedTrace=false;settle();}
        if(['run.completed','run.failed','connection.lost','input.requested'].includes(event.eventType))settle(event);
      });
      try{
        const receipt=await managed.start({sessionRef:context.sessionRef,operationId:randomUUID(),inputId:randomUUID(),clientRunId:randomUUID(),
          text:input.phase==='seed'?`Remember this exact synthetic context marker for later turns: ${context.marker}. Do not use tools, files or network access. Reply only with that marker.`:
            'Without tools, files or network access, reply only with the exact synthetic context marker you remembered in this Harness session. This input does not repeat the marker.'}).receipt;
        if(receipt.status!=='accepted'||receipt.sessionRef!==context.sessionRef||!receipt.runRef)return result;
        const terminal=await end;
        for(const event of events)if(event.eventType==='message.fragment'){
          const text=(messages.get(event.payload.messageId)??'')+event.payload.text;if(text.length>65536){boundedTrace=false;break;}messages.set(event.payload.messageId,text);
        }
        bothExact&&=[...messages.values()].some(text=>text.trim()===context.marker)&&![...messages.values()].some(text=>text.includes(contexts[1-index]!.marker));
        bothScoped&&=events.every(event=>event.sessionRef===context.sessionRef&&event.runRef===receipt.runRef);
        bothEndTurn&&=terminal?.eventType==='run.completed'&&terminal.payload.stopReason==='end_turn';
        nativeEndTurn&&=raw.get(context.sessionRef)?.stop==='end_turn';noTools&&=raw.get(context.sessionRef)?.tools===0;totalEvents+=events.length;
      }finally{clearTimeout(timer);unsubscribe();}
      if(!bothExact||!bothScoped||!bothEndTurn||!nativeEndTurn||!noTools||!boundedTrace)return result;
    }
    const snapshots=contexts.map(context=>{
      const host=record(managedRuntimeStore(store,context.ownerRef,true).get('desktop-host'));
      return snapshotSchema.parse({sessionRef:context.sessionRef,ownerRef:context.ownerRef,hostRef:host['sessionRef'],identity:host['processIdentity']});
    });
    result.contexts=[snapshots[0]!,snapshots[1]!];
    const keys=db.prepare('SELECT mappingKey FROM adapter_mappings WHERE namespace=? LIMIT 8193').all(namespace) as {mappingKey:string}[];
    if(keys.length>8192)return result;
    const operations=(owner:string)=>keys.filter(({mappingKey:key})=>{
      if(!key.startsWith('managed-runtime:'))return false;
      try{const parsed=JSON.parse(key.slice('managed-runtime:'.length));return Array.isArray(parsed)&&parsed[0]===owner&&typeof parsed[1]==='string'&&parsed[1].startsWith('desktop-host-operation:');}catch{return false;}
    }).length;
    result.summary={...result.summary,bothExact,bothScoped,bothEndTurn,nativeEndTurn,noTools,completeTrace:boundedTrace,actualUserCreates:actualCreates,
      configuredTargetStable:(await managed.probe(namespace)).contextFingerprint===probe.contextFingerprint,
      userContextCount:keys.filter(({mappingKey:key})=>key.startsWith('session:')&&typeof record(store.get(key))['courierSessionId']==='string').length,
      aHostOperations:operations(contexts[0]!.ownerRef),bHostOperations:operations(contexts[1]!.ownerRef),events:totalEvents,frames:totalFrames};
    result.status='observed';if(!successful(result)||result.summary.actualUserCreates!==(input.phase==='seed'?2:0)||
      result.summary.aHostOperations!==(input.phase==='replace'?2:1)||result.summary.bHostOperations!==1)result.status='unverified';
    if(result.status==='observed'){
      await managed.disconnect(namespace);managed=undefined;
      if(input.phase==='seed')store.set('probe-original',{status:'complete',contexts});store.set(step,{status:'complete'});
    }
    return result;
  }catch{return {...result,status:'unverified'};}
  finally{await managed?.disconnect(namespace).catch(()=>{});db?.close();release?.();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv.length!==3||process.argv[2]!=='--internal-managed-process-worker'||!process.send){process.stderr.write('需要显式独立探测父进程。\n');process.exit(2);}
  process.once('message',value=>{void(async()=>{const parsed=inputSchema.safeParse(value),result=parsed.success?await worker(parsed.data):empty();
    process.send!(result,()=>process.exit(result.status==='observed'?0:3));})();});
}
