import type { Config } from '../config/schema.js';
import type { Clock } from '../domain/common.js';
import type { Connection } from '../storage/database.js';
import type { HarnessPort } from '../adapters/harness/port.js';
import type { PlatformPort } from '../adapters/dingtalk/port.js';
import type { SafeLog } from './diagnostics.js';
import type { EvidenceTarget } from '../domain/capabilities.js';
import type { NormalizedInbound } from '../adapters/dingtalk/port.js';
export interface CourierDependencies {
  config: Config; db: Connection; harness: HarnessPort; platform: PlatformPort; clock: Clock;
  platformEvidenceTarget?:EvidenceTarget;
  readConfig?:()=>unknown;
  onConfigReloadFailure?:()=>void;
  persistInbound?:(event:NormalizedInbound,recipientId:string)=>void;
  effectBoundary?: (phase: 'before_call' | 'after_remote' | 'after_commit', kind: string) => void;
  eventBoundary?: (phase: 'before_commit' | 'after_commit') => void;
}
export interface Runtime extends CourierDependencies {
  loaded: Set<string>; subscriptions: Map<string, () => void>; diagnostics: SafeLog[]; closed: boolean;
  answerPriority: Map<string,Promise<void>>;
}
