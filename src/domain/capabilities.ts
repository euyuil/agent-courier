import { createHash } from 'node:crypto';

export const requiredCapabilities = ['isolatedSessions', 'createAndResume', 'writerOwnership', 'timelySteer',
  'inputCorrelation', 'explicitCompletion', 'typedVisibleOutput', 'messageAssembly', 'humanInteraction'] as const;
export const optionalCapabilities = ['inspectOperation', 'replayEvents', 'serverIdempotency'] as const;
export type CapabilityName = typeof requiredCapabilities[number] | typeof optionalCapabilities[number];
export type CapabilityState = 'unverified' | 'supported' | 'unsupported';
export interface CapabilityEvidence {
  id: string; kind: 'fake' | 'harness' | 'platform'; adapterVersion: string; productVersion: string;
  scope: Partial<Record<CapabilityName | 'ingress' | 'delivery' | 'oto', { states: string[]; limitations: string[] }>>;
  contextFingerprint: string; checkedAt: number; expiresAt?: number; invalidatedAt?: number;
  outcome: 'unverified' | 'passed' | 'failed'; evidenceRef: string;
}
export interface HarnessInstance {
  id: string; adapterKind: 'mock' | 'workbuddy-experimental'; productVersion: string; cliVersion?: string;
  capabilityEvidenceId: string; readiness: CapabilityState;
}
export interface EvidenceContext {
  targetRef: string; cliVersion: string | null; transportKind: string;
  authorizationScope: string[] | null; limitProfile: unknown;
  outputProfile?:unknown;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return [...new Set(value.map(item => JSON.stringify(canonical(item))))].sort().map(item => JSON.parse(item) as unknown);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
export function contextFingerprint(context: EvidenceContext): string {
  return createHash('sha256').update(JSON.stringify(canonical(context))).digest('hex');
}
export interface EvidenceTarget { kind: CapabilityEvidence['kind']; adapterVersion: string; productVersion: string; contextFingerprint: string }
export function evidenceValid(evidence: CapabilityEvidence, target: EvidenceTarget, now: number,
  capability: keyof CapabilityEvidence['scope'], states: readonly string[] = []): boolean {
  const coverage = evidence.scope[capability];
  return Number.isFinite(now) && !!target.adapterVersion && !!target.productVersion && !!target.contextFingerprint
    && evidence.kind === target.kind && evidence.outcome === 'passed'
    && evidence.adapterVersion === target.adapterVersion && evidence.productVersion === target.productVersion
    && evidence.contextFingerprint === target.contextFingerprint && evidence.invalidatedAt === undefined
    && Number.isFinite(evidence.checkedAt) && evidence.checkedAt <= now
    && (evidence.expiresAt === undefined || (Number.isFinite(evidence.expiresAt)
      && evidence.expiresAt > evidence.checkedAt && now < evidence.expiresAt))
    && !!coverage && states.every(state => coverage.states.includes(state));
}
