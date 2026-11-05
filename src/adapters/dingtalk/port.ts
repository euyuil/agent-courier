export interface NormalizedInbound {
  transportMessageId: string; originalMessageId?: string; platformScope: string; robotId: string;
  robotCode?: string; chatbotUserId?: string; platformConversationId: string;
  conversationType: 'private' | 'group' | 'unknown'; senderId: string; enterpriseUserId?: string;
  contentType: string; text?: string; receivedAt: number; dedupNamespace?: string; evidenceRef?: string;
  sensitiveCapabilityRef?: string; expiresAt?: number;
}
export interface Recipient {
  id: string; platformScope: string; robotId: string; platformConversationId: string; privateUserRef?: string;
}
export interface RateLimit { scope: 'application' | 'robot' | 'recipient' | 'route'; count: number; windowMs: number }
export interface VerifiedLimits {
  maxTextLength: number; lengthUnit: 'utf8_bytes' | 'codepoints' | 'utf16';
  routeTotal: number | null; rates: RateLimit[]; evidenceRef: string;
}
export interface DeliveryRoute {
  id: string; recipientId: string; kind: 'sessionWebhook' | 'oto'; sensitiveCapabilityRef?: string;
  expiresAt?: number; verifiedLimits: VerifiedLimits; capabilityEvidenceId: string; status: 'ready' | 'unavailable';
}
export type SendResult = { status: 'confirmed'; acceptedAt: number; evidence: string; providerReceipt?: string }
  | { status: 'not_sent'; code: string; retryable: boolean; retryAfter?: number }
  | { status: 'unknown'; safeReason: string; queryRef?: string }
  | { status: 'route_unavailable'; code: 'expired' | 'auth' | 'recipient' | 'limit' };
export type DeliveryInspection = Exclude<SendResult, { status: 'route_unavailable' }> & { authoritative: true; evidenceRef: string }
  | { status: 'unsupported' | 'unknown' };
export interface PlatformPort {
  ack(transportMessageId: string): Promise<void>;
  send(deliveryId: string, recipient: Recipient, payload: string, route: DeliveryRoute): Promise<SendResult>;
  inspectDelivery(deliveryId: string): Promise<DeliveryInspection>;
}
