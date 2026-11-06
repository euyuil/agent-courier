import { RpcFailure } from './connection.js';
import type { ErrorCode } from '../../domain/errors.js';
import type { Receipt } from '../harness/port.js';
export function rejectedReceipt(error:unknown):Exclude<Receipt,{status:'accepted'}> {
  if(error instanceof RpcFailure && error.detail && typeof error.detail==='object') {
    const raw=error.detail as {code?:unknown;data?:{code?:unknown;reason?:unknown};message?:unknown};
    const code=raw.data?.reason??raw.data?.code??raw.message;
    const codes=new Map<string,ErrorCode>([['writer_occupied','writer_occupied'],['auth_required','auth_required'],
      ['session_missing','session_missing'],['stale_run','stale_run'],['request_invalid','request_invalid']]);
    const known=typeof code==='string'?codes.get(code):undefined;
    if(known)return {status:'rejected',errorCode:known,definitelyNotAccepted:true};
    if(raw.code===-32601)return {status:'rejected',errorCode:'capability_unverified',definitelyNotAccepted:true};
  }
  return {status:'unknown',errorCode:'state_unknown'};
}
