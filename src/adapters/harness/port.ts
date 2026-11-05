import type { Answer } from '../../domain/answer.js';
import type { CapabilityEvidence, CapabilityName, CapabilityState } from '../../domain/capabilities.js';
import type { ErrorCode } from '../../domain/errors.js';
import type { HarnessEvent } from './events.js';

export interface ProbeReport {
  kind: 'fake' | 'harness'; product: string; productVersion: string; adapterVersion: string;
  cliVersion?: string; authenticationStatus: 'authenticated' | 'required' | 'unknown';
  capabilities: Record<CapabilityName, CapabilityState>; evidenceRefs: CapabilityEvidence[];
  contextFingerprint: string; limitations: string[];
}
export type Receipt = { status: 'accepted'; sessionRef: string; runRef?: string; vendorRequestId?: string; receiptEvidence: string }
  | { status: 'rejected'; errorCode: ErrorCode; definitelyNotAccepted: true }
  | { status: 'unknown'; errorCode: ErrorCode };
export interface CommandHandle { operationId: string; receipt: Promise<Receipt> }
export interface OperationInput { operationId: string }
export interface SessionInput extends OperationInput { sessionRef: string }
export interface StartInput extends SessionInput { inputId: string; text: string; clientRunId: string }
export interface SteerInput extends SessionInput { inputId: string; text: string; expectedRunRef: string }
export interface AnswerInput extends SessionInput { inputId: string; runRef: string; vendorRequestId: string; answer: Answer }
export type Inspection = { status: 'unsupported' | 'unknown' }
  | { status: 'known'; authoritative: true; evidenceRef: string; receipt?: Receipt;
      runState?: 'running' | 'waiting_input' | 'completed' | 'failed'; sessionAvailable?: boolean };
export interface HarnessPort {
  probe(instanceId: string): Promise<ProbeReport>;
  createSession(input: OperationInput & { courierSessionId: string }): CommandHandle;
  resumeSession(input: SessionInput): CommandHandle;
  start(input: StartInput): CommandHandle;
  steer(input: SteerInput): CommandHandle;
  answer(input: AnswerInput): CommandHandle;
  subscribe(sessionRef: string, listener: (event: HarnessEvent) => void, verifiedCursor?: string): () => void;
  inspect(input: { sessionRef?: string; operationId?: string; runRef?: string; vendorRequestId?: string }): Promise<Inspection>;
  disconnect(instanceId: string): Promise<void>;
}
