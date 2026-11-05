import type { Connection } from '../storage/database.js';
import type { CourierSession } from '../domain/session.js';
import type { InboundInput } from '../domain/input.js';
import type { Run } from '../domain/run.js';
import { byId,decode } from '../storage/records.js';
import { CourierError } from '../domain/errors.js';
export function sessionStatus(db:Connection,id:string) {
  const session=byId<CourierSession>(db,'courier_sessions',id);if(!session)throw new CourierError('configuration_invalid');
  const input=decode<InboundInput>(db.prepare('SELECT * FROM inputs WHERE platformConversationId=? ORDER BY receivedSequence DESC LIMIT 1').get(session.platformConversationId));
  const run=decode<Run>(db.prepare('SELECT * FROM runs WHERE courierSessionId=? ORDER BY rowid DESC LIMIT 1').get(session.id));
  const delivery=Object.fromEntries((db.prepare('SELECT status,count(*) AS n FROM outbound_deliveries WHERE recipientId=(SELECT recipientId FROM platform_conversations WHERE id=?) GROUP BY status').all(session.platformConversationId) as {status:string;n:number}[]).map(row=>[row.status,row.n]));
  const pendingTable=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pending_inputs'").get();
  const pendingInputCount=pendingTable?(db.prepare("SELECT count(*) AS n FROM pending_inputs WHERE platformConversationId=? AND validity='open' AND answerStatus NOT IN ('accepted')").get(session.platformConversationId) as {n:number}).n:0;
  const missingPrompt=pendingTable&&db.prepare("SELECT 1 FROM pending_inputs WHERE platformConversationId=? AND validity='open' AND promptRef IS NULL LIMIT 1").get(session.platformConversationId);
  const binding=db.prepare('SELECT status FROM harness_bindings WHERE courierSessionId=?').get(session.id) as {status:string}|undefined;
  const unresolvedOperations=db.prepare("SELECT o.id,o.kind,o.status,o.resultCode FROM harness_operations o JOIN harness_bindings b ON b.id=o.bindingId WHERE b.courierSessionId=? AND (o.status='unknown' OR o.resultCode='protocol_conflict')").all(session.id) as {id:string;kind:string;status:string;resultCode:string|null}[];
  const unresolvedDeliveries=db.prepare("SELECT d.id,d.status,d.attemptCount FROM outbound_deliveries d JOIN platform_conversations p ON p.recipientId=d.recipientId WHERE p.id=? AND d.status IN ('unknown','retry_wait','failed','pending')").all(session.platformConversationId) as {id:string;status:string;attemptCount:number}[];
  return {session:session.id,input:input?{id:input.id,mode:input.mode,status:input.status,errorCode:input.errorCode}:null,
    execution:run?{id:run.id,status:run.status}:null,pendingInputCount,delivery,binding:binding??null,unresolvedOperations,unresolvedDeliveries,
    reason:input?.errorCode??(missingPrompt?'interaction_blocked':binding?.status==='unknown'?'state_unknown':null),nextAction:missingPrompt?'核实原请求正文与可靠恢复能力；不要代答':input?.status==='unknown'||binding?.status==='unknown'?'核实原输入接收状态；不要重复提交':'查看输入、执行与投递各自状态'};
}
