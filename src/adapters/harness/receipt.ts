import { errorCodes } from '../../domain/errors.js';
import type { Receipt } from './port.js';
export function normalizeReceipt(value:Receipt,expected:{sessionRef?:string;runRef?:string;requestId?:string;requiresRun?:boolean}={}):Receipt {
  const unknown:Receipt={status:'unknown',errorCode:'protocol_conflict'};
  if(!value || typeof value!=='object')return unknown;
  if(value.status==='accepted') {
    if(typeof value.sessionRef!=='string'||!value.sessionRef || typeof value.receiptEvidence!=='string'||!value.receiptEvidence
      || (value.runRef!==undefined&&(typeof value.runRef!=='string'||!value.runRef))
      || (value.vendorRequestId!==undefined&&(typeof value.vendorRequestId!=='string'||!value.vendorRequestId))
      || (expected.sessionRef&&value.sessionRef!==expected.sessionRef)
      || (expected.requiresRun&&!value.runRef) || (expected.runRef&&value.runRef!==expected.runRef)
      || (expected.requestId&&value.vendorRequestId!==expected.requestId))return unknown;
    return value;
  }
  if(value.status==='rejected')return value.definitelyNotAccepted===true&&errorCodes.includes(value.errorCode)?value:unknown;
  if(value.status==='unknown')return errorCodes.includes(value.errorCode)?value:{status:'unknown',errorCode:'state_unknown'};
  return unknown;
}
