// 仅供离线进程恢复测试；所有 Harness/平台副作用由父进程中的替身执行。
import type { HarnessPort,Receipt } from '../../src/adapters/harness/port.js';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';
import type { NormalizedInbound,PlatformPort } from '../../src/adapters/dingtalk/port.js';
import { configSchema } from '../../src/config/schema.js';
import { Courier } from '../../src/application/courier.js';
import { systemClock } from '../../src/domain/common.js';
import { safeCode } from '../../src/domain/errors.js';
import { openDatabase,type Connection } from '../../src/storage/database.js';
import { migrate } from '../../src/storage/migrate.js';
import { acquireInstanceLock } from '../../src/storage/instance-lock.js';

type Message={id:number;method?:string;input?:unknown;ok?:boolean;result?:unknown;event?:HarnessEvent};
let sequence=0,courier:Courier|undefined,db:Connection|undefined,release:(()=>void)|undefined;
const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
const listeners=new Map<string,Set<(event:HarnessEvent)=>void>>();
function call<T>(method:string,input:unknown):Promise<T> {
  return new Promise((resolve,reject)=>{
    const id=++sequence;pending.set(id,{resolve:value=>resolve(value as T),reject});
    process.send!({id,method,input});
  });
}
const handle=(method:string,input:{operationId:string})=>({operationId:input.operationId,receipt:call<Receipt>(method,input)});
const harness:HarnessPort={
  probe:instanceId=>call('harness.probe',instanceId),
  createSession:input=>handle('harness.create',input),resumeSession:input=>handle('harness.load',input),
  start:input=>handle('harness.start',input),steer:input=>handle('harness.steer',input),answer:input=>handle('harness.answer',input),
  inspect:input=>call('harness.inspect',input),
  subscribe:(ref,listener)=>{
    const set=listeners.get(ref)??new Set();set.add(listener);listeners.set(ref,set);
    if(set.size===1)void call('harness.subscribe',ref);
    return ()=>{set.delete(listener);if(!set.size){listeners.delete(ref);void call('harness.unsubscribe',ref);}};
  },
  disconnect:async()=>{await call('harness.disconnect',null);},
};
const platform:PlatformPort={ack:id=>call('platform.ack',id),
  send:(deliveryId,recipient,payload,route)=>call('platform.send',{deliveryId,recipient,payload,route}),
  inspectDelivery:id=>call('platform.inspect',id)};

process.on('message',(message:Message)=>{
  if(message.event){for(const listener of listeners.get(message.event.sessionRef)??[])listener(message.event);return;}
  if(!message.method){const entry=pending.get(message.id);pending.delete(message.id);
    if(message.ok)entry?.resolve(message.result);else entry?.reject(new Error('synthetic_remote_error'));return;}
  void (async()=>{
    let result:unknown;
    switch(message.method) {
      case 'init':{
        const config=configSchema.parse({schemaVersion:1,storage:{databasePath:message.input},platform:{kind:'fake',scopeRef:'synthetic-scope',robotRef:'synthetic-robot'},
          harness:{instanceId:'synthetic-harness',adapter:'mock'}});
        release=acquireInstanceLock(config.storage.databasePath);db=openDatabase(config.storage.databasePath);migrate(db);
        courier=new Courier({config,db,harness,platform,clock:systemClock});result='ready';break;
      }
      case 'accept':result=await courier!.accept(message.input as NormalizedInbound);break;
      case 'flush':await courier!.flush();break;
      case 'snapshot':result={
        bindings:db!.prepare('SELECT id,harnessSessionId,status FROM harness_bindings ORDER BY rowid').all(),
        operations:db!.prepare('SELECT id,kind,status,resultCode FROM harness_operations ORDER BY rowid').all(),
        runs:db!.prepare('SELECT id,harnessRunRef,status FROM runs ORDER BY rowid').all(),
        pending:db!.prepare('SELECT id,publicCode,sourceMessageId,vendorRequestId,adapterMappingRef,validity,answerStatus FROM pending_inputs ORDER BY rowid').all(),
        deliveries:db!.prepare('SELECT id,status,attemptCount FROM outbound_deliveries ORDER BY rowid').all(),
      };break;
      case 'crashAt':{
        const target=message.input as {phase:string;kind:string};
        courier!.runtime.effectBoundary=(phase,kind)=>{if(phase===target.phase&&kind===target.kind)process.kill(process.pid,'SIGKILL');};break;
      }
      case 'close':await courier!.close();db!.close();release!();break;
      default:throw new Error('synthetic_command_invalid');
    }
    process.send!({id:message.id,ok:true,result},()=>{if(message.method==='close')process.disconnect();});
  })().catch(error=>{process.send!({id:message.id,ok:false,result:safeCode(error)});});
});
