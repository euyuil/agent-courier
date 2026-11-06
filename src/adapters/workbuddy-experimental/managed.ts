import { randomUUID } from 'node:crypto';
import type { HarnessPort,ProbeReport,OperationInput,SessionInput,StartInput,SteerInput,AnswerInput,CommandHandle,Inspection,Receipt } from '../harness/port.js';
import type { HarnessEvent } from '../harness/events.js';
import type { MappingStore } from '../../storage/adapter-mappings.js';
import { CourierError } from '../../domain/errors.js';
import { normalizeReceipt } from '../harness/receipt.js';
import { record } from './metadata.js';
import { ManagedOperations } from './managed-operations.js';
import { connectWorkBuddy,type WorkBuddyFactoryInput } from './factory.js';
import { managedRuntimeStore } from './managed-runtime.js';

export interface ManagedEndpoint {adapter:HarnessPort;connection:{readonly connected:boolean}}
export interface ManagedOptions {store:MappingStore;instanceId:string;isolateRuntimes?:boolean;connect(contextSessionRef?:string,courierSessionId?:string):Promise<ManagedEndpoint>}
interface Context {endpoint:ManagedEndpoint;ready:boolean;lost:boolean;unsubscribe:()=>void}
export class ManagedWorkBuddy implements HarnessPort {
  private root:ManagedEndpoint|undefined;
  private rootOwner:string|undefined;
  private probeSource:ManagedEndpoint|undefined;
  private readonly contexts=new Map<string,Context>();
  private readonly opening=new Map<string,Promise<Receipt>>();
  private readonly listeners=new Map<string,Set<(event:HarnessEvent)=>void>>();
  private readonly inflight=new Set<Promise<Receipt>>();
  private readonly owned=new Set<ManagedEndpoint>();
  private readonly operations:ManagedOperations;
  private managementTail:Promise<void>=Promise.resolve();
  private closed=false;
  private closing:Promise<void>|undefined;
  constructor(private readonly options:ManagedOptions){this.operations=new ManagedOperations(options.store);}
  private owns(ref:string):boolean {const owner=record(this.options.store.get(`session:${ref}`))['courierSessionId'];return typeof owner==='string'&&!!owner;}
  private run(ref:string):Record<string,unknown> {
    const raw=this.options.store.get(`managed-run:${ref}`);if(raw===undefined)return {status:'idle'};
    const value=record(raw);
    return value['schemaVersion']===1&&['idle','dispatching','running','unknown'].includes(String(value['status']))&&
      ['operationId','clientRunId','inputId'].every(key=>typeof value[key]==='string'&&value[key])&&
      (value['status']!=='running'&&value['status']!=='idle'||typeof value['runRef']==='string'&&!!value['runRef']||value['notStarted']===true)?value:{status:'unknown'};
  }
  private saveRun(ref:string,state:Record<string,unknown>):void{this.options.store.set(`managed-run:${ref}`,{...state,schemaVersion:1});}
  private async management(courierSessionId?:string):Promise<ManagedEndpoint> {
    if(this.closed)throw new CourierError('recovery_interrupted');
    const owner=this.options.isolateRuntimes?courierSessionId:undefined;
    if(owner){
      const key=`managed-host-scope:${owner}`,raw=this.options.store.get(key);
      if(raw!==undefined&&record(raw)['mode']!=='isolated')throw new CourierError('state_unknown');
      if(raw===undefined)this.options.store.set(key,{mode:'isolated'});
    }
    if(this.root?.connection.connected){
      if(this.rootOwner===owner)return this.root;
      const previous=this.root;this.root=undefined;await this.closeEndpoint(previous);
    }
    const root=await this.options.connect(undefined,owner);this.owned.add(root);if(this.closed){await this.closeEndpoint(root);throw new CourierError('recovery_interrupted');}
    this.root=root;this.rootOwner=owner;this.probeSource=root;return root;
  }
  async connect():Promise<void>{await this.management();}
  private async closeEndpoint(endpoint:ManagedEndpoint):Promise<void> {
    try{await endpoint.adapter.disconnect(this.options.instanceId);}
    finally{if(!endpoint.connection.connected)this.owned.delete(endpoint);}
    if(endpoint.connection.connected)throw new CourierError('state_unknown');
  }
  async probe(instanceId:string):Promise<ProbeReport> {
    if(!this.probeSource)throw new CourierError('unconfigured');
    if(!this.root?.connection.connected&&![...this.contexts.values()].some(value=>value.ready&&!value.lost&&value.endpoint.connection.connected)&&this.opening.size)
      await Promise.allSettled([...this.opening.values()]);
    const base=await this.probeSource.adapter.probe(instanceId);
    base.capabilities={...base.capabilities,inspectOperation:'unsupported',replayEvents:'unsupported',serverIdempotency:'unsupported'};
    if(this.closed||instanceId!==this.options.instanceId)return {...base,authenticationStatus:'unknown'};
    if(this.root?.connection.connected)return base;
    const context=[...this.contexts.values()].find(value=>value.ready&&!value.lost&&value.endpoint.connection.connected);
    if(!context)return {...base,authenticationStatus:'unknown'};
    const current=await context.endpoint.adapter.probe(instanceId);
    if(current.productVersion!==base.productVersion||current.cliVersion!==base.cliVersion)return {...base,authenticationStatus:'unknown'};
    const capabilities={...base.capabilities};
    for(const key of Object.keys(capabilities) as (keyof typeof capabilities)[])if(current.capabilities[key]==='unsupported')capabilities[key]='unsupported';
    return {...base,capabilities,authenticationStatus:current.authenticationStatus};
  }
  private handle(kind:'create'|'load'|'start'|'steer'|'answer',input:OperationInput,work:()=>Promise<Receipt>):CommandHandle {
    if(this.closed)return {operationId:input.operationId,receipt:Promise.resolve({status:'unknown',errorCode:'recovery_interrupted'})};
    const handle=this.operations.execute(kind,input,work);this.inflight.add(handle.receipt);
    void handle.receipt.finally(()=>this.inflight.delete(handle.receipt)).catch(()=>{});return handle;
  }
  private relay(ref:string,context:Context,event:HarnessEvent):void {
    if(this.closed||this.contexts.get(ref)!==context||context.lost||event.sessionRef!==ref)return;
    let state=this.run(ref);
    if(event.eventType==='run.started'){
      if(state['clientRunId']!==event.payload.clientRunId||typeof state['operationId']!=='string')return;
      if(state['status']==='idle'&&state['runRef']===event.runRef)return;
      const receipt:Receipt={status:'accepted',sessionRef:ref,runRef:event.runRef,receiptEvidence:`source-event:${event.eventKey}`};
      if(!this.operations.accepted(state['operationId'],receipt)){this.saveRun(ref,{...state,status:'unknown'});return;}
      state={...state,status:'running',runRef:event.runRef};this.saveRun(ref,state);
    }else if(event.eventType==='input.applied'||event.eventType==='input.accepted'){
      const operationId=event.eventType==='input.accepted'?event.payload.operationId:this.operations.inputOperation(ref,event.payload.inputId);
      if(!operationId||this.operations.inputId(operationId)!==event.payload.inputId)return;
      const extra=event.eventType==='input.accepted'?record(this.options.store.get(`managed-answer:${operationId}`)):{};
      if(!this.operations.accepted(operationId,{status:'accepted',sessionRef:ref,runRef:event.runRef,
        receiptEvidence:event.eventType==='input.applied'?event.payload.appliedEvidence:event.payload.receiptEvidence,
        ...(typeof extra['vendorRequestId']==='string'?{vendorRequestId:extra['vendorRequestId']}:{})}))return;
    }else {
      if(state['runRef']!==event.runRef)return;
      if(event.eventType==='connection.lost'){
        context.lost=true;context.ready=false;this.saveRun(ref,{...state,status:'unknown'});
      }else if(event.eventType==='run.completed'||event.eventType==='run.failed'){
        if(event.payload.completionEvidence)this.saveRun(ref,{...state,status:'idle'});
      }
    }
    for(const listener of this.listeners.get(ref)??[])listener(event);
  }
  private prepare(ref:string,operationId:string,activateRuntime=true):Promise<Receipt> {
    const pending=this.opening.get(ref);if(pending)return pending;
    const work=(async():Promise<Receipt>=>{
      if(this.closed)return {status:'unknown',errorCode:'recovery_interrupted'};
      if(!this.owns(ref))return {status:'rejected',errorCode:'request_invalid',definitelyNotAccepted:true};
      const state=this.run(ref),old=this.contexts.get(ref);
      if(state['status']!=='idle')return {status:'unknown',errorCode:'state_unknown'};
      if(old?.ready&&!old.lost&&old.endpoint.connection.connected)return {status:'accepted',sessionRef:ref,receiptEvidence:'workbuddy:managed:existing-context'};
      if(old){old.unsubscribe();await this.closeEndpoint(old.endpoint);this.contexts.delete(ref);}
      const owner=record(this.options.store.get(`session:${ref}`))['courierSessionId'];
      if(activateRuntime&&this.options.isolateRuntimes&&typeof owner==='string'&&record(this.options.store.get(`managed-owner:${owner}`))['runtimeIsolation']===true){
        if(record(this.options.store.get(`managed-host-scope:${owner}`))['mode']!=='isolated')return {status:'unknown',errorCode:'state_unknown'};
        const activation=this.managementTail.then(async()=>{
          const root=await this.management(owner);
          try{if(this.closed)throw new CourierError('recovery_interrupted');}
          finally{this.root=undefined;await this.closeEndpoint(root);}
        });
        this.managementTail=activation.then(()=>{},()=>{});
        try{await activation;}catch{return {status:'unknown',errorCode:'state_unknown'};}
      }
      let endpoint:ManagedEndpoint;
      try{endpoint=await this.options.connect(ref);this.owned.add(endpoint);}catch{return {status:'unknown',errorCode:'state_unknown'};}
      if(this.closed){await this.closeEndpoint(endpoint);return {status:'unknown',errorCode:'recovery_interrupted'};}
      const context:Context={endpoint,ready:false,lost:false,unsubscribe:()=>{}};this.contexts.set(ref,context);
      context.unsubscribe=endpoint.adapter.subscribe(ref,event=>this.relay(ref,context,event));
      let receipt:Receipt;
      try{receipt=normalizeReceipt(await endpoint.adapter.resumeSession({operationId,sessionRef:ref}).receipt,{sessionRef:ref});}
      catch{receipt={status:'unknown',errorCode:'state_unknown'};}
      if(receipt.status==='accepted'&&!this.closed&&endpoint.connection.connected&&!context.lost)context.ready=true;
      else if(receipt.status==='accepted')receipt={status:'unknown',errorCode:'state_unknown'};
      return receipt;
    })().finally(()=>{this.opening.delete(ref);});
    this.opening.set(ref,work);return work;
  }
  createSession(input:OperationInput&{courierSessionId:string}):CommandHandle {
    return this.handle('create',input,async()=>{
      const ownerKey=`managed-owner:${input.courierSessionId}`,prior=record(this.options.store.get(ownerKey));
      if(prior['operationId']!==undefined&&prior['operationId']!==input.operationId&&prior['status']!=='rejected')return {status:'unknown',errorCode:'state_unknown'};
      const runtimeIsolation=this.options.isolateRuntimes===true;
      this.options.store.set(ownerKey,{operationId:input.operationId,status:'dispatching',runtimeIsolation});
      const create=this.managementTail.then(async():Promise<Receipt>=>{
        if(this.closed)return {status:'unknown',errorCode:'recovery_interrupted'};
        const root=await this.management(input.courierSessionId);
        try{
          const receipt=normalizeReceipt(await root.adapter.createSession(input).receipt);
          if(receipt.status==='accepted')this.options.store.set(ownerKey,{operationId:input.operationId,status:'created',sessionRef:receipt.sessionRef,receipt,runtimeIsolation});
          return receipt;
        }finally{this.root=undefined;await this.closeEndpoint(root);}
      });
      this.managementTail=create.then(()=>{},()=>{});
      let receipt:Receipt;try{receipt=await create;}catch{return {status:'unknown',errorCode:'state_unknown'};}
      if(receipt.status!=='accepted'){
        this.options.store.set(ownerKey,{operationId:input.operationId,status:receipt.status,runtimeIsolation});return receipt;
      }
      if(record(this.options.store.get(`session:${receipt.sessionRef}`))['courierSessionId']!==input.courierSessionId)return {status:'unknown',errorCode:'protocol_conflict'};
      this.options.store.set(ownerKey,{operationId:input.operationId,status:'created',sessionRef:receipt.sessionRef,receipt,runtimeIsolation});
      const prepared=await this.prepare(receipt.sessionRef,randomUUID(),false);
      return prepared.status==='accepted'?receipt:{status:'unknown',errorCode:prepared.errorCode};
    });
  }
  resumeSession(input:SessionInput):CommandHandle{return this.handle('load',input,()=>this.prepare(input.sessionRef,input.operationId));}
  start(input:StartInput):CommandHandle {
    return this.handle('start',input,async()=>{
      if(!this.owns(input.sessionRef))return {status:'rejected',errorCode:'request_invalid',definitelyNotAccepted:true};
      const state=this.run(input.sessionRef);if(state['status']!=='idle')return {status:'unknown',errorCode:'state_unknown'};
      const prepared=await this.prepare(input.sessionRef,randomUUID());
      if(prepared.status!=='accepted')return {status:'rejected',errorCode:prepared.errorCode,definitelyNotAccepted:true};
      if(this.run(input.sessionRef)['status']!=='idle')return {status:'rejected',errorCode:'writer_occupied',definitelyNotAccepted:true};
      const context=this.contexts.get(input.sessionRef)!;
      this.saveRun(input.sessionRef,{status:'dispatching',operationId:input.operationId,clientRunId:input.clientRunId,inputId:input.inputId});
      let receipt:Receipt;try{receipt=normalizeReceipt(await context.endpoint.adapter.start(input).receipt,{sessionRef:input.sessionRef,requiresRun:true});}
      catch{receipt={status:'unknown',errorCode:'state_unknown'};}
      const current=this.run(input.sessionRef);
      if(current['operationId']===input.operationId&&current['status']==='dispatching')this.saveRun(input.sessionRef,{...current,
        status:receipt.status==='accepted'?'running':receipt.status==='rejected'?'idle':'unknown',
        ...(receipt.status==='accepted'?{runRef:receipt.runRef}:receipt.status==='rejected'?{notStarted:true}:{})});
      return receipt;
    });
  }
  steer(input:SteerInput):CommandHandle {
    return this.handle('steer',input,async()=>{
      const context=this.contexts.get(input.sessionRef),state=this.run(input.sessionRef);
      if(!context?.ready||context.lost||!context.endpoint.connection.connected||state['status']!=='running'||state['runRef']!==input.expectedRunRef)return {status:'unknown',errorCode:'state_unknown'};
      return context.endpoint.adapter.steer(input).receipt;
    });
  }
  answer(input:AnswerInput):CommandHandle {
    return this.handle('answer',input,async()=>{
      const context=this.contexts.get(input.sessionRef),state=this.run(input.sessionRef);
      if(!context?.ready||context.lost||!context.endpoint.connection.connected||state['status']!=='running'||state['runRef']!==input.runRef)return {status:'unknown',errorCode:'state_unknown'};
      this.options.store.set(`managed-answer:${input.operationId}`,{vendorRequestId:input.vendorRequestId});return context.endpoint.adapter.answer(input).receipt;
    });
  }
  subscribe(sessionRef:string,listener:(event:HarnessEvent)=>void,cursor?:string):()=>void {
    if(cursor!==undefined)throw new CourierError('resume_unsupported');
    if(!this.owns(sessionRef))throw new CourierError('request_invalid');
    const listeners=this.listeners.get(sessionRef)??new Set();listeners.add(listener);this.listeners.set(sessionRef,listeners);
    return ()=>{listeners.delete(listener);if(!listeners.size)this.listeners.delete(sessionRef);};
  }
  async inspect():Promise<Inspection>{return {status:'unsupported'};}
  disconnect(_instanceId:string):Promise<void> {
    if(this.closing)return this.closing;this.closed=true;
    const close=async()=>{
      for(const [ref,context] of this.contexts){const state=this.run(ref);if(state['status']!=='idle')this.saveRun(ref,{...state,status:'unknown'});context.ready=false;}
      const results=await Promise.allSettled([...this.owned].map(endpoint=>this.closeEndpoint(endpoint)));
      await Promise.allSettled([...this.opening.values(),this.managementTail,...this.inflight]);
      const late=await Promise.allSettled([...this.owned].map(endpoint=>this.closeEndpoint(endpoint)));
      for(const context of this.contexts.values())context.unsubscribe();this.listeners.clear();
      if(this.owned.size||[...results,...late].some(result=>result.status==='rejected'))throw new CourierError('state_unknown');
    };
    this.closing=close();return this.closing;
  }
}
export function workBuddyManagedOptions(input:Omit<WorkBuddyFactoryInput,'contextSessionRef'|'role'>) {
  if(!input.profile.ownership)throw new CourierError('configuration_invalid');
  const isolateRuntimes=!input.profile.ownership.bootstrapSessionRef;
  return {store:input.store,instanceId:input.instanceId,isolateRuntimes,connect:(ref?:string,owner?:string)=>{
    const courierSessionId=ref?record(input.store.get(`session:${ref}`))['courierSessionId']:owner;
    if(courierSessionId!==undefined&&(typeof courierSessionId!=='string'||!courierSessionId))throw new CourierError('state_unknown');
    const required=ref!==undefined&&courierSessionId!==undefined&&record(input.store.get(`managed-owner:${courierSessionId}`))['runtimeIsolation']===true;
    return connectWorkBuddy({...input,runtimeStore:isolateRuntimes?managedRuntimeStore(input.store,courierSessionId,required):input.store,
      ...(ref?{contextSessionRef:ref}:{role:'managed'})});
  }};
}
export async function connectManagedWorkBuddy(input:Omit<WorkBuddyFactoryInput,'contextSessionRef'|'role'>):Promise<ManagedWorkBuddy> {
  const managed=new ManagedWorkBuddy(workBuddyManagedOptions(input));
  try{await managed.connect();return managed;}catch(error){await managed.disconnect(input.instanceId).catch(()=>{});throw error;}
}
