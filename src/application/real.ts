import { z } from 'zod';
import type { Config } from '../config/schema.js';
import { loadConfig } from '../config/load.js';
import { connectionProfileSchema,platformProfileSchema,evidenceSchema } from '../config/real-profiles.js';
import { credential,readPrivateJson } from '../config/private.js';
import { contextFingerprint } from '../domain/capabilities.js';
import { systemClock } from '../domain/common.js';
import { CourierError } from '../domain/errors.js';
import type { Connection } from '../storage/database.js';
import { adapterMappings } from '../storage/adapter-mappings.js';
import { AcpConnection } from '../adapters/workbuddy-experimental/connection.js';
import { WorkBuddyAdapter } from '../adapters/workbuddy-experimental/session.js';
import { DingTalkClient } from '../adapters/dingtalk/client.js';
import { platformTarget } from '../adapters/dingtalk/profile.js';
import { Courier } from './courier.js';
import { checkHarness } from './sessions.js';
import { assertAdmission } from '../adapters/harness/admission.js';
import { desktopStatus } from '../adapters/workbuddy-experimental/authentication.js';
import { closeInOrder } from './shutdown.js';

export async function composeReal(config:Config,configPath:string,db:Connection,onConfigReloadFailure?:()=>void):Promise<{courier:Courier;platform:DingTalkClient}> {
  if(config.platform.kind!=='dingtalk-stream'||config.harness.adapter!=='workbuddy-experimental')throw new CourierError('configuration_invalid');
  let harness:WorkBuddyAdapter|undefined;
  try {
    const profile=connectionProfileSchema.parse(readPrivateJson(configPath,config.harness.connectionProfileRef!));
    const platformProfile=platformProfileSchema.parse(readPrivateJson(configPath,config.platform.limitProfileRef!));
    const evidence=z.array(evidenceSchema).parse(readPrivateJson(configPath,config.harness.capabilityEvidenceRef!));
    const fingerprint=contextFingerprint({targetRef:JSON.stringify([config.harness.instanceId,profile.endpoint,profile.cwd]),cliVersion:profile.cliVersion,
      transportKind:'workbuddy-acp',authorizationScope:profile.authorizationScope,limitProfile:null});
    const headers=profile.authTokenRef?{Authorization:`Bearer ${credential(configPath,profile.authTokenRef)}`}:{ };
    harness=new WorkBuddyAdapter({connection:new AcpConnection({endpoint:profile.endpoint,headers}),store:adapterMappings(db,config.harness.instanceId),
      cwd:profile.cwd,instanceId:config.harness.instanceId,contextFingerprint:fingerprint,evidence,expectedCliVersion:profile.cliVersion,
      ...(profile.desktopDebugUrl?{identity:()=>desktopStatus(profile.desktopDebugUrl!)}:{})});
    const target=platformTarget(config,platformProfile.limits,platformProfile.authorizationScope);
    const platform=new DingTalkClient({config,db,target,evidence:platformProfile.evidence,limits:platformProfile.limits,
      credentials:()=>({clientId:credential(configPath,config.platform.clientIdRef!),clientSecret:credential(configPath,config.platform.clientSecretRef!)})});
    platform.admission();
    await harness.connect();
    assertAdmission(await harness.probe(config.harness.instanceId),Date.now());
    const courier=new Courier({config,db,harness,platform,clock:systemClock,platformEvidenceTarget:target,readConfig:()=>loadConfig(configPath),
      ...(onConfigReloadFailure?{onConfigReloadFailure}:{}),
      persistInbound:(event,recipient)=>platform.persistInbound(event,recipient)});
    // All gates run before any real Stream listener is registered. No synthetic evidence is seeded.
    await checkHarness(courier.runtime);
    return {courier,platform};
  }catch(error){
    await closeInOrder([()=>harness?.disconnect(config.harness.instanceId)]);
    if(error instanceof CourierError)throw error;throw new CourierError('configuration_invalid');
  }
}
