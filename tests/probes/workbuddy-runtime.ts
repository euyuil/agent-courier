import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join,isAbsolute } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { z } from 'zod';
import { assertOutsideRepository } from '../../src/config/private.js';
import { connectWorkBuddy } from '../../src/adapters/workbuddy-experimental/factory.js';
import { desktopBootstrapReady } from '../../src/adapters/workbuddy-experimental/authentication.js';
import { bootstrapProvenance } from '../../src/adapters/workbuddy-experimental/bootstrap-provenance.js';
import { inspectRuntimeProcess,type RuntimeProcessIdentity } from '../../src/adapters/workbuddy-experimental/runtime-discovery.js';
import { internalFrame,record } from '../../src/adapters/workbuddy-experimental/metadata.js';
import { openDatabase,type Connection } from '../../src/storage/database.js';
import { migrate } from '../../src/storage/migrate.js';
import { adapterMappings } from '../../src/storage/adapter-mappings.js';
import { acquireInstanceLock } from '../../src/storage/instance-lock.js';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';

const namespace='independent-automatic-runtime',recall='Without tools, files or network access, reply only with the exact synthetic context marker you were asked to remember in this Harness session. The marker is not repeated in this input.';
const phaseSchema=z.enum(['seed','reuse','replace']);
const inputSchema=z.strictObject({enableIndependentRuntimeProbe:z.literal(true),workspace:z.string().min(1),desktopDebugUrl:z.string().url(),phase:phaseSchema});
type WorkerInput=z.infer<typeof inputSchema>;
const identitySchema=z.strictObject({pid:z.number().int().positive(),startTime:z.string().regex(/^\d+$/),bootId:z.string().uuid()});
const summarySchema=z.strictObject({accepted:z.boolean(),completed:z.boolean(),endTurn:z.boolean(),exactContext:z.boolean(),
  scoped:z.boolean(),completeTrace:z.boolean(),noTools:z.boolean(),sameOriginalContext:z.boolean(),sameBootstrap:z.boolean(),
  distinctReplacement:z.boolean(),events:z.number().int().min(0).max(4096),hostCreations:z.number().int().min(0),
  requiredCapabilitiesUnverified:z.boolean(),cliVersion:z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/).optional()});
const resultSchema=z.strictObject({status:z.enum(['observed','unverified']),summary:summarySchema,
  hostRef:z.string().min(1).max(1024).optional(),processIdentity:identitySchema.optional()});
export type RuntimeWorkerResult=z.infer<typeof resultSchema>;
export type RuntimeWorkerExit={result:RuntimeWorkerResult;pid:number;exitedNormally:boolean};
interface Diagnostic {evaluate(expression:string,timeout?:number):Promise<unknown>}
export interface RuntimeExperimentServices {
  worker(input:WorkerInput):Promise<RuntimeWorkerExit>;
  ready(hostRef:string):Promise<boolean>;
  shutdown(hostRef:string):Promise<boolean>;
  inspect(identity:RuntimeProcessIdentity):Promise<'alive'|'ended'|'unknown'>;
  pause():Promise<void>;
}
function emptyResult():RuntimeWorkerResult {return {status:'unverified',summary:{accepted:false,completed:false,endTurn:false,exactContext:false,
  scoped:false,completeTrace:false,noTools:false,sameOriginalContext:false,sameBootstrap:false,distinctReplacement:false,events:0,
  hostCreations:0,requiredCapabilitiesUnverified:false}};}
