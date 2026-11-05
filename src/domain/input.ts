export type InputStatus = 'received' | 'dispatching' | 'accepted' | 'rejected' | 'unknown';
export interface InboundInput {
  id: string; dedupNamespace: string; originalMessageId: string; platformConversationId: string; identityId: string;
  receivedSequence: number; textRef: string; mode: 'start' | 'steer' | 'answer' | 'invalid'; runId?: string;
  pendingInputId?: string; status: InputStatus; acceptedAt?: number; appliedEvidenceRef?: string; errorCode?: string;
}
export interface InboundReceipt { id: string; inputId?: string; transportMessageId: string; receivedAt: number; ackStatus: 'pending' | 'confirmed' | 'unknown' }
