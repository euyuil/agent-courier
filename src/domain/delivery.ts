export type { DeliveryRoute } from '../adapters/dingtalk/port.js';
export interface OutboundDelivery {
  id: string; recipientId: string; runId?: string; inputId?: string; pendingInputId?: string; logicalMessageIds: string[];
  deliverySequence: number; payloadRef: string; status: 'pending' | 'sending' | 'delivered' | 'retry_wait' | 'failed' | 'unknown';
  attemptCount: number; nextAttemptAt?: number; errorCode?: string;
}
export interface DeliveryAttempt { id: string; deliveryId: string; attemptNo: number; routeId: string; startedAt: number; outcome: 'sending' | 'confirmed' | 'not_sent' | 'unknown' | 'route_unavailable'; providerReceiptRef?: string; errorCode?: string }
