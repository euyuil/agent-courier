import type { Config } from '../../config/schema.js';
import type { VerifiedLimits } from '../dingtalk/port.js';
import { contextFingerprint,type CapabilityEvidence } from '../../domain/capabilities.js';
import { newId } from '../../domain/common.js';
export function syntheticLimits():VerifiedLimits {return {maxTextLength:10000,lengthUnit:'codepoints',routeTotal:null,rates:[],evidenceRef:'synthetic-test-budget-only'};}
export function platformFingerprint(config:Config,limits:VerifiedLimits):string {
  const {evidenceRef:_,...profile}=limits;
  return contextFingerprint({targetRef:JSON.stringify([config.platform.scopeRef,config.platform.robotRef]),cliVersion:null,transportKind:'fake',authorizationScope:[],limitProfile:profile});
}
export function syntheticPlatformEvidence(config:Config,now:number,limits:VerifiedLimits):CapabilityEvidence {
  return {id:newId<'capability-evidence'>(),kind:'fake',adapterVersion:'1',productVersion:'1',scope:{ingress:{states:[],limitations:[]},delivery:{states:[],limitations:[]}},
    contextFingerprint:platformFingerprint(config,limits),checkedAt:now,outcome:'passed',evidenceRef:'synthetic-platform-budget-only'};
}
