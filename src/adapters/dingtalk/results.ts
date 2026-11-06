import type { SendResult } from './port.js';
// 只解码已知的业务成功；未核实错误码不证明消息未发送，也不授予重试。
export function decodeWebhookResult(httpStatus:number,body:unknown,now:number):SendResult {
  if(httpStatus<200 || httpStatus>=300)return {status:'unknown',safeReason:'state_unknown'};
  if(!body || typeof body!=='object' || !Object.hasOwn(body,'errcode') || !('errcode' in body) || typeof body.errcode!=='number')return {status:'unknown',safeReason:'state_unknown'};
  if(body.errcode===0)return {status:'confirmed',acceptedAt:now,evidence:'dingtalk:webhook:errcode=0'};
  return {status:'unknown',safeReason:'state_unknown'};
}
