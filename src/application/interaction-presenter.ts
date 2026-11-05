import type { Runtime } from './runtime.js';
import type { PendingInput } from '../domain/pending-input.js';
import { outputBySource } from '../storage/output.js';
import { getContent } from '../storage/content.js';
import { enqueue } from '../storage/delivery.js';
import { update } from '../storage/records.js';
import { reportFailure } from './failure-reporting.js';
export function presentRequest(ctx:Runtime,pending:PendingInput):void {
  if(pending.validity!=='open')return;
  const message=outputBySource(ctx.db,pending.runId,pending.sourceMessageId);
  if(!message || message.completeness!=='complete')return;
  const expected=pending.kind==='question'?'question':'permission_request';
  if(message.kind!==expected || !message.userVisible){
    ctx.diagnostics.push({code:'interaction_blocked',localId:pending.id});
    const target=ctx.db.prepare('SELECT recipientId FROM platform_conversations WHERE id=?').get(pending.platformConversationId) as {recipientId:string};
    reportFailure(ctx,{recipientId:target.recipientId,runId:pending.runId},'interaction_blocked');return;
  }
  if(ctx.db.prepare('SELECT 1 FROM delivery_messages WHERE outputMessageId=?').get(message.id))return;
  update(ctx.db,'pending_inputs',pending.id,{promptRef:message.contentRef});
  let instructions=pending.kind==='question'?`/答复 ${pending.publicCode} 你的回答`:`/批准 ${pending.publicCode}\n/拒绝 ${pending.publicCode}`;
  if(pending.answerSchema?.mode==='form')instructions=`/答复 ${pending.publicCode} JSON对象\n`+pending.answerSchema.fields.map(field=>
    `${field.fieldId} ${field.label} ${field.required?'必填':'可选'} ${field.valueType} ${(field.options??[]).map(o=>`${o.code}:${o.label}`).join(' ')}`).join('\n');
  if(pending.options?.length)instructions+='\n'+pending.options.map(option=>`${option.code}: ${option.label} (${option.decision==='approve'?'批准':'拒绝'})`).join('\n')+`\n指定范围：/批准 ${pending.publicCode} 选项码`;
  const target=ctx.db.prepare('SELECT recipientId FROM platform_conversations WHERE id=?').get(pending.platformConversationId) as {recipientId:string};
  enqueue(ctx.db,{recipientId:target.recipientId,runId:pending.runId,pendingInputId:pending.id,logicalMessageIds:[message.id],payload:getContent(ctx.db,message.contentRef)+'\n\n'+instructions});
}