function successful(result:RuntimeWorkerResult):boolean {
  const s=result.summary;
  return result.status==='observed'&&!!result.hostRef&&!!result.processIdentity&&s.accepted&&s.completed&&s.endTurn&&s.exactContext&&
    s.scoped&&s.completeTrace&&s.noTools&&s.sameOriginalContext&&s.requiredCapabilitiesUnverified;
}
// 必须等子进程真正结束后才返回；超时只关闭本次探测子进程，不重发任何 Harness 操作。
export async function runRuntimeWorker(input:WorkerInput):Promise<RuntimeWorkerExit> {
  const result=emptyResult();
  return new Promise(resolve=>{
    const child=fork(fileURLToPath(import.meta.url),['--internal-runtime-worker'],{stdio:['ignore','ignore','ignore','ipc'],execArgv:[]});
    let observed=result,normal=false;
    const timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},120000);
    child.on('message',value=>{
      try{if(JSON.stringify(value).length>16384)return;const parsed=resultSchema.safeParse(value);if(parsed.success)observed=parsed.data;}catch{}
    });
    child.on('error',()=>{});
    child.once('exit',(code,signal)=>{normal=code===0&&signal===null;});
    child.once('close',()=>{clearTimeout(timer);resolve({result:observed,pid:child.pid??0,exitedNormally:normal});});
    child.send(input,error=>{if(error)try{child.kill('SIGKILL');}catch{}});
  });
}
function defaultServices(diagnostic:Diagnostic,desktopDebugUrl:string,workspace:string):Omit<RuntimeExperimentServices,'worker'> {
  return {
    ready:async host=>{
      const db=openDatabase(join(workspace,'runtime-probe.sqlite'));
      try {
        const proof=bootstrapProvenance(adapterMappings(db,namespace),host);
        return await desktopBootstrapReady(desktopDebugUrl,workspace,host,fetch,WebSocket,proof);
      }finally{db.close();}
    },
    shutdown:async host=>(await diagnostic.evaluate(`(async()=>{try{
      const s=await globalThis.__wbInvoke('session:get',{},${JSON.stringify(host)});
      if(s?.__wbError||s?.sessionId!==${JSON.stringify(host)}||s.cwd!==${JSON.stringify(workspace)}||s.isProcessing!==false)return false;
      for(const key of ['pendingPermissions','pendingQuestions','pendingElicitations'])if(!Array.isArray(s[key])||s[key].length)return false;
      const r=await globalThis.__wbInvoke('session:destroy',{},s.sessionId);return r===undefined||r===null||r===true;
    }catch{return false;}})()`,15000))===true,
    inspect:async identity=>inspectRuntimeProcess(identity),pause:()=>new Promise(resolve=>setTimeout(resolve,100)),
  };
}
export async function automaticRuntimeExperiment(diagnostic:Diagnostic,desktopDebugUrl:string,workspace:string,services?:RuntimeExperimentServices):Promise<Record<string,unknown>> {
  const report:Record<string,unknown>={status:'unverified',executionPermissionApprovals:0,dingtalkSends:0};
  const processes=new Set<number>();
  try {
    const api=services??{worker:runRuntimeWorker,...defaultServices(diagnostic,desktopDebugUrl,workspace)};
    const run=async(phase:WorkerInput['phase'])=>{
      const exit=await api.worker({enableIndependentRuntimeProbe:true,workspace,desktopDebugUrl,phase});
      const parsed=resultSchema.safeParse(exit.result);
      if(!exit.exitedNormally||!Number.isSafeInteger(exit.pid)||exit.pid<1||processes.has(exit.pid)||!parsed.success)return undefined;
      processes.add(exit.pid);report[phase]=parsed.data.summary;return parsed.data;
    };
    const seed=await run('seed');if(!seed||!successful(seed)||seed.summary.hostCreations!==1)return report;
    const reuse=await run('reuse');
    if(!reuse||!successful(reuse)||!reuse.summary.sameBootstrap||reuse.summary.hostCreations!==1||reuse.hostRef!==seed.hostRef||
      JSON.stringify(reuse.processIdentity)!==JSON.stringify(seed.processIdentity))return report;
    report['separateProcessOriginalContextRestored']=true;
    if(!await api.ready(reuse.hostRef!))return report;
    report['normalIdleShutdown']=await api.shutdown(reuse.hostRef!);if(report['normalIdleShutdown']!==true)return report;
    let state=await api.inspect(reuse.processIdentity!);
    for(let i=0;i<30&&state==='alive';i++){await api.pause();state=await api.inspect(reuse.processIdentity!);}
    report['oldProcessDeathProven']=state==='ended';if(state!=='ended')return report;
    const replaced=await run('replace');
    if(!replaced||!successful(replaced)||!replaced.summary.distinctReplacement||replaced.summary.sameBootstrap||replaced.summary.hostCreations!==2||
      replaced.hostRef===seed.hostRef)return report;
    report['status']='observed';report['separateWorkerProcesses']=processes.size;return report;
  }catch{return {...report,error:'automatic_runtime_observation_unavailable'};}
}

