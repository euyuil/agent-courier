import type { Runtime } from './runtime.js';
import type { InboundInput } from '../domain/input.js';
import type { CourierSession,HarnessBinding } from '../domain/session.js';
import type { Run,HarnessOperation } from '../domain/run.js';
import { terminal } from '../domain/run.js';
import type { PendingInput } from '../domain/pending-input.js';
import { validateAnswer,type Answer } from '../domain/answer.js';
import type { Receipt } from '../adapters/harness/port.js';
import type { ParsedReply } from '../adapters/dingtalk/reply-parser.js';
import { CourierError } from '../domain/errors.js';
import { newId } from '../domain/common.js';
import { pendingByCode } from '../storage/pending-inputs.js';
import { byId,insert,update } from '../storage/records.js';
import { transaction } from '../storage/database.js';
import { checkHarness,ensureBinding } from './sessions.js';
import { recordReceipt } from './dispatch.js';
import type { AcceptResult } from './courier.js';
import { normalizeReceipt } from '../adapters/harness/receipt.js';

export async function routeAnswer(ctx:Runtime,input:InboundInput,courier:CourierSession,parsed:Extract<ParsedReply,{kind:'reply'|'permission'}>):Promise<AcceptResult> {
  const pending=pendingByCode(ctx.db,input.platformConversationId,parsed.code);
  if(!pending || pending.validity!=='open' || !['none','rejected'].includes(pending.answerStatus))throw new CourierError('request_invalid');
  if(!pending.promptRef)throw new CourierError('interaction_blocked');
  let answer:Answer|undefined;
  if(parsed.kind==='reply' && pending.kind==='question' && pending.answerSchema)answer=validateAnswer(pending.answerSchema,parsed.text);
  if(parsed.kind==='permission' && pending.kind==='permission') {
    const options=pending.options?.filter(option=>option.decision===parsed.decision)??[];
    const selected=parsed.optionCode?options.find(option=>option.code===parsed.optionCode):options.length===1?options[0]:undefined;
    if(selected)answer={kind:'permission',decision:parsed.decision,optionCode:selected.code};
  }
  if(!answer)throw new CourierError('request_invalid');
  let release!:()=>void;
  const priority=new Promise<void>(resolve=>{release=resolve;});
  const previous=ctx.answerPriority.get(courier.id);ctx.answerPriority.set(courier.id,priority);
  try {
    if(previous)await previous;
    const binding=await ensureBinding(ctx,courier);await checkHarness(ctx);
    let operation!:HarnessOperation,run!:Run;
    transaction(ctx.db,()=>{
      const current=byId<PendingInput>(ctx.db,'pending_inputs',pending.id)!;
      run=byId<Run>(ctx.db,'runs',pending.runId)!;
      const currentBinding=byId<HarnessBinding>(ctx.db,'harness_bindings',pending.bindingId)!;
      if(current.revision!==pending.revision || current.validity!=='open' || !['none','rejected'].includes(current.answerStatus)
        || run.bindingId!==binding.id || currentBinding.status!=='ready' || !run.harnessRunRef || terminal(run.status) || run.status==='unknown')throw new CourierError('request_invalid');
      operation={id:newId<'operation'>(),bindingId:binding.id,inputId:input.id,runId:run.id,pendingInputId:pending.id,kind:'answer',expectedRunRef:run.harnessRunRef,status:'prepared'};
      insert(ctx.db,'harness_operations',operation);update(ctx.db,'harness_operations',operation.id,{status:'dispatching',startedAt:ctx.clock.now()});
      update(ctx.db,'inputs',input.id,{mode:'answer',runId:run.id,pendingInputId:pending.id,status:'dispatching'});
      update(ctx.db,'pending_inputs',pending.id,{answerStatus:'dispatching',answerInputId:input.id,revision:current.revision+1});
    });
    ctx.effectBoundary?.('before_call','answer');
    let receipt:Receipt;
    try {
      const handle=ctx.harness.answer({operationId:operation.id,inputId:input.id,sessionRef:binding.harnessSessionId!,runRef:run.harnessRunRef!,vendorRequestId:pending.vendorRequestId,answer});
      release();receipt=normalizeReceipt(await handle.receipt,{sessionRef:binding.harnessSessionId!,runRef:run.harnessRunRef!,requestId:pending.vendorRequestId,requiresRun:true});
    } catch {release();receipt={status:'unknown',errorCode:'state_unknown'};}
    ctx.effectBoundary?.('after_remote','answer');recordReceipt(ctx,operation,receipt);ctx.effectBoundary?.('after_commit','answer');
    return {status:byId<InboundInput>(ctx.db,'inputs',input.id)!.status as AcceptResult['status'],inputId:input.id};
  } finally {release();if(ctx.answerPriority.get(courier.id)===priority)ctx.answerPriority.delete(courier.id);}
}
