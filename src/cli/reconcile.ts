import type { Config } from '../config/schema.js';
import { CourierError } from '../domain/errors.js';
import { acquireInstanceLock } from '../storage/instance-lock.js';
import { openDatabase } from '../storage/database.js';
export async function reconcileCommand(config:Config,target:{operation?:string;delivery?:string}):Promise<number> {
  if(!!target.operation===!!target.delivery)throw new CourierError('configuration_invalid');
  const release=acquireInstanceLock(config.storage.databasePath);
  try {
    const db=openDatabase(config.storage.databasePath,{readonly:true});
    try {
      const table=target.operation?'harness_operations':'outbound_deliveries';
      const record=db.prepare(`SELECT status FROM ${table} WHERE id=?`).get(target.operation??target.delivery!) as {status:string}|undefined;
      if(!record || record.status!=='unknown')throw new CourierError('configuration_invalid');
      if(config.platform.kind!=='fake')throw new CourierError('capability_unverified');
      // CLI mock instances have no remote query authority across process lifetimes.
      return 5;
    } finally {db.close();}
  } finally {release();}
}
