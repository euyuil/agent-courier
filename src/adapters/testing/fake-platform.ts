import type { Clock } from '../../domain/common.js';
import { newId, systemClock } from '../../domain/common.js';
import type { DeliveryInspection, DeliveryRoute, NormalizedInbound, PlatformPort, Recipient, SendResult } from '../dingtalk/port.js';

export class FakePlatform implements PlatformPort {
  readonly acknowledgements: string[] = [];
  readonly attempts: { deliveryId: string; recipient: Recipient; payload: string; route: DeliveryRoute }[] = [];
  readonly visible: { deliveryId: string; recipient: Recipient; payload: string }[] = [];
  readonly plans: { result: SendResult; visible?: boolean }[] = [];
  readonly inspections = new Map<string, DeliveryInspection>();
  constructor(readonly clock: Clock = systemClock) {}
  async ack(transportMessageId: string): Promise<void> { this.acknowledgements.push(transportMessageId); }
  async send(deliveryId: string, recipient: Recipient, payload: string, route: DeliveryRoute): Promise<SendResult> {
    this.attempts.push({ deliveryId, recipient, payload, route });
    const step = this.plans.shift() ?? { result: { status: 'confirmed', acceptedAt: this.clock.now(), evidence: 'synthetic-platform-acceptance' } as SendResult };
    if (step.visible || step.result.status === 'confirmed') this.visible.push({ deliveryId, recipient, payload });
    return step.result;
  }
  async inspectDelivery(deliveryId: string): Promise<DeliveryInspection> { return this.inspections.get(deliveryId) ?? { status: 'unsupported' }; }
  inbound(text = 'synthetic input', conversation = 'synthetic-private-a', originalMessageId: string = newId<'synthetic-message'>()): NormalizedInbound {
    return { transportMessageId: newId<'synthetic-transport'>(), originalMessageId, platformScope: 'synthetic-scope', robotId: 'synthetic-robot',
      platformConversationId: conversation, conversationType: 'private', senderId: `synthetic-sender-${conversation}`,
      contentType: 'text', text, receivedAt: this.clock.now(), dedupNamespace: 'synthetic-scope/robot/message', evidenceRef: 'synthetic-identity-evidence' };
  }
  route(recipientId: string): DeliveryRoute {
    return { id: newId<'synthetic-route'>(), recipientId, kind: 'sessionWebhook', capabilityEvidenceId: 'synthetic-platform-evidence',
      status: 'ready', verifiedLimits: { maxTextLength: 10000, lengthUnit: 'codepoints', routeTotal: null, rates: [], evidenceRef: 'synthetic-test-budget-only' } };
  }
}
