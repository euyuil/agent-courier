import type { Connection } from './database.js';
import type { OutboundDelivery } from '../domain/delivery.js';
import { newId } from '../domain/common.js';
import { insert } from './records.js';
import { putContent } from './content.js';

export function enqueue(db: Connection, input: { recipientId: string; runId?: string; inputId?: string; pendingInputId?: string; logicalMessageIds?: string[]; payload: string }): string {
  const sequence = db.prepare('UPDATE courier_sessions SET nextDeliverySequence=nextDeliverySequence+1 WHERE platformConversationId=(SELECT id FROM platform_conversations WHERE recipientId=?) RETURNING nextDeliverySequence-1 AS n').get(input.recipientId) as { n: number };
  const delivery: OutboundDelivery = { id: newId<'delivery'>(), recipientId: input.recipientId, logicalMessageIds: input.logicalMessageIds ?? [],
    deliverySequence: sequence.n, payloadRef: putContent(db, input.payload), status: 'pending', attemptCount: 0 };
  if (input.runId) delivery.runId = input.runId;
  if (input.inputId) delivery.inputId = input.inputId;
  if (input.pendingInputId) delivery.pendingInputId = input.pendingInputId;
  insert(db, 'outbound_deliveries', delivery);
  for (const id of delivery.logicalMessageIds) db.prepare('INSERT INTO delivery_messages VALUES (?,?)').run(id,delivery.id);
  return delivery.id;
}
