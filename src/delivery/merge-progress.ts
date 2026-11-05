import type { Runtime } from '../application/runtime.js';
import type { OutboundDelivery } from '../domain/delivery.js';
import type { Run } from '../domain/run.js';
import type { Recipient } from '../domain/platform.js';
import type { OutputMessage } from '../domain/output.js';
import { byId,decode,update } from '../storage/records.js';
import { getContent,putContent } from '../storage/content.js';
import { selectRoute } from './routes.js';
import { textLength } from './limits.js';

export function mergeProgress(ctx:Runtime):void {
  const rows=ctx.db.prepare('SELECT * FROM outbound_deliveries ORDER BY recipientId,deliverySequence').all();
  let previous:OutboundDelivery|undefined;
  for(const row of rows) {
    const current=decode<OutboundDelivery>(row)!;
    const run=current.runId?byId<Run>(ctx.db,'runs',current.runId):undefined;
    const eligible=run?.policySnapshot.mergeAdjacentProgress && current.status==='pending' && current.attemptCount===0
      && current.logicalMessageIds.length>0 && current.logicalMessageIds.every(id=>byId<OutputMessage>(ctx.db,'output_messages',id)?.kind==='progress');
    if(!eligible){previous=undefined;continue;}
    if(previous && previous.runId===current.runId && previous.recipientId===current.recipientId) {
      const left=byId<OutputMessage>(ctx.db,'output_messages',previous.logicalMessageIds.at(-1)!)!;
      const right=byId<OutputMessage>(ctx.db,'output_messages',current.logicalMessageIds[0]!)!;
      const recipient=byId<Recipient>(ctx.db,'recipients',current.recipientId)!;
      const route=selectRoute(ctx,recipient).route;
      const payload=getContent(ctx.db,previous.payloadRef)+'\n'+getContent(ctx.db,current.payloadRef);
      if(route && left.logicalSequence+1===right.logicalSequence && textLength(payload,route.verifiedLimits.lengthUnit)<=route.verifiedLimits.maxTextLength) {
        const ids=[...previous.logicalMessageIds,...current.logicalMessageIds];
        const contentRef=putContent(ctx.db,payload);
        update(ctx.db,'outbound_deliveries',previous.id,{payloadRef:contentRef,logicalMessageIds:ids});
        ctx.db.prepare('UPDATE delivery_messages SET deliveryId=? WHERE deliveryId=?').run(previous.id,current.id);
        ctx.db.prepare('DELETE FROM outbound_deliveries WHERE id=? AND attemptCount=0').run(current.id);
        previous={...previous,payloadRef:contentRef,logicalMessageIds:ids};continue;
      }
    }
    previous=current;
  }
}
