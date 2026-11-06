// 独立真实观察入口，默认 npm test 明确排除。
import { openSync,closeSync,writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { loadConfig } from '../../src/config/load.js';
import { readPrivateJson,assertOutsideRepository } from '../../src/config/private.js';
import { privateDirectory } from '../../src/storage/private-state.js';
import { acquireInstanceLock } from '../../src/storage/instance-lock.js';
import { openDatabase } from '../../src/storage/database.js';
import { migrate } from '../../src/storage/migrate.js';
import { composeReal } from '../../src/application/real.js';
import { CourierError,safeCode,type ErrorCode } from '../../src/domain/errors.js';
import { closeInOrder } from '../../src/application/shutdown.js';
import { reportConfigReloadFailure } from '../../src/cli/configuration-error.js';

const scopeSchema=z.strictObject({allowedSenderIds:z.array(z.string().min(1)).min(1),windowSeconds:z.number().int().min(15).max(300).default(60)});
export async function liveConversation(args:string[]):Promise<number> {
  if(args.length!==7||args[0]!=='--enable-live'||args[1]!=='--config'||args[3]!=='--scope'||args[5]!=='--output')return 2;
  let db:ReturnType<typeof openDatabase>|undefined,runtime:Awaited<ReturnType<typeof composeReal>>|undefined;
  let release:(()=>void)|undefined,timer:NodeJS.Timeout|undefined,reserved=false;
  const output=resolve(args[6]!),marker=`Agent Courier live ${randomUUID()}`;
  const report:Record<string,unknown>={kind:'real_integration_observation',acceptanceOutcome:'not_completed'};
  let stop!:()=>void,stopping=false,exitCode=3,stopError:ErrorCode|undefined;
  const stopped=new Promise<void>(resolve=>{stop=()=>{stopping=true;resolve();};});
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try {
    const configPath=resolve(args[2]!),config=loadConfig(configPath),scope=scopeSchema.parse(readPrivateJson(configPath,args[4]!));
    if(config.platform.kind!=='dingtalk-stream')throw new CourierError('configuration_invalid');assertOutsideRepository(output);
    privateDirectory(dirname(output));const file=openSync(output,'wx',0o600);closeSync(file);reserved=true;
    release=acquireInstanceLock(config.storage.databasePath);db=openDatabase(config.storage.databasePath);migrate(db);
    const existing=db.prepare('SELECT senderId FROM platform_identities').all() as {senderId:string}[];
    if(existing.some(row=>!scope.allowedSenderIds.includes(row.senderId)))throw new CourierError('configuration_invalid');
    runtime=await composeReal(config,configPath,db,reportConfigReloadFailure);
    if(stopping)throw new CourierError('state_unknown');
    let observedInputs=0;
    await runtime.platform.connect(async event=>{
      if(stopping)return;
      if(!scope.allowedSenderIds.includes(event.senderId)||(!event.text?.startsWith(marker)&&!/^\/(答复|批准|拒绝|补充)\s/.test(event.text??''))) {
        await runtime!.platform.ack(event.transportMessageId);return;
      }
      await runtime!.courier.accept(event);observedInputs++;
    },()=>{stopError='state_unknown';stop();});
    if(stopping)throw new CourierError('state_unknown');
    report['status']='listening';writeFileSync(output,JSON.stringify(report,null,2),{mode:0o600});
    process.stdout.write(JSON.stringify({status:'listening',marker,windowSeconds:scope.windowSeconds})+'\n');
    let flushing=false;
    timer=setInterval(()=>{
      if(flushing)return;flushing=true;
      void runtime!.courier.flush().catch(error=>{stopError=safeCode(error);stop();}).finally(()=>{flushing=false;});
    },500);
    const deadline=setTimeout(stop,scope.windowSeconds*1000);
    try{await stopped;}finally{clearTimeout(deadline);}
    if(stopError)throw new CourierError(stopError);
    clearInterval(timer);timer=undefined;
    report['observedInputs']=observedInputs;
    report['manualScenarioReviewRequired']=true;
    exitCode=5;
  }catch(error){report['status']='blocked';report['code']=safeCode(error);}
  finally{
    process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);if(timer)clearInterval(timer);
    try {
      await closeInOrder([()=>runtime?.platform.close(),()=>runtime?.courier.close(),()=>{
        if(exitCode!==5)return;
        // 仅在在途工作结束后读取计数；这些计数不证明 37 项验收已通过。
        const count=(table:string)=>(db!.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n;
        report['identities']=count('platform_identities');report['courierSessions']=count('courier_sessions');
        report['harnessBindings']=count('harness_bindings');report['runs']=count('runs');
        report['deliveries']=db!.prepare('SELECT status,count(*) n FROM outbound_deliveries GROUP BY status').all();
      },()=>db?.close(),()=>release?.()]);
      if(exitCode===5)report['status']='observed';
    }catch(error){report['status']='blocked';report['code']=safeCode(error);report['cleanupFailed']=true;exitCode=3;}
  }
  if(reserved)try{writeFileSync(output,JSON.stringify(report,null,2),{mode:0o600});}
  catch{report['status']='blocked';report['code']='storage_unavailable';exitCode=3;}
  (exitCode===3?process.stderr:process.stdout).write(JSON.stringify(report)+'\n');return exitCode;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try{process.exitCode=await liveConversation(process.argv.slice(2));}
  catch{process.stderr.write(JSON.stringify({status:'blocked',code:'state_unknown',acceptanceOutcome:'not_completed'})+'\n');process.exitCode=3;}
}
