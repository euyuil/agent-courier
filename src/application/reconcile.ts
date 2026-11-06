import type { Runtime } from './runtime.js';
import { terminal,type HarnessOperation,type Run } from '../domain/run.js';
import type { HarnessBinding } from '../domain/session.js';
import type { PendingInput } from '../domain/pending-input.js';
import type { OutboundDelivery } from '../domain/delivery.js';
import { CourierError } from '../domain/errors.js';
import { byId,update } from '../storage/records.js';
import { transaction } from '../storage/database.js';
import { nextRetry } from '../delivery/retry-policy.js';
import { recordReceipt } from './dispatch.js';
import { reportFailure } from './failure-reporting.js';
import { normalizeReceipt } from '../adapters/harness/receipt.js';
import { projectOutput } from './output-projector.js';

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
  if(result.status!=='known' || result.authoritative!==true || typeof result.evidenceRef!=='string'||!result.evidenceRef || !result.receipt || result.receipt.status==='unknown')return false;
  return transaction(ctx.db,()=>{
    const current=byId<HarnessOperation>(ctx.db,'harness_operations',operation.id)!;
    const currentBinding=byId<HarnessBinding>(ctx.db,'harness_bindings',operation.bindingId)!;
    const run=operation.runId?byId<Run>(ctx.db,'runs',operation.runId):undefined;
    const pending=operation.pendingInputId?byId<PendingInput>(ctx.db,'pending_inputs',operation.pendingInputId):undefined;
    const expectedRunRef=run?.harnessRunRef??operation.expectedRunRef;
    const receipt=normalizeReceipt(result.receipt!,{
      ...(currentBinding.harnessSessionId?{sessionRef:currentBinding.harnessSessionId}:{}),
      ...(run?{requiresRun:true,...(expectedRunRef?{runRef:expectedRunRef}:{})}:{}),
      ...(pending?{requestId:pending.vendorRequestId}:{})});
    // 查询等待期间到达的新事实不能被较早查询的附带状态覆盖。
    if(current.status!=='unknown') {
      if(receipt.status!=='unknown'&&current.status!==receipt.status)recordReceipt(ctx,current,receipt);
      return false;
    }
    const claimed=receipt.status==='accepted'?ctx.db.prepare('SELECT id FROM harness_bindings WHERE harnessInstanceId=? AND harnessSessionId=? AND id!=?')
      .get(currentBinding.harnessInstanceId,receipt.sessionRef,currentBinding.id):undefined;
    if(receipt.status==='unknown'||claimed||result.runState!==undefined&&!['running','waiting_input','completed','failed'].includes(result.runState)) {
      recordReceipt(ctx,current,{status:'unknown',errorCode:'protocol_conflict'});return false;
    }
    if(operation.kind==='create' || operation.kind==='load') {
      update(ctx.db,'harness_operations',operation.id,{status:receipt.status,evidenceRef:result.evidenceRef,resultCode:receipt.status==='rejected'?receipt.errorCode:undefined});
      if(receipt.status==='accepted')update(ctx.db,'harness_bindings',binding.id,{harnessSessionId:receipt.sessionRef,
        status:result.sessionAvailable===false?'unavailable':'ready',revision:currentBinding.revision+1});
      else update(ctx.db,'harness_bindings',binding.id,{status:operation.kind==='create'?'blocked':'unavailable',revision:currentBinding.revision+1});
    } else {
      recordReceipt(ctx,current,receipt);
      const recorded=byId<HarnessOperation>(ctx.db,'harness_operations',operation.id)!;
      if(recorded.status!==receipt.status)return false;
      if(run&&result.runState) {
        const latest=byId<Run>(ctx.db,'runs',run.id)!;
        if(!terminal(latest.status)) {
          const ended=terminal(result.runState);
          update(ctx.db,'runs',run.id,{status:result.runState,revision:latest.revision+1,
            ...(ended?{completionEvidenceRef:result.evidenceRef,finishedAt:ctx.clock.now()}:{} )});
          if(ended)ctx.db.prepare("UPDATE pending_inputs SET validity='closed_by_run',revision=revision+1 WHERE runId=? AND validity='open'").run(run.id);
          if(result.runState==='failed') {
            const target=ctx.db.prepare('SELECT p.recipientId FROM courier_sessions c JOIN platform_conversations p ON p.id=c.platformConversationId WHERE c.id=?')
              .get(run.courierSessionId) as {recipientId:string};
            reportFailure(ctx,{recipientId:target.recipientId,runId:run.id},'run_failed');
          }
          projectOutput(ctx,run.id);
        }
      }
    }
    return true;
  });
}
