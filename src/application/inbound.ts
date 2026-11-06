import type { NormalizedInbound } from '../adapters/dingtalk/port.js';
import { newId } from '../domain/common.js';
import type { InboundInput } from '../domain/input.js';
import { CourierError, safeCode } from '../domain/errors.js';
import { transaction } from '../storage/database.js';
import { platformRecords } from '../storage/platform.js';
import { reserveCourierSession } from '../storage/sessions.js';
import { putContent } from '../storage/content.js';
import { previousInput } from './input-ledger.js';
import { insert, update } from '../storage/records.js';
import { enqueue } from '../storage/delivery.js';
import { diagnostic } from './diagnostics.js';
import type { Runtime } from './runtime.js';
import { dispatchInput } from './dispatch.js';
import type { AcceptResult } from './courier.js';
import { snapshotPolicy } from './policy-snapshot.js';

export async function receive(ctx: Runtime, event: NormalizedInbound): Promise<AcceptResult> {
  if (ctx.closed) throw new CourierError('state_unknown');
  if (event.platformScope!==ctx.config.platform.scopeRef || event.robotId!==ctx.config.platform.robotRef || event.conversationType!=='private') {
    await ctx.platform.ack(event.transportMessageId); return {status:'ignored'};
  }
  if (!event.originalMessageId || !event.dedupNamespace || !event.evidenceRef || !event.platformConversationId || !event.senderId) {
    ctx.diagnostics.push({code:'capability_unverified'}); await ctx.platform.ack(event.transportMessageId); return {status:'rejected'};
  }
  const policy = snapshotPolicy(ctx.config,event);
  let duplicate = false, receiptId = '', input!: InboundInput, courierId = '', recipientId = '';
  transaction(ctx.db, () => {
    const existing = previousInput(ctx.db,event);
    if (existing) {
      duplicate=true; input=existing.input;
      if (existing.conflict) ctx.diagnostics.push({code:'protocol_conflict',localId:input.id});
      else {
        const conversation=ctx.db.prepare('SELECT recipientId FROM platform_conversations WHERE id=?').get(input.platformConversationId) as {recipientId:string};
        ctx.persistInbound?.(event,conversation.recipientId);
      }
    } else {
      const {conversation,identity} = platformRecords(ctx.db,event);
      recipientId=conversation.recipientId;
      ctx.persistInbound?.(event,recipientId);
      const courier=reserveCourierSession(ctx.db,conversation.id,ctx.config.harness.instanceId,policy.revision); courierId=courier.id;
      const row=ctx.db.prepare('UPDATE courier_sessions SET nextInputSequence=nextInputSequence+1,revision=revision+1 WHERE id=? RETURNING nextInputSequence-1 AS n').get(courier.id) as {n:number};
      input={id:newId<'input'>(),dedupNamespace:event.dedupNamespace!,originalMessageId:event.originalMessageId!,platformConversationId:conversation.id,
        identityId:identity.id,receivedSequence:row.n,textRef:putContent(ctx.db,event.text??''),mode:'invalid',status:'received'};
      insert(ctx.db,'inputs',input);
      if (event.contentType!=='text' || !event.text?.trim()) {
        update(ctx.db,'inputs',input.id,{status:'rejected',errorCode:'input_unsupported'});input.status='rejected';
        enqueue(ctx.db,{recipientId,inputId:input.id,payload:diagnostic('input_unsupported','not_submitted').message});
      }
    }
    receiptId=newId<'inbound-receipt'>();insert(ctx.db,'inbound_receipts',{id:receiptId,inputId:input.id,transportMessageId:event.transportMessageId,receivedAt:event.receivedAt,ackStatus:'pending'});
  });
  try { await ctx.platform.ack(event.transportMessageId); update(ctx.db,'inbound_receipts',receiptId,{ackStatus:'confirmed'}); }
  catch { update(ctx.db,'inbound_receipts',receiptId,{ackStatus:'unknown'}); }
  if (duplicate) return {status:'duplicate',inputId:input.id};
  if (input.status==='rejected') return {status:'rejected',inputId:input.id};
  try { return await dispatchInput(ctx,input,courierId,event.text!,policy); }
  catch (error) {
    const code=safeCode(error);
    if (!(error instanceof CourierError)) throw error;
    transaction(ctx.db,()=>{
      const current=ctx.db.prepare('SELECT status FROM inputs WHERE id=?').get(input.id) as {status:string};
      if (current.status==='received') update(ctx.db,'inputs',input.id,{status:'rejected',errorCode:code});
      enqueue(ctx.db,{recipientId,inputId:input.id,payload:diagnostic(code,'not_submitted').message});
    });
    return {status:'rejected',inputId:input.id};
  }
}
