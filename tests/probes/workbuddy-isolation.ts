import { randomUUID } from 'node:crypto';
import type { HarnessPort } from '../../src/adapters/harness/port.js';

type Adapter=Pick<HarnessPort,'createSession'|'resumeSession'|'disconnect'>;
const recall='Without tools, files or network access, reply only with the exact synthetic context marker you were asked to remember in this Harness session. The marker is not repeated in this input.';
function checked(run:Record<string,unknown>):Record<string,boolean> {
  return {accepted:run['status']==='accepted',completed:run['completion']==='completed',endTurn:run['rawPromptStop']==='end_turn',
    exactContext:run['markerExact']===true,noForeignContext:run['foreignMarkerObserved']===false,
    completeTrace:run['traceComplete']===true,noTools:run['toolCallFrames']===0};
}
export async function ownedIsolationExperiment<T extends Adapter>(current:T,original:{sessionRef:string;marker:string;bootstrap:string},
  reopen:()=>Promise<T>,register:(session:string)=>void,
  run:(adapter:T,session:string,text:string,marker:string,forbiddenMarker:string)=>Promise<Record<string,unknown>>):Promise<Record<string,unknown>> {
  const report:Record<string,unknown>={status:'unverified',executionPermissionApprovals:0},opened:T[]=[];
  if(!original.sessionRef||!original.marker||!original.bootstrap||original.sessionRef===original.bootstrap)return report;
  try {
    const creation=await current.createSession({operationId:randomUUID(),courierSessionId:randomUUID()}).receipt;
    report['peerCreationAccepted']=creation.status==='accepted';
    if(creation.status!=='accepted'||typeof creation.sessionRef!=='string'||!creation.sessionRef||!creation.receiptEvidence||
      creation.sessionRef===original.sessionRef||creation.sessionRef===original.bootstrap)return report;
    const peer=creation.sessionRef,marker=`CourierIsolatedContext-${randomUUID()}`;register(peer);report['distinctHarnessSessions']=true;
    const seed=checked(await run(current,peer,`Remember this exact synthetic context marker for later turns: ${marker}. `+
      'Do not use tools, read or write files, or contact the network. Reply only with that marker.',marker,original.marker));
    report['peerSeed']=seed;if(!Object.values(seed).every(Boolean))return report;
    await current.disconnect('independent-owned-acp');
    const first=await reopen();opened.push(first);if(first===current)return report;
    const loadFirst=await first.resumeSession({operationId:randomUUID(),sessionRef:original.sessionRef}).receipt;
    report['originalLoadAccepted']=loadFirst.status==='accepted'&&loadFirst.sessionRef===original.sessionRef;
    if(report['originalLoadAccepted']!==true)return report;
    const firstRecall=checked(await run(first,original.sessionRef,recall,original.marker,marker));report['originalRecall']=firstRecall;
    if(!Object.values(firstRecall).every(Boolean))return report;
    await first.disconnect('independent-owned-acp');
    const second=await reopen();opened.push(second);if(second===current||second===first)return report;
    const loadSecond=await second.resumeSession({operationId:randomUUID(),sessionRef:peer}).receipt;
    report['peerLoadAccepted']=loadSecond.status==='accepted'&&loadSecond.sessionRef===peer;
    if(report['peerLoadAccepted']!==true)return report;
    const secondRecall=checked(await run(second,peer,recall,marker,original.marker));report['peerRecall']=secondRecall;
    if(Object.values(secondRecall).every(Boolean)){report['status']='observed';report['freshAdapterInstances']=true;}
    return report;
  }catch{return {...report,error:'isolation_observation_unavailable'};}
  finally{await Promise.allSettled(opened.map(adapter=>adapter.disconnect('independent-owned-acp')));}
}
