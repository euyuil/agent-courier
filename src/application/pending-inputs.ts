import type { EventPayloads } from '../adapters/harness/events.js';
import type { PendingInput } from '../domain/pending-input.js';
import type { Run } from '../domain/run.js';
import { terminal } from '../domain/run.js';
import { newId } from '../domain/common.js';
import { byId,decode,insert,update } from '../storage/records.js';
import { outputBySource } from '../storage/output.js';
import { pendingByRequest } from '../storage/pending-inputs.js';
import type { Runtime } from './runtime.js';
import { presentRequest } from './interaction-presenter.js';
import { answerSchemaSchema,permissionOptionsSchema } from '../domain/answer.js';
import { invalidateMessage } from '../delivery/assemble.js';
import { reportFailure } from './failure-reporting.js';

export function registerRequest(ctx:Runtime,run:Run,payload:EventPayloads['input.requested']):void {
  const prior=pendingByRequest(ctx.db,run.id,payload.vendorRequestId);
  const byMessage=decode<PendingInput>(ctx.db.prepare('SELECT * FROM pending_inputs WHERE runId=? AND sourceMessageId=?').get(run.id,payload.messageId));
  if(prior || byMessage) {
    if(prior?.id!==byMessage?.id || prior?.kind!==payload.kind || prior.adapterMappingRef!==payload.adapterMappingRef
      || JSON.stringify(prior.answerSchema)!==JSON.stringify(payload.answerSchema) || JSON.stringify(prior.options)!==JSON.stringify(payload.options)) {
      ctx.diagnostics.push({code:'protocol_conflict',localId:run.id});update(ctx.db,'harness_bindings',run.bindingId,{status:'unknown'});return;
    }
    presentRequest(ctx,prior);return;
  }
  const output=outputBySource(ctx.db,run.id,payload.messageId);
  if(output && output.kind!==(payload.kind==='question'?'question':'permission_request')){
    invalidateMessage(ctx,output);update(ctx.db,'harness_bindings',run.bindingId,{status:'unknown'});return;
  }
  if(!payload.vendorRequestId || !payload.messageId || !payload.adapterMappingRef || (payload.kind==='question'&&!payload.answerSchema)
    || (payload.kind==='question'&&!answerSchemaSchema.safeParse(payload.answerSchema).success)
    || (payload.kind==='permission'&&!permissionOptionsSchema.safeParse(payload.options).success)) {
    ctx.diagnostics.push({code:'interaction_blocked',localId:run.id});
    const target=ctx.db.prepare('SELECT p.recipientId FROM courier_sessions c JOIN platform_conversations p ON p.id=c.platformConversationId WHERE c.id=?').get(run.courierSessionId) as {recipientId:string};
    reportFailure(ctx,{recipientId:target.recipientId,runId:run.id},'interaction_blocked');
    if(!terminal(run.status)&&run.status!=='unknown')update(ctx.db,'runs',run.id,{status:'waiting_input',revision:run.revision+1});return;
  }
  const courier=ctx.db.prepare('SELECT platformConversationId FROM courier_sessions WHERE id=?').get(run.courierSessionId) as {platformConversationId:string};
  let publicCode:string;
  do {publicCode=(payload.kind==='question'?'Q':'P')+newId<'code'>().replaceAll('-','').slice(0,8).toUpperCase();}
  while(ctx.db.prepare('SELECT 1 FROM pending_inputs WHERE platformConversationId=? AND publicCode=?').get(courier.platformConversationId,publicCode));
  const pending:PendingInput={id:newId<'pending-input'>(),runId:run.id,bindingId:run.bindingId,platformConversationId:courier.platformConversationId,
    vendorRequestId:payload.vendorRequestId,sourceMessageId:payload.messageId,kind:payload.kind,publicCode,adapterMappingRef:payload.adapterMappingRef,
    validity:terminal(run.status)?'closed_by_run':'open',answerStatus:'none',revision:0,
    ...(payload.answerSchema?{answerSchema:payload.answerSchema}:{}),...(payload.options?{options:payload.options}:{})};
  insert(ctx.db,'pending_inputs',pending);updateWaiting(ctx,run.id);presentRequest(ctx,pending);
}
export function updateWaiting(ctx:Runtime,runId:string):void {
  const run=byId<Run>(ctx.db,'runs',runId)!;if(terminal(run.status)||run.status==='unknown')return;
  const waiting=ctx.db.prepare("SELECT 1 FROM pending_inputs WHERE runId=? AND validity='open' AND answerStatus!='accepted' LIMIT 1").get(run.id);
  if(waiting)update(ctx.db,'runs',run.id,{status:'waiting_input',revision:run.revision+1});
  else if(run.status==='waiting_input')update(ctx.db,'runs',run.id,{status:'running',revision:run.revision+1});
}
export function invalidateRequest(ctx:Runtime,runId:string,vendorRequestId:string,validity:'withdrawn'|'expired'):void {
  const pending=pendingByRequest(ctx.db,runId,vendorRequestId);
  if(pending?.validity==='open')update(ctx.db,'pending_inputs',pending.id,{validity,revision:pending.revision+1});
  updateWaiting(ctx,runId);
}
