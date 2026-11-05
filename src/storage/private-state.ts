import { closeSync,existsSync,lstatSync,mkdirSync,openSync,chmodSync,rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Connection } from './database.js';
import { checkLocalPath } from './database.js';
import { CourierError } from '../domain/errors.js';
import type { sessionStatus } from '../cli/status.js';

export function privateDirectory(path:string):void {
  checkLocalPath(path);mkdirSync(path,{recursive:true,mode:0o700});
  const info=lstatSync(path);
  if(!info.isDirectory() || (info.mode&0o077)!==0 || (process.getuid&&info.uid!==process.getuid()))throw new CourierError('storage_unavailable');
}
export async function backupDatabase(db:Connection,destination:string):Promise<void> {
  let reserved=false;
  try {
    checkLocalPath(destination);privateDirectory(dirname(destination));
    const fd=openSync(destination,'wx',0o600);closeSync(fd);reserved=true;
    await db.backup(destination);chmodSync(destination,0o600);
  } catch {
    if(reserved && existsSync(destination))rmSync(destination);
    throw new CourierError('storage_unavailable');
  }
}
export function sharedStatus(status:ReturnType<typeof sessionStatus>) {
  const aliases=new Map<string,string>();
  const alias=(id:string)=>{if(!aliases.has(id))aliases.set(id,`local-${aliases.size+1}`);return aliases.get(id)!;};
  return {...status,session:alias(status.session),input:status.input?{...status.input,id:alias(status.input.id)}:null,
    execution:status.execution?{...status.execution,id:alias(status.execution.id)}:null,
    unresolvedOperations:status.unresolvedOperations.map(item=>({...item,id:alias(item.id)})),
    unresolvedDeliveries:status.unresolvedDeliveries.map(item=>({...item,id:alias(item.id)}))};
}
