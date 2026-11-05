import type { Runtime } from '../application/runtime.js';
import type { OutboundDelivery } from '../domain/delivery.js';
import type { Recipient, SendResult } from '../adapters/dingtalk/port.js';
import { newId } from '../domain/common.js';
import { transaction } from '../storage/database.js';
import { byId, insert, update } from '../storage/records.js';
import { getContent } from '../storage/content.js';
import { selectRoute } from './routes.js';
import { textLength } from './limits.js';
import { nextRetry } from './retry-policy.js';
import { reportFailure } from '../application/failure-reporting.js';

export async function sendOne(ctx: Runtime,delivery: OutboundDelivery): Promise<void> {
  const recipient=byId<Recipient>(ctx.db,'recipients',delivery.recipientId)!;
  const selection=selectRoute(ctx,recipient),route=selection.route;
  if (!route) { update(ctx.db,'outbound_deliveries',delivery.id,{errorCode:'route_unavailable',nextAttemptAt:selection.nextAt});return; }
  const payload=getContent(ctx.db,delivery.payloadRef);
  if(textLength(payload,route.verifiedLimits.lengthUnit)>route.verifiedLimits.maxTextLength) {
    transaction(ctx.db,()=>{
      update(ctx.db,'outbound_deliveries',delivery.id,{status:'failed',errorCode:'text_too_long'});
      if(delivery.logicalMessageIds.length)reportFailure(ctx,delivery,'text_too_long');
    });return;
  }
  let attemptId='';
  transaction(ctx.db,()=>{
    const current=byId<OutboundDelivery>(ctx.db,'outbound_deliveries',delivery.id)!;
    if (!['pending','retry_wait'].includes(current.status) || current.attemptCount>=1+ctx.config.delivery.maxAutomaticRetries) return;
    attemptId=newId<'attempt'>();
    insert(ctx.db,'delivery_attempts',{id:attemptId,deliveryId:delivery.id,attemptNo:current.attemptCount+1,routeId:route.id,startedAt:ctx.clock.now(),outcome:'sending'});
    update(ctx.db,'outbound_deliveries',delivery.id,{status:'sending',attemptCount:current.attemptCount+1});
  });
  if (!attemptId) return;
  ctx.effectBoundary?.('before_call','send');
  let result:SendResult;
  try { result=await ctx.platform.send(delivery.id,recipient,payload,route); }
  catch { result={status:'unknown',safeReason:'state_unknown'}; }
  ctx.effectBoundary?.('after_remote','send');
  transaction(ctx.db,()=>{
    update(ctx.db,'delivery_attempts',attemptId,{outcome:result.status,...(result.status==='confirmed'&&result.providerReceipt?{providerReceiptRef:result.providerReceipt}:{})});
    const current=byId<OutboundDelivery>(ctx.db,'outbound_deliveries',delivery.id)!;
    const retryAt=result.status==='not_sent'&&result.retryable?nextRetry(ctx.clock.now(),current.attemptCount,ctx.config.delivery.maxAutomaticRetries,result.retryAfter):undefined;
    const status=result.status==='confirmed'?'delivered':result.status==='unknown'?'unknown':retryAt!==undefined?'retry_wait':'failed';
    update(ctx.db,'outbound_deliveries',delivery.id,{status,nextAttemptAt:retryAt,
      errorCode:result.status==='confirmed'?undefined:result.status==='unknown'?'state_unknown':'delivery_failed'});
    if(status==='failed' && current.logicalMessageIds.length)reportFailure(ctx,current,'delivery_failed');
  });
  ctx.effectBoundary?.('after_commit','send');
}
