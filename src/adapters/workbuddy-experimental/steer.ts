import type { SteerInput,Receipt,CommandHandle } from '../harness/port.js';
import type { MappingStore } from '../../storage/adapter-mappings.js';
import { AcpConnection } from './connection.js';
import { rejectedReceipt } from './errors.js';
import { record,string,metaField } from './metadata.js';
import type { SteerTransition } from './run-references.js';

const sameInput=(a:SteerInput,b:SteerInput)=>a.operationId===b.operationId&&a.inputId===b.inputId&&
  a.sessionRef===b.sessionRef&&a.expectedRunRef===b.expectedRunRef&&a.text===b.text;
const appliedEvidence='workbuddy:steer:injected-user-echo';
interface SteeringOperation {input:SteerInput;ownerRef:string;transition?:SteerTransition;receipt:Promise<Receipt>;status:'dispatching'|'accepted'|'rejected'|'unknown'|'applied'}

export class WorkBuddySteering {
  private readonly operations=new Map<string,SteeringOperation>();
  private readonly inputs=new Map<string,string>();
  constructor(private readonly connection:AcpConnection,private readonly store:MappingStore,
    private readonly applied:(input:SteerInput,evidence:string,transition:SteerTransition)=>void,private readonly conflict:(input:SteerInput)=>void){}
  dispatch(received:SteerInput,ownerRef=received.expectedRunRef):CommandHandle {
    const input={...received};
    const prior=this.operations.get(input.operationId);
    const unknown=(errorCode:'protocol_conflict'|'state_unknown'):CommandHandle=>({operationId:input.operationId,receipt:Promise.resolve({status:'unknown',errorCode})});
    if(prior)return sameInput(prior.input,input)?{operationId:input.operationId,receipt:prior.receipt}:unknown('protocol_conflict');
    if(this.inputs.has(input.inputId))return unknown('protocol_conflict');
    // 跨进程遗留意图没有可靠查询或重放协议，不能根据相同关联 ID 再派发一次。
    if(this.store.get(`steer:${input.operationId}`)!==undefined||this.store.get(`steer-input:${input.inputId}`)!==undefined)return unknown('state_unknown');
    const operation:SteeringOperation={input:{...input},ownerRef,status:'dispatching',receipt:Promise.resolve({status:'unknown',errorCode:'state_unknown'})};
    this.operations.set(input.operationId,operation);this.inputs.set(input.inputId,input.operationId);
    operation.receipt=Promise.resolve().then(async()=>{
      this.store.set(`steer:${input.operationId}`,{input:operation.input,ownerRef,status:'dispatching'});
      this.store.set(`steer-input:${input.inputId}`,{operationId:input.operationId});
      const result=await steer(this.connection,operation.input,ownerRef);
      if(operation.status==='applied') {
        if(result.status==='rejected'||(result.status==='unknown'&&result.errorCode==='protocol_conflict')) {
          this.conflict(operation.input);return {status:'unknown',errorCode:'protocol_conflict'} as Receipt;
        }
        return {status:'accepted',sessionRef:input.sessionRef,runRef:input.expectedRunRef,receiptEvidence:appliedEvidence} as Receipt;
      }
      operation.status=result.status;
      this.store.set(`steer:${input.operationId}`,{input:operation.input,ownerRef,status:operation.status,receipt:result});
      return result;
    }).catch(rejectedReceipt);
    return {operationId:input.operationId,receipt:operation.receipt};
  }
  consume(sessionRef:string,runRef:string,params:Record<string,unknown>):void {
    const update=record(params['update']);if(update['sessionUpdate']!=='user_message_chunk')return;
    const envelope=record(metaField(update['_meta'],'steerClientMeta')??metaField(params['_meta'],'steerClientMeta'));
    if(record(envelope['codebuddy.ai'])['queueOrigin']!=='steer')return;
    const marker=record(envelope['agent-courier']),operationId=string(marker['operationId']);
    const operation=operationId?this.operations.get(operationId):undefined;if(!operation)return;
    const input=operation.input;
    const messageId=string(update['messageId'])??string(metaField(update['_meta'],'messageId'));
    const metadataId=string(metaField(update['_meta'],'messageId'));
    if(sessionRef!==input.sessionRef||runRef!==operation.ownerRef||marker['runRef']!==input.expectedRunRef||marker['inputId']!==input.inputId||
      messageId!==input.inputId||(metadataId!==undefined&&metadataId!==messageId))return;
    const native=string(metaField(update['_meta'],'requestId'))??operation.ownerRef;
    const conversation=string(metaField(update['_meta'],'conversationRequestId'));
    if(conversation!==undefined&&conversation!==operation.ownerRef)return;
    if(native!==operation.ownerRef&&(conversation!==operation.ownerRef||metaField(update['_meta'],'messageRequestId')!==input.inputId))return;
    if(typeof update['requestId']==='string'&&update['requestId']!==native)return;
    const transition={ownerRef:operation.ownerRef,nextRef:native};
    if(operation.status==='applied') {
      if(operation.transition?.nextRef!==native)this.conflict(input);return;
    }
    if(operation.status==='rejected'){this.conflict(input);return;}
    // 指定版本在注入模型输入后广播此回执；它与仅表示入缓冲区的 steered:true 分开。
    this.store.set(`steer:${input.operationId}`,{input,ownerRef:operation.ownerRef,transition,status:'applied',appliedEvidence});
    operation.status='applied';operation.transition=transition;this.applied(input,appliedEvidence,transition);
  }
}
export async function steer(connection:AcpConnection,input:SteerInput,ownerRef=input.expectedRunRef):Promise<Receipt> {
  try {
    const result=await connection.call('session/steer',{sessionId:input.sessionRef,
      expectedRequestId:ownerRef,clientUserMessageId:input.inputId,
      contentBlocks:[{type:'text',text:input.text}],_meta:{'codebuddy.ai':{queueOrigin:'steer'},
        'agent-courier':{operationId:input.operationId,inputId:input.inputId,runRef:input.expectedRunRef}}},input.operationId) as {steered?:unknown;ownerRequestId?:unknown;reason?:unknown};
    if(result?.steered===true && result.ownerRequestId===ownerRef)
      return {status:'accepted',sessionRef:input.sessionRef,runRef:input.expectedRunRef,receiptEvidence:'workbuddy:steer:steered'};
    if(result?.steered===true)return {status:'unknown',errorCode:'protocol_conflict'};
    if(result?.steered===false && (result.reason==='idle'||result.reason==='stale'))
      return {status:'rejected',errorCode:'stale_run',definitelyNotAccepted:true};
    if(result?.steered===false)return {status:'rejected',errorCode:'steer_rejected',definitelyNotAccepted:true};
    return {status:'unknown',errorCode:'state_unknown'};
  }catch(error){return rejectedReceipt(error);}
}
