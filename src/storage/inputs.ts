import type { Connection } from './database.js';
import type { InboundInput } from '../domain/input.js';
import { decode } from './records.js';
export function inputByMessage(db: Connection, namespace: string, messageId: string): InboundInput | undefined {
  return decode<InboundInput>(db.prepare('SELECT * FROM inputs WHERE dedupNamespace=? AND originalMessageId=?').get(namespace,messageId));
}
