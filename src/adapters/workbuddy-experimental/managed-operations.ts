import { createHash } from 'node:crypto';
import type { MappingStore } from '../../storage/adapter-mappings.js';
import type { CommandHandle,Receipt,OperationInput } from '../harness/port.js';
import { normalizeReceipt } from '../harness/receipt.js';
import { record } from './metadata.js';

type Kind='create'|'load'|'start'|'steer'|'answer';
type Input=OperationInput&{sessionRef?:string;inputId?:string;clientRunId?:string;expectedRunRef?:string;runRef?:string;vendorRequestId?:string};
const unknown=(conflict=false):Receipt=>({status:'unknown',errorCode:conflict?'protocol_conflict':'state_unknown'});
function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  return value!==null&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
}
export class ManagedOperations {
  private readonly active=new Map<string,{signature:string;receipt:Promise<Receipt>}>();
  constructor(private readonly store:MappingStore){}
  inputOperation(sessionRef:string,inputId:string):string|undefined {
    const row=record(this.store.get(`managed-input:${JSON.stringify([sessionRef,inputId])}`));
    return typeof row['operationId']==='string'?row['operationId']:undefined;
  }
  inputId(operationId:string):unknown{return record(this.store.get(`managed-operation:${operationId}`))['inputId'];}
  accepted(operationId:string,receipt:Receipt):boolean {
    const key=`managed-operation:${operationId}`,row=record(this.store.get(key));
    if(row['schemaVersion']!==1||typeof row['signature']!=='string'||row['conflict']===true)return false;
    const value=normalizeReceipt(receipt,record(row['expected']));if(value.status!=='accepted')return false;
    const old=row['receipt'] as Receipt|undefined;
    if(old?.status==='rejected'||old?.status==='accepted'&&
      (old.sessionRef!==value.sessionRef||old.runRef!==value.runRef||old.vendorRequestId!==value.vendorRequestId)){
      this.store.set(key,{...row,conflict:true});return false;
    }
    this.store.set(key,{...row,status:'settled',receipt:value});return true;
  }
  execute<T extends Input>(kind:Kind,input:T,work:()=>Promise<Receipt>):CommandHandle {
    const key=`managed-operation:${input.operationId}`,signature=createHash('sha256').update(JSON.stringify(canonical([kind,input]))).digest('hex');
    const immediate=(receipt:Receipt):CommandHandle=>({operationId:input.operationId,receipt:Promise.resolve(receipt)});
    const pending=this.active.get(input.operationId);if(pending)return pending.signature===signature?{operationId:input.operationId,receipt:pending.receipt}:immediate(unknown(true));
    const expected={...(input.sessionRef?{sessionRef:input.sessionRef}:{}),...(input.expectedRunRef??input.runRef?{runRef:input.expectedRunRef??input.runRef}:{}),
      ...(input.vendorRequestId?{requestId:input.vendorRequestId}:{}),...(kind==='start'?{requiresRun:true}:{})};
    const raw=this.store.get(key),prior=record(raw);
    if(raw!==undefined){
      if(prior['schemaVersion']!==1||prior['signature']!==signature||prior['kind']!==kind||prior['conflict']===true)return immediate(unknown(true));
      return immediate(prior['status']==='settled'?normalizeReceipt(prior['receipt'] as Receipt,expected):unknown());
    }
    const inputKey=input.sessionRef&&input.inputId?`managed-input:${JSON.stringify([input.sessionRef,input.inputId])}`:undefined;
    if(inputKey&&this.store.get(inputKey)!==undefined)return immediate(unknown(true));
    this.store.set(key,{schemaVersion:1,signature,kind,status:'dispatching',expected,
      ...(input.inputId?{inputId:input.inputId}:{}),...(input.clientRunId?{clientRunId:input.clientRunId}:{})});
    if(inputKey)this.store.set(inputKey,{operationId:input.operationId});
    const receipt=Promise.resolve().then(work).catch(()=>unknown()).then(value=>{
      const current=record(this.store.get(key)),normalized=normalizeReceipt(value,expected),old=current['receipt'] as Receipt|undefined;
      if(current['conflict']===true)return unknown(true);
      if(old?.status==='accepted'){
        if(normalized.status==='unknown')return old;
        if(normalized.status!=='accepted'||old.sessionRef!==normalized.sessionRef||old.runRef!==normalized.runRef||old.vendorRequestId!==normalized.vendorRequestId){
          this.store.set(key,{...current,conflict:true});return unknown(true);
        }
      }
      this.store.set(key,{...current,status:'settled',receipt:normalized});return normalized;
    }).finally(()=>{this.active.delete(input.operationId);});
    this.active.set(input.operationId,{signature,receipt});return {operationId:input.operationId,receipt};
  }
}
