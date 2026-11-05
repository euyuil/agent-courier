import type { Connection } from './database.js';
import { decode, insert } from './records.js';
import type { CourierSession, HarnessBinding } from '../domain/session.js';
import { newId } from '../domain/common.js';

export function sessionFor(db: Connection, platformConversationId: string): CourierSession | undefined {
  return decode<CourierSession>(db.prepare('SELECT * FROM courier_sessions WHERE platformConversationId=?').get(platformConversationId));
}
export function bindingFor(db: Connection, courierSessionId: string): HarnessBinding | undefined {
  return decode<HarnessBinding>(db.prepare('SELECT * FROM harness_bindings WHERE courierSessionId=?').get(courierSessionId));
}
export function reserveCourierSession(db: Connection, platformConversationId: string, harnessInstanceId: string, policyRevision: number): CourierSession {
  const existing = sessionFor(db, platformConversationId); if (existing) return existing;
  const result = { id: newId<'courier-session'>(), platformConversationId, harnessInstanceId, policyRevision, nextInputSequence: 1, nextDeliverySequence: 1, revision: 0 };
  insert(db, 'courier_sessions', result); return result;
}
