import type { AnswerSchema,Option } from '../../src/domain/answer.js';
import type { rig } from './rig.js';
export function request(r:ReturnType<typeof rig>,kind:'question'|'permission'='question',options:{id?:string;messageId?:string;messageFirst?:boolean;schema?:AnswerSchema;permissionOptions?:Option[]}={}) {
  const [ref,state]=[...r.harness.sessions][0]!;
  const runRef=state.activeRun!,id=options.id??'synthetic-request',messageId=options.messageId??`message-${id}`;
  const body=()=>r.harness.message(ref,runRef,kind==='question'?'question':'permission_request','synthetic request body',messageId);
  if(options.messageFirst)body();
  r.harness.emit(ref,runRef,'input.requested',{vendorRequestId:id,kind,messageId,adapterMappingRef:`mapping-${id}`,
    ...(kind==='question'?{answerSchema:options.schema??{mode:'text' as const}}:{options:options.permissionOptions??[{code:'O1',label:'仅本次',decision:'approve' as const},{code:'D1',label:'拒绝',decision:'deny' as const}]})});
  if(!options.messageFirst)body();
  return {ref,runRef,id,messageId};
}
