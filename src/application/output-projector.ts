import type { Runtime } from './runtime.js';
import type { Run } from '../domain/run.js';
import { terminal } from '../domain/run.js';
import type { OutputMessage } from '../domain/output.js';
import type { PendingInput } from '../domain/pending-input.js';
import { byId,decode,update } from '../storage/records.js';
import { getContent } from '../storage/content.js';
import { enqueue } from '../storage/delivery.js';
import { transaction } from '../storage/database.js';
import { presentRequest } from './interaction-presenter.js';
import { reportFailure } from './failure-reporting.js';
import { invalidateMessage } from '../delivery/assemble.js';
export function projectOutput(ctx:Runtime,runId:string):void {
  const run=byId<Run>(ctx.db,'runs',runId)!;
  const target=ctx.db.prepare('SELECT p.recipientId FROM courier_sessions c JOIN platform_conversations p ON p.id=c.platformConversationId WHERE c.id=?').get(run.courierSessionId) as {recipientId:string};
  const messages=ctx.db.prepare('SELECT * FROM output_messages WHERE runId=? ORDER BY logicalSequence').all(runId).map(row=>decode<OutputMessage>(row)!);
  for(const message of messages) {
    const mapped=decode<PendingInput>(ctx.db.prepare('SELECT * FROM pending_inputs WHERE runId=? AND sourceMessageId=?').get(runId,message.sourceMessageId));
    if(mapped && message.kind!==(mapped.kind==='question'?'question':'permission_request')) {
      invalidateMessage(ctx,message);update(ctx.db,'harness_bindings',run.bindingId,{status:'unknown'});message.completeness='invalid';
    }
    if(message.completeness==='assembling')break;
    if(message.completeness==='invalid') {reportFailure(ctx,{recipientId:target.recipientId,runId},'output_unsupported');continue;}
    if(ctx.db.prepare('SELECT 1 FROM delivery_messages WHERE outputMessageId=?').get(message.id))continue;
    if(message.kind==='question'||message.kind==='permission_request') {
      const pending=decode<PendingInput>(ctx.db.prepare('SELECT * FROM pending_inputs WHERE runId=? AND sourceMessageId=?').get(runId,message.sourceMessageId));
      if(!pending){if(message.selected)break;continue;}presentRequest(ctx,pending);continue;
    }
    if(!message.selected)continue;
    const text=getContent(ctx.db,message.contentRef);
    if(text)enqueue(ctx.db,{recipientId:target.recipientId,runId,logicalMessageIds:[message.id],payload:text});
  }
  if(run.status==='completed' && run.policySnapshot.final) {
    const finals=messages.filter(message=>message.kind==='final');
    if(!finals.some(message=>message.completeness==='assembling') && !finals.some(message=>message.completeness==='complete'&&message.selected&&getContent(ctx.db,message.contentRef))) {
      reportFailure(ctx,{recipientId:target.recipientId,runId},'content_missing');
    }
  }
}
export function confirmMissingOutput(ctx:Runtime,messageId:string,evidence:{authoritative:true;evidenceRef:string}):void {
  if(!evidence.evidenceRef)return;
  transaction(ctx.db,()=>{
    const message=byId<OutputMessage>(ctx.db,'output_messages',messageId);if(!message)return;
    const run=byId<Run>(ctx.db,'runs',message.runId)!;
    if(!terminal(run.status) || message.completeness!=='assembling')return;
    update(ctx.db,'output_messages',message.id,{completeness:'invalid'});projectOutput(ctx,run.id);
  });
}
