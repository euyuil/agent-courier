import { randomUUID } from 'node:crypto';
import type { MappingStore } from '../../storage/adapter-mappings.js';
import { CourierError } from '../../domain/errors.js';
import type { AcpConnection } from './connection.js';
import { record } from './metadata.js';

export function reportsDefaultMode(value:unknown):boolean {
  const options=record(value)['configOptions'];
  if(!Array.isArray(options))return false;
  const modes=options.map(record).filter(option=>option['id']==='mode');
  return modes.length===1&&modes[0]!['currentValue']==='default';
}
export async function prepareContextMode(connection:Pick<AcpConnection,'call'>,store:MappingStore,sessionRef:string,loaded:unknown):Promise<void> {
  const key=`context-mode:${sessionRef}`;
  // 原生 load 回读已能证明当前状态时，无须重发先前结果未知的配置操作。
  if(reportsDefaultMode(loaded)){store.set(key,{status:'verified',sessionRef,mode:'default'});return;}
  const raw=store.get(key),prior=record(raw);
  if(raw!==undefined&&(!['verified','not_applied'].includes(String(prior['status']))||prior['mode']!=='default'||
    prior['sessionRef']!==undefined&&prior['sessionRef']!==sessionRef))throw new CourierError('state_unknown');
  const operationId=randomUUID(),intent={operationId,sessionRef,mode:'default',status:'dispatching'};
  const save=(state:Record<string,unknown>)=>{store.set(`context-mode-operation:${operationId}`,state);store.set(key,state);};
  save(intent);
  let result:unknown;
  try{result=await connection.call('session/set_config_option',{sessionId:sessionRef,configId:'mode',value:'default'},operationId);}
  catch{save({...intent,status:'unknown'});throw new CourierError('state_unknown');}
  if(!reportsDefaultMode(result)){save({...intent,status:'not_applied'});throw new CourierError('capability_unverified');}
  save({...intent,status:'verified'});
}
