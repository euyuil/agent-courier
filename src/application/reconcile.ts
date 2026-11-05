import type { Runtime } from './runtime.js';
import type { HarnessOperation } from '../domain/run.js';
import type { HarnessBinding } from '../domain/session.js';
import type { OutboundDelivery } from '../domain/delivery.js';
import { CourierError } from '../domain/errors.js';
import { byId,update } from '../storage/records.js';
import { transaction } from '../storage/database.js';
import { nextRetry } from '../delivery/retry-policy.js';
import { recordReceipt } from './dispatch.js';
import { reportFailure } from './failure-reporting.js';

export async function reconcile(ctx:Runtime,target:{operation?:string;delivery?:string}):Promise<boolean> {
  if(!!target.operation===!!target.delivery)throw new CourierError('configuration_invalid');
  if(target.delivery) {
    const delivery=byId<OutboundDelivery>(ctx.db,'outbound_deliveries',target.delivery);
    if(!delivery || delivery.status!=='unknown')throw new CourierError('configuration_invalid');
    const result=await ctx.platform.inspectDelivery(delivery.id);
    if(!('authoritative' in result) || !result.authoritative || !result.evidenceRef || result.status==='unknown')return false;
    transaction(ctx.db,()=>{
      if(result.status==='confirmed')update(ctx.db,'outbound_deliveries',delivery.id,{status:'delivered',errorCode:undefined});
      else {
        const retryAt=result.retryable?nextRetry(ctx.clock.now(),delivery.attemptCount,ctx.config.delivery.maxAutomaticRetries,result.retryAfter):undefined;
        update(ctx.db,'outbound_deliveries',delivery.id,{status:retryAt===undefined?'failed':'retry_wait',nextAttemptAt:retryAt,errorCode:'delivery_failed'});
        if(retryAt===undefined&&delivery.logicalMessageIds.length)reportFailure(ctx,delivery,'delivery_failed');
      }
      const attempt=ctx.db.prepare('SELECT id FROM delivery_attempts WHERE deliveryId=? ORDER BY attemptNo DESC LIMIT 1').get(delivery.id) as {id:string}|undefined;
      if(attempt)update(ctx.db,'delivery_attempts',attempt.id,{outcome:result.status,...(result.status==='confirmed'?{providerReceiptRef:result.evidenceRef}:{})});
    });return true;
  }
  const operation=byId<HarnessOperation>(ctx.db,'harness_operations',target.operation!);
  if(!operation || operation.status!=='unknown')throw new CourierError('configuration_invalid');
  const binding=byId<HarnessBinding>(ctx.db,'harness_bindings',operation.bindingId)!;
  const result=await ctx.harness.inspect({operationId:operation.id,...(binding.harnessSessionId?{sessionRef:binding.harnessSessionId}:{}),...(operation.expectedRunRef?{runRef:operation.expectedRunRef}:{})});
  if(result.status!=='known' || !result.authoritative || !result.evidenceRef || !result.receipt || result.receipt.status==='unknown')return false;
  if(operation.kind==='create' || operation.kind==='load') {
    transaction(ctx.db,()=>{
      update(ctx.db,'harness_operations',operation.id,{status:result.receipt!.status,evidenceRef:result.evidenceRef});
      if(result.receipt!.status==='accepted')update(ctx.db,'harness_bindings',binding.id,{harnessSessionId:result.receipt!.sessionRef,status:'ready',revision:binding.revision+1});
      else update(ctx.db,'harness_bindings',binding.id,{status:operation.kind==='create'?'blocked':'unavailable',revision:binding.revision+1});
    });
  } else {
    transaction(ctx.db,()=>{
      recordReceipt(ctx,operation,result.receipt!);
      if(operation.runId && result.runState) {
        const run=ctx.db.prepare('SELECT status FROM runs WHERE id=?').get(operation.runId) as {status:string};
        if(!['completed','failed','not_started'].includes(run.status))update(ctx.db,'runs',operation.runId,{status:result.runState,
          ...(['completed','failed'].includes(result.runState)?{completionEvidenceRef:result.evidenceRef,finishedAt:ctx.clock.now()}:{} )});
      }
    });
  }
  return byId<HarnessOperation>(ctx.db,'harness_operations',operation.id)!.status!=='unknown';
}
