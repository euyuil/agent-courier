import { newId } from '../domain/common.js';
import { CourierError } from '../domain/errors.js';
import type { CourierSession, HarnessBinding } from '../domain/session.js';
import type { HarnessOperation } from '../domain/run.js';
import type { Receipt } from '../adapters/harness/port.js';
import { assertAdmission } from '../adapters/harness/admission.js';
import { transaction } from '../storage/database.js';
import { saveEvidence, saveInstance } from '../storage/capabilities.js';
import { bindingFor } from '../storage/sessions.js';
import { byId, decode, insert, update } from '../storage/records.js';
import type { CapabilityEvidence } from '../domain/capabilities.js';
import type { Runtime } from './runtime.js';
import { consumeEvent } from './events.js';
import { normalizeReceipt } from '../adapters/harness/receipt.js';

export async function checkHarness(ctx: Runtime): Promise<void> {
  const report = await ctx.harness.probe(ctx.config.harness.instanceId);
  if((report.kind==='fake')!==(ctx.config.harness.adapter==='mock'))throw new CourierError('capability_unverified');
  report.evidenceRefs=report.evidenceRefs.map(evidence=>decode<CapabilityEvidence>(ctx.db.prepare('SELECT * FROM capability_evidence WHERE id=?').get(evidence.id))??evidence);
  assertAdmission(report,ctx.clock.now());
  transaction(ctx.db, () => {
    for (const evidence of report.evidenceRefs) {
      if (!ctx.db.prepare('SELECT id FROM capability_evidence WHERE id=?').get(evidence.id)) saveEvidence(ctx.db,evidence);
    }
    saveInstance(ctx.db,{ id: ctx.config.harness.instanceId, adapterKind: ctx.config.harness.adapter, productVersion: report.productVersion,
      capabilityEvidenceId: report.evidenceRefs[0]!.id, readiness: 'supported', ...(report.cliVersion ? { cliVersion: report.cliVersion } : {}) });
  });
}
export function subscribe(ctx: Runtime, binding: HarnessBinding): void {
  if (!binding.harnessSessionId || ctx.subscriptions.has(binding.id)) return;
  const unsubscribe = ctx.harness.subscribe(binding.harnessSessionId,event => {
    if (ctx.closed) return;
    consumeEvent(ctx,binding.id,event);
  });
  ctx.subscriptions.set(binding.id,unsubscribe);
}
export async function ensureBinding(ctx: Runtime, courier: CourierSession): Promise<HarnessBinding> {
  if (courier.harnessInstanceId !== ctx.config.harness.instanceId) throw new CourierError('unconfigured');
  let binding = bindingFor(ctx.db,courier.id);
  if(binding?.status==='unknown')throw new CourierError('state_unknown');
  if (binding?.harnessSessionId && ctx.loaded.has(binding.id) && binding.status === 'ready') return binding;
  if (binding && !binding.harnessSessionId) throw new CourierError('state_unknown');
  await checkHarness(ctx);
  let operation: HarnessOperation;
  const creating = !binding;
  transaction(ctx.db, () => {
    const current = bindingFor(ctx.db,courier.id);
    if (creating && current) throw new CourierError('state_unknown');
    if (!binding) {
      const opId = newId<'operation'>();
      binding = { id: newId<'binding'>(), courierSessionId: courier.id, harnessInstanceId: courier.harnessInstanceId,
        status: 'reserved', createOperationId: opId, revision: 0 };
      insert(ctx.db,'harness_bindings',binding);
      operation = { id: opId, bindingId: binding.id, kind: 'create', status: 'prepared' };
    } else {
      operation = { id: newId<'operation'>(), bindingId: binding.id, kind: 'load', status: 'prepared' };
    }
    insert(ctx.db,'harness_operations',operation);
    update(ctx.db,'harness_operations',operation.id,{status:'dispatching',startedAt:ctx.clock.now()});
    if (creating) update(ctx.db,'harness_bindings',binding.id,{status:'creating',revision:binding.revision+1});
  });
  ctx.effectBoundary?.('before_call',operation!.kind);
  let receipt: Receipt;
  try {
    const handle = creating ? ctx.harness.createSession({operationId:operation!.id,courierSessionId:courier.id})
      : ctx.harness.resumeSession({operationId:operation!.id,sessionRef:binding!.harnessSessionId!});
    receipt = normalizeReceipt(await handle.receipt,creating?{}:{sessionRef:binding!.harnessSessionId!});
  } catch { receipt = {status:'unknown',errorCode:'state_unknown'}; }
  ctx.effectBoundary?.('after_remote',operation!.kind);
  transaction(ctx.db, () => {
    update(ctx.db,'harness_operations',operation!.id,{status:receipt.status,...(receipt.status==='accepted'?{evidenceRef:receipt.receiptEvidence}:{resultCode:receipt.errorCode})});
    if (receipt.status==='accepted') {
      if (!receipt.sessionRef || (binding!.harnessSessionId && receipt.sessionRef!==binding!.harnessSessionId)) throw new CourierError('protocol_conflict');
      update(ctx.db,'harness_bindings',binding!.id,{harnessSessionId:receipt.sessionRef,status:'ready',revision:binding!.revision+1});
    } else update(ctx.db,'harness_bindings',binding!.id,{status:receipt.status==='unknown'?'unknown':receipt.errorCode==='writer_occupied'?'writer_conflict':creating?'blocked':'unavailable',revision:binding!.revision+1});
  });
  ctx.effectBoundary?.('after_commit',operation!.kind);
  if (receipt.status!=='accepted') throw new CourierError(receipt.errorCode);
  binding = byId<HarnessBinding>(ctx.db,'harness_bindings',binding!.id)!;
  ctx.loaded.add(binding.id); subscribe(ctx,binding); return binding;
}
