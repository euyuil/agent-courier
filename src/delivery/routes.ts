import type { DeliveryRoute, Recipient } from '../adapters/dingtalk/port.js';
import type { CapabilityEvidence } from '../domain/capabilities.js';
import { evidenceValid } from '../domain/capabilities.js';
import type { Runtime } from '../application/runtime.js';
import { decode } from '../storage/records.js';
import { routeBudget } from './limits.js';
import { platformFingerprint } from '../adapters/testing/evidence.js';
export function selectRoute(ctx:Runtime,recipient:Recipient):{route?:DeliveryRoute;nextAt?:number} {
  const routes=ctx.db.prepare("SELECT * FROM delivery_routes WHERE recipientId=? AND status='ready' ORDER BY CASE kind WHEN 'sessionWebhook' THEN 0 ELSE 1 END,rowid DESC").all(recipient.id);
  let nextAt:number|undefined;
  for(const row of routes) {
    const route=decode<DeliveryRoute>(row)!;
    if(route.expiresAt!==undefined && route.expiresAt<=ctx.clock.now())continue;
    const raw=ctx.db.prepare('SELECT * FROM capability_evidence WHERE id=?').get(route.capabilityEvidenceId);
    const evidence=decode<CapabilityEvidence>(raw);
    const target=ctx.config.platform.kind==='fake'?{kind:'fake' as const,productVersion:'1',adapterVersion:'1',contextFingerprint:platformFingerprint(ctx.config,route.verifiedLimits)}:ctx.platformEvidenceTarget;
    if(!target || !evidence || !evidenceValid(evidence,target,ctx.clock.now(),route.kind==='oto'?'oto':'delivery'))continue;
    const budget=routeBudget(ctx,recipient,route);
    if(budget.available)return {route};
    if(budget.nextAt!==undefined)nextAt=Math.min(nextAt??Infinity,budget.nextAt);
  }
  return nextAt===undefined?{}:{nextAt};
}
