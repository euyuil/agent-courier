import type { Receipt } from '../../src/adapters/harness/port.js';
import { normalizeReceipt } from '../../src/adapters/harness/receipt.js';
export interface ManagedRecoveryServices {
  ownIdle():Promise<boolean>;
  peerPending():Promise<boolean>;
  shutdown():Promise<boolean>;
  inspectOld():Promise<'alive'|'ended'|'unknown'>;
  pause():Promise<void>;
  restore():Promise<Receipt>;
  replacementMatches():Promise<boolean>;
  recall():Promise<boolean>;
}
export async function recoverManagedBackend(sessionRef:string,services:ManagedRecoveryServices):Promise<Record<string,unknown>>{
  const report:Record<string,unknown>={status:'unverified',executionPermissionApprovals:0};
  try{
    if(!sessionRef||!await services.peerPending())return report;
    report['ownIdleConfirmed']=await services.ownIdle();if(report['ownIdleConfirmed']!==true)return report;
    report['normalIdleShutdown']=await services.shutdown();if(report['normalIdleShutdown']!==true)return report;
    let state=await services.inspectOld();
    for(let i=0;i<30&&state==='alive';i++){await services.pause();state=await services.inspectOld();}
    report['oldProcessDeathProven']=state==='ended';if(state!=='ended'||!await services.peerPending())return report;
    const receipt=normalizeReceipt(await services.restore(),{sessionRef});
    report['originalContextRestored']=receipt.status==='accepted';if(receipt.status!=='accepted')return report;
    report['replacementMatched']=await services.replacementMatches();if(report['replacementMatched']!==true||!await services.peerPending())return report;
    report['originalContextRecalled']=await services.recall();if(report['originalContextRecalled']!==true)return report;
    report['peerPendingAfterRecall']=await services.peerPending();if(report['peerPendingAfterRecall']===true)report['status']='observed';
    return report;
  }catch{report['error']='managed_recovery_observation_unavailable';return report;}
}
