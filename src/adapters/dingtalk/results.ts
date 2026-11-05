import type { SendResult } from './port.js';
// This pure decoder does not enable a real transport or infer undocumented retry codes.
export function decodeWebhookResult(httpStatus:number,body:unknown,now:number):SendResult {
  if(httpStatus<200 || httpStatus>=300)return {status:'unknown',safeReason:'state_unknown'};
  if(!body || typeof body!=='object' || !('errcode' in body) || typeof body.errcode!=='number')return {status:'unknown',safeReason:'state_unknown'};
  if(body.errcode===0)return {status:'confirmed',acceptedAt:now,evidence:'webhook-business-success'};
  return {status:'not_sent',code:'delivery_failed',retryable:false};
}
