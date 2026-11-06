import type { AnswerInput,Receipt } from '../harness/port.js';
import { validateAnswer } from '../../domain/answer.js';
import type { AcpConnection } from './connection.js';
import type { InteractionMapping,InterruptionDecision } from './interaction.js';
import { record } from './metadata.js';

export function prepareInteractionAnswer(mapping:InteractionMapping,input:AnswerInput):
  {rpcResult:unknown;decision?:InterruptionDecision;answers?:Record<string,string|string[]>}|undefined {
  let rpcResult:unknown,decision:InterruptionDecision|undefined,answers:Record<string,string|string[]>|undefined;
  if(mapping.kind==='permission'&&input.answer.kind==='permission') {
    const answer=input.answer,option=mapping.options?.find(item=>item.code===answer.optionCode&&item.decision===answer.decision);
    if(!option)return undefined;
    rpcResult={outcome:{outcome:'selected',optionId:option.code}};
    decision=Object.hasOwn(mapping.wireOptions,option.code)?mapping.wireOptions[option.code]:undefined;
  }else if(mapping.kind==='question'&&input.answer.kind==='form'&&mapping.answerSchema) {
    const validated=validateAnswer(mapping.answerSchema,JSON.stringify(input.answer.values));
    if(!validated||validated.kind!=='form')return undefined;
    answers=validated.values;rpcResult={outcome:'submitted',answers};
    // allow 是内置 AskUserQuestion 的答复协议字段，仅在明确提交有效答案时发送。
    // 其他工具权限始终来自上面的显式批准/拒绝，不复用这条分支。
    if(mapping.nativeToolName==='AskUserQuestion')decision='allow';
  }else return undefined;
  return {rpcResult,...(decision?{decision}:{}),...(answers?{answers}:{})};
}
export async function answerInteraction(connection:AcpConnection,mapping:InteractionMapping,input:AnswerInput):Promise<Receipt> {
  const prepared=prepareInteractionAnswer(mapping,input);
  if(!prepared)return {status:'rejected',errorCode:'request_invalid',definitelyNotAccepted:true};
  const {rpcResult,decision,answers}=prepared;
  if(mapping.wireMethod==='rpc') {
    if(mapping.rpcId===undefined)return {status:'unknown',errorCode:'request_invalid'};
    await connection.respond(mapping.rpcId,rpcResult);
    return {status:'unknown',errorCode:'state_unknown'};
  }
  if(!decision)return {status:'rejected',errorCode:'capability_unverified',definitelyNotAccepted:true};
  const result=record(await connection.call('_codebuddy.ai/resolveInterruption',{sessionId:mapping.sessionRef,toolCallId:mapping.toolCallId,
    decision,...(answers?{answers}:{})},input.operationId));
  if(result['resolved']===true&&result['queued']===false)return {status:'accepted',sessionRef:input.sessionRef,runRef:input.runRef,
    vendorRequestId:input.vendorRequestId,receiptEvidence:'workbuddy:resolveInterruption:resolved'};
  if(result['resolved']===false&&result['queued']===false)return {status:'rejected',errorCode:'request_invalid',definitelyNotAccepted:true};
  // queued=true 可表示记录了稍后生效的决定，不能改走另一通道或重复提交。
  return {status:'unknown',errorCode:'state_unknown'};
}
