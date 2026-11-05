import type { AnswerSchema, Option } from '../../domain/answer.js';

export const outputKinds = ['progress', 'final', 'question', 'permission_request', 'error', 'message', 'tool_status', 'artifact'] as const;
export type OutputKind = typeof outputKinds[number];
export interface EventPayloads {
  'input.accepted': { operationId: string; inputId: string; receiptEvidence: string };
  'input.applied': { inputId: string; appliedEvidence: string };
  'run.started': { clientRunId: string; runRef: string };
  'run.waiting_input': { requestIds: string[] };
  'message.started': { messageId: string; kind: OutputKind; userVisible: boolean; logicalOrder: number };
  'message.fragment': { messageId: string; fragmentKey: string; fragmentIndex: number; text: string };
  'message.completed': { messageId: string; finalFragmentIndex: number };
  'input.requested': { vendorRequestId: string; kind: 'question' | 'permission'; messageId: string;
    answerSchema?: AnswerSchema; options?: Option[]; adapterMappingRef: string };
  'input.invalidated': { vendorRequestId: string; reason: 'withdrawn' | 'expired' };
  'run.completed': { completionEvidence: string; stopReason: string };
  'run.failed': { errorCode: string; safeReason: string; completionEvidence: string };
  'connection.lost': { unresolvedOperationIds: string[] };
}
export type HarnessEvent = { [K in keyof EventPayloads]: {
  schemaVersion: 1; eventKey: string; sessionRef: string; runRef: string;
  sourceSequence?: number; occurredAt?: number; eventType: K; payload: EventPayloads[K];
} }[keyof EventPayloads];
