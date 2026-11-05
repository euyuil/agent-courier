import type { Connection } from './database.js';
import type { OutputMessage } from '../domain/output.js';
import { decode } from './records.js';
export function outputBySource(db: Connection, runId: string, sourceMessageId: string): OutputMessage | undefined {
  return decode<OutputMessage>(db.prepare('SELECT * FROM output_messages WHERE runId=? AND sourceMessageId=?').get(runId,sourceMessageId));
}
