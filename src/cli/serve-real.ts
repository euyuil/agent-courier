import type { Config } from '../config/schema.js';
import { acquireInstanceLock } from '../storage/instance-lock.js';
import { openDatabase } from '../storage/database.js';
import { migrate } from '../storage/migrate.js';
import { composeReal } from '../application/real.js';
import { CourierError,safeCode,type ErrorCode } from '../domain/errors.js';
import { closeInOrder } from '../application/shutdown.js';
import { reportConfigReloadFailure } from './configuration-error.js';
export async function serveReal(config:Config,configPath:string):Promise<void> {
  const release=acquireInstanceLock(config.storage.databasePath);
  let runtime:Awaited<ReturnType<typeof composeReal>>|undefined;
  let db:ReturnType<typeof openDatabase>|undefined,timer:NodeJS.Timeout|undefined;
  let stop!:()=>void,stopping=false,stopError:ErrorCode|undefined;
  const stopped=new Promise<void>(resolve=>{stop=()=>{stopping=true;resolve();};});
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    db=openDatabase(config.storage.databasePath);migrate(db);runtime=await composeReal(config,configPath,db,reportConfigReloadFailure);
    if(stopping)return;
    await runtime.platform.connect(async event=>{if(!stopping)await runtime!.courier.accept(event);},()=>{
      // Restarting the transport is an operator action; it never replays Agent operations.
      stopError='state_unknown';stop();
    });
    if(stopping)return;
    timer=setInterval(()=>{void runtime!.courier.flush().catch(error=>{stopError=safeCode(error);stop();});},500);
    process.stdout.write(JSON.stringify({mode:'real_experimental',status:'ready'})+'\n');await stopped;
    if(stopError)throw new CourierError(stopError);
  }finally{
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);if(timer)clearInterval(timer);
    await closeInOrder([()=>runtime?.platform.close(),()=>runtime?.courier.close(),()=>db?.close(),release]);
  }
}
