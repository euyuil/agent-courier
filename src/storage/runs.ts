import type { Connection } from './database.js';
import type { Run } from '../domain/run.js';
import { decode } from './records.js';
export function activeRun(db: Connection, courierSessionId: string): Run | undefined {
  return decode<Run>(db.prepare("SELECT * FROM runs WHERE courierSessionId=? AND status IN ('submitting','running','waiting_input','unknown')").get(courierSessionId));
}
