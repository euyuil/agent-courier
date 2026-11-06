import type { DeliveryRoute,Recipient,SendResult } from './port.js';
import { textLength } from '../../delivery/limits.js';
import { z } from 'zod';
import { decodeWebhookResult } from './results.js';

export interface WebhookCapability { url:string;recipient:Pick<Recipient,'platformScope'|'robotId'|'platformConversationId'> }
const capabilitySchema=z.strictObject({url:z.string(),recipient:z.object({platformScope:z.string().min(1),robotId:z.string().min(1),platformConversationId:z.string().min(1)})});
export function webhookUrl(value:string):URL|undefined {
  try {
    const url=new URL(value);
    if(url.protocol==='https:' && url.hostname==='oapi.dingtalk.com' && url.port==='' && !url.username && !url.password
      && url.pathname==='/robot/sendBySession' && !url.hash)return url;
  }catch{ /* Invalid private capability. */ }
  return undefined;
}
export async function sendWebhook(payload:string,recipient:Recipient,route:DeliveryRoute,capability:WebhookCapability,
  request:typeof fetch=fetch,now=Date.now(),timeoutMs=10000):Promise<SendResult> {
  if(!capabilitySchema.safeParse(capability).success)return {status:'route_unavailable',code:'auth'};
  if(route.kind!=='sessionWebhook' || route.status!=='ready' || route.recipientId!==recipient.id
    || Object.entries(capability.recipient).some(([key,value])=>recipient[key as keyof Recipient]!==value))
    return {status:'route_unavailable',code:'recipient'};
  if(route.expiresAt===undefined || route.expiresAt<=now)return {status:'route_unavailable',code:'expired'};
  if(textLength(payload,route.verifiedLimits.lengthUnit)>route.verifiedLimits.maxTextLength)
    return {status:'not_sent',code:'text_too_long',retryable:false};
  const url=webhookUrl(capability.url);
  if(!url)return {status:'route_unavailable',code:'auth'};
  try {
    const response=await request(url,{method:'POST',headers:{'content-type':'application/json'},redirect:'error',
      signal:AbortSignal.timeout(timeoutMs),body:JSON.stringify({msgtype:'text',text:{content:payload}})});
    // An HTTP error alone does not prove the chat side effect did not happen.
    if(!response.ok)return {status:'unknown',safeReason:'delivery_failed'};
    const body:unknown=await response.json();
    return decodeWebhookResult(response.status,body,Date.now());
  }catch{return {status:'unknown',safeReason:'delivery_failed'};}
}
