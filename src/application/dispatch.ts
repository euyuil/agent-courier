import type { DisplayPolicy } from '../config/schema.js';
import { newId } from '../domain/common.js';
import { CourierError } from '../domain/errors.js';
import type { InboundInput } from '../domain/input.js';
import type { CourierSession, HarnessBinding } from '../domain/session.js';
import { terminal, type HarnessOperation, type Run } from '../domain/run.js';
import type { Receipt } from '../adapters/harness/port.js';
import { byId, insert, update } from '../storage/records.js';
import { transaction } from '../storage/database.js';
import { activeRun } from '../storage/runs.js';
import { enqueue } from '../storage/delivery.js';
import { checkHarness, ensureBinding } from './sessions.js';
import type { Runtime } from './runtime.js';
import { diagnostic } from './diagnostics.js';
import type { AcceptResult } from './courier.js';
import { hasPending } from '../storage/pending-inputs.js';
import { parseReply } from '../adapters/dingtalk/reply-parser.js';
import { routeAnswer } from './answer-routing.js';
import type { PendingInput } from '../domain/pending-input.js';
import { updateWaiting } from './pending-inputs.js';
import { normalizeReceipt } from '../adapters/harness/receipt.js';
import { reportFailure } from './failure-reporting.js';

export async function dispatchInput(ctx: Runtime,input: InboundInput,courierId: string,text: string,policy: DisplayPolicy): Promise<AcceptResult> {
  const courier=byId<CourierSession>(ctx.db,'courier_sessions',courierId)!;
  const parsed=parseReply(text,hasPending(ctx.db,input.platformConversationId));
  if(parsed.kind==='invalid' || parsed.kind==='ambiguous')throw new CourierError('request_invalid');
  if(parsed.kind==='reply' || parsed.kind==='permission')return routeAnswer(ctx,input,courier,parsed);
  text=parsed.text;
  const binding=await ensureBinding(ctx,courier);
  await checkHarness(ctx);
  await ctx.answerPriority.get(courier.id);
  let run!: Run, operation!: HarnessOperation;
  transaction(ctx.db,()=>{
    const currentBinding=byId<HarnessBinding>(ctx.db,'harness_bindings',binding.id)!;
    if (currentBinding.status!=='ready') throw new CourierError('state_unknown');
    const active=activeRun(ctx.db,courierId);
    if (active && (!active.harnessRunRef || active.status==='unknown')) throw new CourierError('state_unknown');
    if (active) { run=active; input.mode='steer'; }
    else {
      input.mode='start';run={id:newId<'run'>(),courierSessionId:courierId,bindingId:binding.id,initialInputId:input.id,status:'submitting',revision:0,policySnapshot:policy,startedAt:ctx.clock.now()};
      update(ctx.db,'courier_sessions',courierId,{policyRevision:policy.revision});
      insert(ctx.db,'runs',run);
    }
    operation={id:newId<'operation'>(),bindingId:binding.id,inputId:input.id,runId:run.id,kind:input.mode,status:'prepared'};
    if (input.mode==='steer') operation.expectedRunRef=run.harnessRunRef!;
    insert(ctx.db,'harness_operations',operation);
    update(ctx.db,'harness_operations',operation.id,{status:'dispatching',startedAt:ctx.clock.now()});
    update(ctx.db,'inputs',input.id,{mode:input.mode,runId:run.id,status:'dispatching'});
  });
  ctx.effectBoundary?.('before_call',operation.kind);
  let receipt: Receipt;
  try {
    const handle=operation.kind==='start'
      ?ctx.harness.start({operationId:operation.id,inputId:input.id,sessionRef:binding.harnessSessionId!,text,clientRunId:run.id})
      :ctx.harness.steer({operationId:operation.id,inputId:input.id,sessionRef:binding.harnessSessionId!,expectedRunRef:run.harnessRunRef!,text});
    receipt=normalizeReceipt(await handle.receipt,{sessionRef:binding.harnessSessionId!,requiresRun:true,...(operation.kind==='steer'?{runRef:run.harnessRunRef!}:{})});
  } catch { receipt={status:'unknown',errorCode:'state_unknown'}; }
  ctx.effectBoundary?.('after_remote',operation.kind);
  recordReceipt(ctx,operation,receipt);
  ctx.effectBoundary?.('after_commit',operation.kind);
  return {status:byId<InboundInput>(ctx.db,'inputs',input.id)!.status as AcceptResult['status'],inputId:input.id};
}
export function recordReceipt(ctx: Runtime,operation: HarnessOperation,receipt: Receipt): void {
  transaction(ctx.db,()=>{
    const existing=byId<HarnessOperation>(ctx.db,'harness_operations',operation.id)!;
    if (['accepted','rejected'].includes(existing.status) && receipt.status==='unknown') return;
    if (['accepted','rejected'].includes(existing.status) && existing.status!==receipt.status) {
      operationConflict(ctx,operation);return;
    }
    const binding=byId<HarnessBinding>(ctx.db,'harness_bindings',operation.bindingId)!;
    const run=operation.runId?byId<Run>(ctx.db,'runs',operation.runId):undefined;
    const pending=operation.pendingInputId?byId<PendingInput>(ctx.db,'pending_inputs',operation.pendingInputId):undefined;
    if(receipt.status==='unknown'&&receipt.errorCode==='protocol_conflict') {
      update(ctx.db,'harness_bindings',binding.id,{status:'unknown'});ctx.diagnostics.push({code:'protocol_conflict',localId:operation.id});
    }
    if (receipt.status==='accepted' && (receipt.sessionRef!==binding.harnessSessionId || !receipt.receiptEvidence
      || (run?.harnessRunRef && receipt.runRef && receipt.runRef!==run.harnessRunRef)
      || (pending && receipt.vendorRequestId!==pending.vendorRequestId))) {
      operationConflict(ctx,operation);return;
    }
    update(ctx.db,'harness_operations',operation.id,{status:receipt.status,...(receipt.status==='accepted'?{evidenceRef:receipt.receiptEvidence}:{resultCode:receipt.errorCode})});
    if (operation.inputId) {
      const previous=byId<InboundInput>(ctx.db,'inputs',operation.inputId)!;
      update(ctx.db,'inputs',operation.inputId,{status:receipt.status,...(receipt.status==='accepted'?{acceptedAt:previous.acceptedAt??ctx.clock.now()}:{errorCode:receipt.errorCode})});
    }
    if(pending) {
      update(ctx.db,'pending_inputs',pending.id,{answerStatus:receipt.status,revision:pending.revision+1});
      updateWaiting(ctx,pending.runId);
    }
    if (run && !terminal(run.status) && operation.kind==='start') {
      if (receipt.status==='accepted') update(ctx.db,'runs',run.id,{status:run.status==='unknown'?'unknown':run.status==='waiting_input'?'waiting_input':'running',harnessRunRef:receipt.runRef??run.harnessRunRef,revision:run.revision+1});
      else if (receipt.status==='rejected') update(ctx.db,'runs',run.id,{status:'not_started',revision:run.revision+1,finishedAt:ctx.clock.now()});
      else if (!run.harnessRunRef) update(ctx.db,'runs',run.id,{status:'unknown',revision:run.revision+1});
    }
    if (receipt.status!=='accepted' && operation.inputId) {
      const input=byId<InboundInput>(ctx.db,'inputs',operation.inputId)!;
      const target=ctx.db.prepare('SELECT recipientId FROM platform_conversations WHERE id=?').get(input.platformConversationId) as {recipientId:string};
      enqueue(ctx.db,{recipientId:target.recipientId,inputId:input.id,payload:diagnostic(receipt.errorCode,receipt.status==='unknown'?'unknown':'not_submitted').message});
    }
  });
}
function operationConflict(ctx:Runtime,operation:HarnessOperation):void {
  ctx.diagnostics.push({code:'protocol_conflict',localId:operation.id});
  update(ctx.db,'harness_bindings',operation.bindingId,{status:'unknown'});
  const current=byId<HarnessOperation>(ctx.db,'harness_operations',operation.id)!;
  update(ctx.db,'harness_operations',operation.id,{resultCode:'protocol_conflict',...(current.status==='dispatching'?{status:'unknown'}:{})});
  if(operation.inputId) {
    const input=byId<InboundInput>(ctx.db,'inputs',operation.inputId)!;
    if(input.status==='dispatching')update(ctx.db,'inputs',input.id,{status:'unknown',errorCode:'protocol_conflict'});
    const target=ctx.db.prepare('SELECT recipientId FROM platform_conversations WHERE id=?').get(input.platformConversationId) as {recipientId:string};
    reportFailure(ctx,{recipientId:target.recipientId,inputId:input.id,...(operation.runId?{runId:operation.runId}:{})},'protocol_conflict');
  }
}
