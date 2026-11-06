import type { ConnectionProfile } from '../../config/real-profiles.js';
import type { MappingStore } from '../../storage/adapter-mappings.js';
import type { CapabilityEvidence } from '../../domain/capabilities.js';
import { WorkBuddyAdapter } from './session.js';
import { AcpConnection } from './connection.js';
import { resolveWorkBuddyRuntime,type RuntimeServices } from './runtime.js';
import { workbuddyConfiguration } from './profile.js';
import { desktopBootstrapReady,desktopStatus } from './authentication.js';
import { bootstrapProvenance } from './bootstrap-provenance.js';
import { CourierError } from '../../domain/errors.js';
import { record } from './metadata.js';

export type WorkBuddyConnectionProfile=Omit<ConnectionProfile,'cliVersion'>&{cliVersion:string|null};
export interface WorkBuddyFactoryInput {profile:WorkBuddyConnectionProfile;store:MappingStore;instanceId:string;evidence:CapabilityEvidence[];
  headers?:Record<string,string>;services?:RuntimeServices;contextSessionRef?:string;role?:'managed';runtimeStore?:MappingStore}
export async function connectWorkBuddy(input:WorkBuddyFactoryInput):Promise<{adapter:WorkBuddyAdapter;connection:AcpConnection}> {
  const {profile,store,instanceId,evidence}=input;
  const runtimeStore=input.runtimeStore??store;
  if(input.contextSessionRef!==undefined){
    const owner=record(store.get(`session:${input.contextSessionRef}`))['courierSessionId'];
    if(!input.contextSessionRef||!profile.ownership||typeof owner!=='string'||!owner)throw new CourierError('configuration_invalid');
    const host=profile.ownership.bootstrapSessionRef??record(runtimeStore.get('desktop-host'))['sessionRef'];
    if(typeof host!=='string'||host===input.contextSessionRef||record(store.get(`bootstrap:${host}`))['status']!=='accepted'||
      record(store.get(`session:${host}`))['kind']!=='courier_bootstrap')throw new CourierError('state_unknown');
  }
  const runtime=await resolveWorkBuddyRuntime(profile,runtimeStore,input.services,input.contextSessionRef!==undefined);
  const configured=workbuddyConfiguration(instanceId,{...profile,endpoint:runtime.endpoint,
    ...(input.contextSessionRef?{connectionRole:'context' as const}:input.role?{connectionRole:input.role}:{})});
  const connection=new AcpConnection({endpoint:runtime.endpoint,...(input.headers?{headers:input.headers}:{})});
  const adapter=new WorkBuddyAdapter({connection,store,cwd:profile.cwd,instanceId,...configured,evidence,
    ...(input.contextSessionRef?{contextSessionRef:input.contextSessionRef,
      ...(profile.bootstrapPermissionMode?{contextPermissionMode:profile.bootstrapPermissionMode}:{})}:{}),
    ...(runtime.inspectCliVersion?{runtimeVersion:runtime.inspectCliVersion}:{}),
    verifyOutputProfile:()=>profile.cliVersion!==null&&configured.verifyOutputProfile(),
    ...(profile.cliVersion!==null?{expectedCliVersion:profile.cliVersion}:{}),
    ...(runtime.bootstrapSessionRef?{bootstrapSessionRef:runtime.bootstrapSessionRef,
      verifyBootstrap:()=>{
        const provenance=bootstrapProvenance(store,runtime.bootstrapSessionRef!);
        return input.services?input.services.ready(profile.cwd,runtime.bootstrapSessionRef!,provenance):desktopBootstrapReady(profile.desktopDebugUrl!,profile.cwd,runtime.bootstrapSessionRef!,fetch,WebSocket,provenance);
      }}:{}),
    ...(profile.desktopDebugUrl?{identity:()=>desktopStatus(profile.desktopDebugUrl!)}:{})});
  try{await adapter.connect();return {adapter,connection};}
  catch(error){await adapter.disconnect(instanceId).catch(()=>{});throw error;}
}
