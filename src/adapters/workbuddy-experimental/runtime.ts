import { randomUUID } from 'node:crypto';
import type { ConnectionProfile } from '../../config/real-profiles.js';
import type { MappingStore } from '../../storage/adapter-mappings.js';
import { CourierError } from '../../domain/errors.js';
import { record,string } from './metadata.js';
import { createDesktopBootstrap,desktopBootstrapReady,desktopRuntimeRegistryDirectory,type DesktopBootstrapCreation } from './authentication.js';
import { discoverRuntime,inspectRuntimeProcess,type DiscoveredRuntime,type RuntimeProcessIdentity,type RuntimeProcessState } from './runtime-discovery.js';
import { bootstrapProvenance,type BootstrapRunProvenance } from './bootstrap-provenance.js';

type RuntimeProfile=Pick<ConnectionProfile,'endpoint'|'cwd'|'ownership'|'desktopDebugUrl'|'bootstrapPermissionMode'>;
export interface RuntimeServices {
  create(cwd:string,permissionMode?:'default'):Promise<DesktopBootstrapCreation>;
  ready(cwd:string,sessionRef:string,provenance?:readonly BootstrapRunProvenance[]):Promise<boolean>;
  discover(sessionRef:string):Promise<DiscoveredRuntime|undefined>;
  inspect(identity:RuntimeProcessIdentity):Promise<RuntimeProcessState>;
}
function savedIdentity(value:unknown):RuntimeProcessIdentity|undefined {
  if(value===undefined)return undefined;
  const identity=record(value);
  if(!Number.isSafeInteger(identity['pid'])||Number(identity['pid'])<1||typeof identity['startTime']!=='string'||!/^\d+$/.test(identity['startTime'])||!string(identity['bootId']))throw new CourierError('state_unknown');
  return {pid:Number(identity['pid']),startTime:String(identity['startTime']),bootId:String(identity['bootId'])};
}
export interface RuntimeResolution {endpoint:string;bootstrapSessionRef?:string;inspectCliVersion?:()=>Promise<string|undefined>}
export async function resolveWorkBuddyRuntime(profile:RuntimeProfile,store:MappingStore,services?:RuntimeServices,existingOnly=false):Promise<RuntimeResolution> {
  if(profile.bootstrapPermissionMode&&(!profile.ownership||profile.ownership.bootstrapSessionRef))throw new CourierError('configuration_invalid');
  if(!profile.ownership||profile.ownership.bootstrapSessionRef) {
    if(!profile.endpoint)throw new CourierError('configuration_invalid');
    return {endpoint:profile.endpoint,...(profile.ownership?{bootstrapSessionRef:profile.ownership.bootstrapSessionRef!}:{})};
  }
  if(!profile.desktopDebugUrl||profile.endpoint)throw new CourierError('configuration_invalid');
  const api=services??{create:(cwd:string,permissionMode?:'default')=>createDesktopBootstrap(profile.desktopDebugUrl!,cwd,fetch,WebSocket,permissionMode),
    ready:(cwd:string,ref:string,provenance?:readonly BootstrapRunProvenance[])=>desktopBootstrapReady(profile.desktopDebugUrl!,cwd,ref,fetch,WebSocket,provenance),
    discover:async(ref:string)=>{
      const directory=await desktopRuntimeRegistryDirectory(profile.desktopDebugUrl!);
      return discoverRuntime(ref,fetch,'/proc',directory?{directory,cwd:profile.cwd}:undefined);
    },inspect:async(identity:RuntimeProcessIdentity)=>inspectRuntimeProcess(identity)};
  const key='desktop-host',raw=store.get(key);let state=record(raw);
  if(raw!==undefined) {
    if(state['schemaVersion']!==1||state['cwd']!==profile.cwd||(state['bootstrapPermissionMode']??null)!==(profile.bootstrapPermissionMode??null))throw new CourierError('configuration_invalid');
    if(!['ready','not_created'].includes(String(state['status'])))throw new CourierError('state_unknown');
  }
  let retired:Record<string,unknown>|undefined;
  const previousIdentity=savedIdentity(state['processIdentity']);
  if(state['status']==='ready'&&previousIdentity) {
    const liveness=await api.inspect(previousIdentity).catch(()=>'unknown');
    if(liveness==='unknown')throw new CourierError('state_unknown');
    if(liveness==='ended') {
      if(existingOnly)throw new CourierError('unconfigured');
      if(!string(state['operationId'])||!string(state['sessionRef']))throw new CourierError('state_unknown');
      retired={...state,status:'retired'};
      store.set(`desktop-host-operation:${state['operationId']}`,retired);
    }
  }
  if(raw===undefined||state['status']==='not_created'||retired) {
    if(existingOnly)throw new CourierError('unconfigured');
    const previousOperationId=retired?.['operationId']??state['previousOperationId'],previousSessionRef=retired?.['sessionRef']??state['previousSessionRef'];
    const operationId=randomUUID(),intent={schemaVersion:1,cwd:profile.cwd,bootstrapPermissionMode:profile.bootstrapPermissionMode??null,operationId,status:'dispatching',
      ...(previousOperationId?{previousOperationId,previousSessionRef}:{})};
    const save=(next:Record<string,unknown>)=>{store.set(`desktop-host-operation:${operationId}`,next);store.set(key,next);};
    save(intent);
    let result:DesktopBootstrapCreation;
    try{result=await api.create(profile.cwd,profile.bootstrapPermissionMode);}catch{result={status:'unknown'};}
    if(result.status==='created'&&typeof result.sessionRef==='string'&&result.sessionRef&&result.sessionRef!==previousSessionRef)state={...intent,status:'ready',sessionRef:result.sessionRef};
    else state={...intent,status:result.status==='not_created'?'not_created':'unknown'};
    save(state);
    if(state['status']!=='ready')throw new CourierError(state['status']==='not_created'?'unconfigured':'state_unknown');
  }
  const ref=string(state['sessionRef']);if(!ref)throw new CourierError('state_unknown');
  if(await api.ready(profile.cwd,ref,bootstrapProvenance(store,ref)).catch(()=>false)!==true)throw new CourierError('unconfigured');
  const found=await api.discover(ref).catch(()=>undefined);if(!found)throw new CourierError('unconfigured');
  const identity=savedIdentity(found.processIdentity);if(!identity)throw new CourierError('state_unknown');
  if(!retired&&previousIdentity&&(previousIdentity.pid!==identity.pid||previousIdentity.startTime!==identity.startTime||previousIdentity.bootId!==identity.bootId))throw new CourierError('state_unknown');
  const next={...state,processIdentity:identity};
  store.set(`desktop-host-operation:${state['operationId']}`,next);store.set(key,next);
  return {endpoint:found.endpoint,bootstrapSessionRef:ref,inspectCliVersion:async()=>{
    if(await api.inspect(identity).catch(()=>'unknown')!=='alive')return undefined;
    const current=await api.discover(ref).catch(()=>undefined);
    return current&&current.endpoint===found.endpoint&&current.processIdentity.pid===identity.pid&&
      current.processIdentity.startTime===identity.startTime&&current.processIdentity.bootId===identity.bootId?current.cliVersion:undefined;
  }};
}
