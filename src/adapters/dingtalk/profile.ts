import type { Config } from '../../config/schema.js';
import { contextFingerprint,type EvidenceTarget } from '../../domain/capabilities.js';
import type { VerifiedLimits } from './port.js';
export function platformTarget(config:Config,limits:VerifiedLimits,authorizationScope:string[]):EvidenceTarget {
  const {evidenceRef:_,...limitProfile}=limits;
  return {kind:'platform',productVersion:'dingtalk-stream@2.1.5',adapterVersion:'1',contextFingerprint:contextFingerprint({
    targetRef:JSON.stringify([config.platform.scopeRef,config.platform.robotRef]),cliVersion:null,transportKind:'dingtalk-stream',authorizationScope,limitProfile})};
}