async function worker(input:WorkerInput):Promise<RuntimeWorkerResult> {
  const result=emptyResult();let db:Connection|undefined,release:(()=>void)|undefined,connected:Awaited<ReturnType<typeof connectWorkBuddy>>|undefined;
  try {
    if(!isAbsolute(input.workspace))return result;assertOutsideRepository(input.workspace);
    const debug=new URL(input.desktopDebugUrl);
    if(debug.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(debug.hostname)||debug.username||debug.password||debug.search||debug.hash)return result;
    const path=join(input.workspace,'runtime-probe.sqlite');release=acquireInstanceLock(path);db=openDatabase(path);migrate(db);
    const store=adapterMappings(db,namespace);
    const key=`probe-step:${input.phase}`;if(store.get(key)!==undefined)return result;
    const original=record(store.get('probe-context'));
    if(input.phase==='seed'?Object.keys(original).length>0:original['status']!=='complete')return result;
    if(input.phase!=='seed'&&record(store.get(`probe-step:${input.phase==='reuse'?'seed':'reuse'}`))['status']!=='complete')return result;
    store.set(key,{status:'dispatching'});
    connected=await connectWorkBuddy({profile:{cwd:input.workspace,cliVersion:null,authorizationScope:[],desktopDebugUrl:input.desktopDebugUrl,
      ownership:{mode:'courier-exclusive'},output:{mode:'acp-text'}},store,instanceId:namespace,evidence:[]});
    const {adapter,connection}=connected,host=record(store.get('desktop-host'));
    result.hostRef=typeof host['sessionRef']==='string'?host['sessionRef']:undefined;
    const identity=identitySchema.safeParse(host['processIdentity']);if(identity.success)result.processIdentity=identity.data;
    const probe=await adapter.probe(namespace);result.summary.requiredCapabilitiesUnverified=
      ['typedVisibleOutput','messageAssembly','humanInteraction'].every(name=>probe.capabilities[name as keyof typeof probe.capabilities]==='unverified');
    if(probe.cliVersion)result.summary.cliVersion=probe.cliVersion;
    if(!result.hostRef||!result.processIdentity)return result;
    let sessionRef:string,marker:string;
    if(input.phase==='seed') {
      const receipt=await adapter.createSession({operationId:randomUUID(),courierSessionId:randomUUID()}).receipt;
      if(receipt.status!=='accepted'||!receipt.receiptEvidence||receipt.sessionRef===result.hostRef)return result;
      sessionRef=receipt.sessionRef;marker=`CourierProcessContext-${randomUUID()}`;
      store.set('probe-context',{status:'dispatching',sessionRef,marker,hostRef:result.hostRef});
    }else {
      if(typeof original['sessionRef']!=='string'||typeof original['marker']!=='string'||typeof original['hostRef']!=='string')return result;
      sessionRef=original['sessionRef'];marker=original['marker'];
      const receipt=await adapter.resumeSession({operationId:randomUUID(),sessionRef}).receipt;
      if(receipt.status!=='accepted'||receipt.sessionRef!==sessionRef||!receipt.receiptEvidence)return result;
    }
    result.summary.sameOriginalContext=input.phase==='seed'||sessionRef===original['sessionRef'];
    result.summary.sameBootstrap=input.phase==='seed'||result.hostRef===original['hostRef'];
    result.summary.distinctReplacement=input.phase==='replace'&&result.hostRef!==original['hostRef']&&result.hostRef!==sessionRef;
    const events:HarnessEvent[]=[],messages=new Map<string,string>();let tools=0,frames=0,bytes=0,bounded=true,settle!:(event?:HarnessEvent)=>void;
    const terminal=new Promise<HarnessEvent|undefined>(resolve=>{settle=resolve;}),timer=setTimeout(()=>settle(),90000);
    const consume=connection.onMessage;connection.onMessage=message=>{
      frames++;bytes+=JSON.stringify(message).length;
      if(frames>4096||bytes>8388608){bounded=false;settle();}
      const params=record(message.params),update=record(params['update']);
      if(params['sessionId']===sessionRef&&!internalFrame(params,update)&&update['sessionUpdate']==='tool_call')tools++;
      consume(message);
    };
    const unsubscribe=adapter.subscribe(sessionRef,event=>{
      if(events.length<4096)events.push(event);else{bounded=false;settle();}
      if(['run.completed','run.failed','connection.lost','input.requested'].includes(event.eventType))settle(event);
    });
    try {
      const receipt=await adapter.start({operationId:randomUUID(),inputId:randomUUID(),sessionRef,clientRunId:randomUUID(),
        text:input.phase==='seed'?`Remember this exact synthetic context marker for later turns: ${marker}. Do not use tools, files or network access. Reply only with that marker.`:recall}).receipt;
      if(receipt.status!=='accepted'||receipt.sessionRef!==sessionRef||!receipt.runRef||!receipt.receiptEvidence)return result;
      result.summary.accepted=true;const end=await terminal;
      for(const event of events)if(event.eventType==='message.fragment'){
        const text=(messages.get(event.payload.messageId)??'')+event.payload.text;
        if(text.length>65536){bounded=false;break;}messages.set(event.payload.messageId,text);
      }
      result.summary.completed=end?.eventType==='run.completed'&&end.runRef===receipt.runRef;
      result.summary.endTurn=end?.eventType==='run.completed'&&end.payload.stopReason==='end_turn';
      result.summary.exactContext=[...messages.values()].some(text=>text.trim()===marker);
      result.summary.scoped=events.every(event=>event.sessionRef===sessionRef&&event.runRef===receipt.runRef);
      result.summary.completeTrace=bounded;result.summary.noTools=tools===0;result.summary.events=events.length;
      result.summary.hostCreations=Number((db.prepare("SELECT count(*) n FROM adapter_mappings WHERE namespace=? AND mappingKey LIKE 'desktop-host-operation:%'").get(namespace) as {n:number}).n);
      result.status='observed';if(!successful(result))result.status='unverified';
      if(result.status==='observed'){
        if(input.phase==='seed')store.set('probe-context',{status:'complete',sessionRef,marker,hostRef:result.hostRef});
        store.set(key,{status:'complete'});
      }
    }finally{clearTimeout(timer);unsubscribe();}
    return result;
  }catch{return result.status==='observed'?{...result,status:'unverified'}:result;}
  finally{await connected?.adapter.disconnect(namespace).catch(()=>{});db?.close();release?.();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv.length!==3||process.argv[2]!=='--internal-runtime-worker'||!process.send){process.stderr.write('需要显式独立探测父进程。\n');process.exit(2);}
  process.once('message',value=>{void(async()=>{
    const parsed=inputSchema.safeParse(value),result=parsed.success?await worker(parsed.data):emptyResult();
    process.send!(result,()=>process.exit(result.status==='observed'?0:3));
  })();});
}
