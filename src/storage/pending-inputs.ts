import type { Connection } from './database.js';
import type { PendingInput } from '../domain/pending-input.js';
import { decode } from './records.js';
export function pendingByCode(db:Connection,platformConversationId:string,code:string):PendingInput|undefined {
  return decode<PendingInput>(db.prepare('SELECT * FROM pending_inputs WHERE platformConversationId=? AND publicCode=?').get(platformConversationId,code));
}
export function pendingByRequest(db:Connection,runId:string,vendorRequestId:string):PendingInput|undefined {
  return decode<PendingInput>(db.prepare('SELECT * FROM pending_inputs WHERE runId=? AND vendorRequestId=?').get(runId,vendorRequestId));
}
export function hasPending(db:Connection,platformConversationId:string):boolean {
  return !!db.prepare("SELECT id FROM pending_inputs WHERE platformConversationId=? AND validity='open' AND answerStatus!='accepted' LIMIT 1").get(platformConversationId);
}
