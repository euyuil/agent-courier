import type { DeliveryRoute, Recipient } from '../adapters/dingtalk/port.js';
import type { Runtime } from '../application/runtime.js';
export function textLength(text:string,unit:DeliveryRoute['verifiedLimits']['lengthUnit']):number {
  return unit==='utf8_bytes'?Buffer.byteLength(text,'utf8'):unit==='codepoints'?Array.from(text).length:text.length;
}
export function routeBudget(ctx:Runtime,recipient:Recipient,route:DeliveryRoute):{available:boolean;nextAt?:number} {
  const limits=route.verifiedLimits,now=ctx.clock.now();
  const total=ctx.db.prepare('SELECT count(*) AS n FROM delivery_attempts WHERE routeId=?').get(route.id) as {n:number};
  if (limits.routeTotal!==null && total.n>=limits.routeTotal) return {available:false};
  let nextAt=now;
  for(const rate of limits.rates) {
    let clause='r.id=?',value=route.id;
    if(rate.scope==='recipient'){clause='r.recipientId=?';value=recipient.id;}
    if(rate.scope==='robot'){clause='p.robotId=? AND p.platformScope=?';value=recipient.robotId;}
    if(rate.scope==='application'){clause='p.platformScope=?';value=recipient.platformScope;}
    const args:unknown[]=[value];if(rate.scope==='robot')args.push(recipient.platformScope);args.push(now-rate.windowMs);
    const rows=ctx.db.prepare(`SELECT a.startedAt FROM delivery_attempts a JOIN delivery_routes r ON r.id=a.routeId
      JOIN recipients p ON p.id=r.recipientId WHERE ${clause} AND a.startedAt>? ORDER BY a.startedAt`).all(...args) as {startedAt:number}[];
    if(rows.length>=rate.count) nextAt=Math.max(nextAt,rows[rows.length-rate.count]!.startedAt+rate.windowMs);
  }
  return nextAt>now?{available:false,nextAt}:{available:true};
}
