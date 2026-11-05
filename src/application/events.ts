import type { HarnessEvent } from '../adapters/harness/events.js';
import { outputKinds } from '../adapters/harness/events.js';
import type { Runtime } from './runtime.js';
import type { HarnessBinding } from '../domain/session.js';
import { terminal, type Run, type HarnessOperation } from '../domain/run.js';
import type { OutputMessage } from '../domain/output.js';
import { newId } from '../domain/common.js';
import { transaction } from '../storage/database.js';
import { byId, decode, insert, update } from '../storage/records.js';
import { putContent, getContent } from '../storage/content.js';
import { outputBySource } from '../storage/output.js';
import { recordReceipt } from './dispatch.js';
import { reportFailure } from './failure-reporting.js';
import { registerRequest,invalidateRequest } from './pending-inputs.js';
import { projectOutput } from './output-projector.js';
import { addFragment,completeMessage,invalidateMessage } from '../delivery/assemble.js';
import { policyKey } from '../domain/display-policy.js';

export function consumeEvent(ctx: Runtime,bindingId: string,event: HarnessEvent): void {
  transaction(ctx.db,()=>{
    const binding=byId<HarnessBinding>(ctx.db,'harness_bindings',bindingId);
    if (!binding || event.sessionRef!==binding.harnessSessionId || !event.eventKey) { ctx.diagnostics.push({code:'protocol_conflict'});return; }
    const prior=ctx.db.prepare('SELECT payloadRef FROM harness_events WHERE bindingId=? AND sourceEventKey=?').get(bindingId,event.eventKey) as {payloadRef:string}|undefined;
    if (prior) {
      if (getContent(ctx.db,prior.payloadRef)!==JSON.stringify(event)) {
        update(ctx.db,'harness_bindings',binding.id,{status:'unknown'});ctx.diagnostics.push({code:'protocol_conflict',localId:binding.id});
      }
      return;
    }
    let run=decode<Run>(ctx.db.prepare('SELECT * FROM runs WHERE bindingId=? AND harnessRunRef=?').get(bindingId,event.runRef));
    if (!run && event.eventType==='run.started') {
      run=byId<Run>(ctx.db,'runs',event.payload.clientRunId);
      if (run?.bindingId!==bindingId || (run.harnessRunRef && run.harnessRunRef!==event.runRef)) { ctx.diagnostics.push({code:'protocol_conflict'});return; }
    }
    if (!run) { ctx.diagnostics.push({code:'output_unsupported',localId:bindingId});return; }
    switch(event.eventType) {
      case 'run.started': {
        if (!terminal(run.status)) update(ctx.db,'runs',run.id,{harnessRunRef:event.runRef,status:'running',revision:run.revision+1});
        const operation=decode<HarnessOperation>(ctx.db.prepare("SELECT * FROM harness_operations WHERE runId=? AND kind='start'").get(run.id));
        if(operation)recordReceipt(ctx,operation,{status:'accepted',sessionRef:event.sessionRef,runRef:event.runRef,receiptEvidence:`source-event:${event.eventKey}`});
        break;
      }
      case 'input.accepted': {
        const operation=byId<HarnessOperation>(ctx.db,'harness_operations',event.payload.operationId);
        if (!operation || operation.runId!==run.id || operation.inputId!==event.payload.inputId) { ctx.diagnostics.push({code:'protocol_conflict'});break; }
        const request=operation.pendingInputId?ctx.db.prepare('SELECT vendorRequestId FROM pending_inputs WHERE id=?').get(operation.pendingInputId) as {vendorRequestId:string}|undefined:undefined;
        recordReceipt(ctx,operation,{status:'accepted',sessionRef:event.sessionRef,runRef:event.runRef,receiptEvidence:event.payload.receiptEvidence,...(request?{vendorRequestId:request.vendorRequestId}:{})});break;
      }
      case 'input.applied': {
        const input=ctx.db.prepare('SELECT id FROM inputs WHERE id=? AND runId=?').get(event.payload.inputId,run.id);
        if (input && event.payload.appliedEvidence) {
          update(ctx.db,'inputs',event.payload.inputId,{appliedEvidenceRef:event.payload.appliedEvidence});
          const operation=decode<HarnessOperation>(ctx.db.prepare('SELECT * FROM harness_operations WHERE inputId=? AND runId=?').get(event.payload.inputId,run.id));
          const pending=operation?.pendingInputId?ctx.db.prepare('SELECT vendorRequestId FROM pending_inputs WHERE id=?').get(operation.pendingInputId) as {vendorRequestId:string}|undefined:undefined;
          if(operation)recordReceipt(ctx,operation,{status:'accepted',sessionRef:event.sessionRef,runRef:event.runRef,receiptEvidence:event.payload.appliedEvidence,...(pending?{vendorRequestId:pending.vendorRequestId}:{})});
        }break;
      }
      case 'run.completed': case 'run.failed': {
        if (!event.payload.completionEvidence) { ctx.diagnostics.push({code:'protocol_conflict'});break; }
        const status=event.eventType==='run.completed'?'completed':'failed';
        if (terminal(run.status)) {
          if (run.status!==status) {
            ctx.diagnostics.push({code:'protocol_conflict',localId:run.id});update(ctx.db,'harness_bindings',binding.id,{status:'unknown'});
            const target=ctx.db.prepare('SELECT p.recipientId FROM courier_sessions c JOIN platform_conversations p ON p.id=c.platformConversationId WHERE c.id=?').get(run.courierSessionId) as {recipientId:string};
            reportFailure(ctx,{recipientId:target.recipientId,runId:run.id},'protocol_conflict');
          }
          break;
        } else update(ctx.db,'runs',run.id,{status,completionEvidenceRef:event.payload.completionEvidence,finishedAt:ctx.clock.now(),revision:run.revision+1});
        ctx.db.prepare("UPDATE pending_inputs SET validity='closed_by_run',revision=revision+1 WHERE runId=? AND validity='open'").run(run.id);
        const target=ctx.db.prepare('SELECT p.recipientId FROM courier_sessions c JOIN platform_conversations p ON p.id=c.platformConversationId WHERE c.id=?').get(run.courierSessionId) as {recipientId:string};
        if(status==='failed')reportFailure(ctx,{recipientId:target.recipientId,runId:run.id},'run_failed');
        break;
      }
      case 'message.started': {
        if (!outputKinds.includes(event.payload.kind)) {
          ctx.diagnostics.push({code:'output_unsupported',localId:run.id});
          const target=ctx.db.prepare('SELECT p.recipientId FROM courier_sessions c JOIN platform_conversations p ON p.id=c.platformConversationId WHERE c.id=?').get(run.courierSessionId) as {recipientId:string};
          reportFailure(ctx,{recipientId:target.recipientId,runId:run.id},'output_unsupported');break;
        }
        const existing=outputBySource(ctx.db,run.id,event.payload.messageId);
        if (existing) {
          if(existing.kind!==event.payload.kind || existing.userVisible!==event.payload.userVisible)invalidateMessage(ctx,existing);
          break;
        }
        if(terminal(run.status)){ctx.diagnostics.push({code:'output_unsupported',localId:run.id});break;}
        const sequence=ctx.db.prepare('SELECT coalesce(max(logicalSequence),0)+1 AS n FROM output_messages WHERE runId=?').get(run.id) as {n:number};
        const selected=event.payload.userVisible && run.policySnapshot[policyKey(event.payload.kind)];
        const message:OutputMessage={id:newId<'output-message'>(),runId:run.id,sourceMessageId:event.payload.messageId,kind:event.payload.kind,
          userVisible:event.payload.userVisible,logicalSequence:sequence.n,completeness:'assembling',selected,contentRef:putContent(ctx.db,'')};
        if (!selected) message.hiddenReason=event.payload.userVisible?'policy':'not_user_visible';
        insert(ctx.db,'output_messages',message);break;
      }
      case 'message.fragment': {
        const message=outputBySource(ctx.db,run.id,event.payload.messageId);
        if(message)addFragment(ctx,message,event.payload);else ctx.diagnostics.push({code:'output_unsupported',localId:run.id});
        break;
      }
      case 'message.completed': {
        const message=outputBySource(ctx.db,run.id,event.payload.messageId);
        if(message)completeMessage(ctx,message,event.payload.finalFragmentIndex);else ctx.diagnostics.push({code:'output_unsupported',localId:run.id});
        break;
      }
      case 'connection.lost':
        for (const id of event.payload.unresolvedOperationIds) {
          const op=byId<HarnessOperation>(ctx.db,'harness_operations',id);
          if (op?.bindingId===binding.id && op.status==='dispatching') recordReceipt(ctx,op,{status:'unknown',errorCode:'state_unknown'});
        }
        break;
      case 'input.requested':registerRequest(ctx,run,event.payload);break;
      case 'input.invalidated':invalidateRequest(ctx,run.id,event.payload.vendorRequestId,event.payload.reason);break;
      case 'run.waiting_input':if(!terminal(run.status))update(ctx.db,'runs',run.id,{status:'waiting_input',revision:run.revision+1});break;
      default: ctx.diagnostics.push({code:'output_unsupported',localId:run.id});
    }
    projectOutput(ctx,run.id);
    insert(ctx.db,'harness_events',{id:newId<'event'>(),bindingId,runId:run.id,sourceEventKey:event.eventKey,eventType:event.eventType,
      sequence:event.sourceSequence,payloadRef:putContent(ctx.db,JSON.stringify(event)),processedAt:ctx.clock.now()});
    ctx.eventBoundary?.('before_commit');
  });
  ctx.eventBoundary?.('after_commit');
}
