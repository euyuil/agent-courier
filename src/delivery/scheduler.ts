import type { Runtime } from '../application/runtime.js';
import type { OutboundDelivery } from '../domain/delivery.js';
import { byId,decode } from '../storage/records.js';
import { sendOne } from './dispatch.js';
const busy=new WeakMap<Runtime,Set<string>>();
export async function flushDeliveries(ctx:Runtime):Promise<void> {
  let running=busy.get(ctx);if(!running){running=new Set();busy.set(ctx,running);}
  const recipients=ctx.db.prepare("SELECT DISTINCT recipientId FROM outbound_deliveries WHERE status IN ('pending','retry_wait')").all() as {recipientId:string}[];
  await Promise.all(recipients.map(async({recipientId})=>{
    if(running.has(recipientId))return;running.add(recipientId);
    try {
      for(;;) {
        const next=decode<OutboundDelivery>(ctx.db.prepare("SELECT * FROM outbound_deliveries WHERE recipientId=? AND status NOT IN ('delivered','failed') ORDER BY deliverySequence LIMIT 1").get(recipientId));
        if(!next || !['pending','retry_wait'].includes(next.status) || (next.nextAttemptAt??0)>ctx.clock.now())return;
        await sendOne(ctx,next);
        if(['pending','retry_wait','unknown','sending'].includes(byId<OutboundDelivery>(ctx.db,'outbound_deliveries',next.id)!.status))return;
      }
    } finally {running.delete(recipientId);}
  }));
}
