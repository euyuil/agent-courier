import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { z } from 'zod';
import type { Config } from '../config/schema.js';
import { CourierError } from '../domain/errors.js';
import { systemClock } from '../domain/common.js';
import { openDatabase } from '../storage/database.js';
import { migrate } from '../storage/migrate.js';
import { acquireInstanceLock } from '../storage/instance-lock.js';
import { Courier } from '../application/courier.js';
import { FakeHarness } from '../adapters/testing/fake-harness.js';
import { FakePlatform } from '../adapters/testing/fake-platform.js';
import { loadConfig } from '../config/load.js';
import type { Connection } from '../storage/database.js';
import type { Interface } from 'node:readline';
import { serveReal } from './serve-real.js';
import { reportConfigReloadFailure } from './configuration-error.js';

const fakeInput=z.strictObject({text:z.string(),conversation:z.string().optional(),originalMessageId:z.string().optional()});
export async function serve(config: Config,configPath?:string): Promise<void> {
  if(config.platform.kind!=='fake') {
    if(!configPath)throw new CourierError('configuration_invalid');
    return serveReal(config,configPath);
  }
  if(config.harness.adapter!=='mock')throw new CourierError('configuration_invalid');
  const release=acquireInstanceLock(config.storage.databasePath);
  let courier:Courier|undefined;
  let db:Connection|undefined,lines:Interface|undefined,timer:NodeJS.Timeout|undefined;
  const stop=()=>lines?.close();
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try {
    db=openDatabase(config.storage.databasePath);
    lines=createInterface({input:stdin,crlfDelay:Infinity});
    migrate(db);
    const harness=new FakeHarness(),platform=new FakePlatform();
    courier=new Courier({config,db,harness,platform,clock:systemClock,...(configPath?{readConfig:()=>loadConfig(configPath),onConfigReloadFailure:reportConfigReloadFailure}:{})});
    timer=setInterval(()=>{void courier!.flush().catch(()=>{stdout.write(JSON.stringify({code:'storage_unavailable'})+'\n');});},1000);timer.unref();
    stdout.write(JSON.stringify({mode:'fake',status:'ready'})+'\n');
    for await (const line of lines) {
      const parsed=fakeInput.safeParse((()=>{try{return JSON.parse(line) as unknown;}catch{return null;}})());
      if (!parsed.success) {stdout.write(JSON.stringify({code:'input_unsupported'})+'\n');continue;}
      const {text,conversation,originalMessageId}=parsed.data;
      const result=await courier.accept(platform.inbound(text,conversation,originalMessageId));
      if (result.status==='accepted') {
        for (const [ref,state] of harness.sessions) if (state.activeRun) {
          harness.message(ref,state.activeRun,'progress','合成测试进度一');
          harness.message(ref,state.activeRun,'progress','合成测试进度二');
          harness.message(ref,state.activeRun,'final','合成测试回答');harness.complete(ref);
        }
      }
      await courier.flush();stdout.write(JSON.stringify({input:result,delivered:platform.visible.length})+'\n');
    }
  } finally {
    process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
    if(timer)clearInterval(timer);lines?.close();await courier?.close();db?.close();release();
  }
}
