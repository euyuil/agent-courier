import { Worker } from 'node:worker_threads';
import { CourierError } from '../../domain/errors.js';

export type StreamWorker=Pick<Worker,'stdout'|'stderr'|'on'|'removeAllListeners'|'postMessage'|'terminate'>;
export class DingTalkStream {
  private worker:StreamWorker|undefined;
  private closing=false;
  private closeTask:Promise<void>|undefined;
  private readonly acknowledgements=new Map<string,{resolve:()=>void;reject:()=>void;timer:NodeJS.Timeout}>();
  constructor(private readonly createWorker:(credentials:{clientId:string;clientSecret:string})=>StreamWorker=
    credentials=>new Worker(new URL('./stream-worker.js',import.meta.url),{workerData:credentials,stdout:true,stderr:true})){}
  async connect(credentials:{clientId:string;clientSecret:string},onCallback:(id:string,data:string)=>Promise<void>,onLost:()=>void):Promise<void> {
    if(this.worker||this.closing)throw new CourierError('state_unknown');
    try {
      const worker=this.createWorker(credentials);
      this.worker=worker;worker.stdout.resume();worker.stderr.resume();
      await new Promise<void>((resolve,reject)=>{
        let ready=false,lostReported=false;
        const timer=setTimeout(()=>reject(new CourierError('auth_required')),10000);
        const lost=()=>{
          if(lostReported||this.closing)return;lostReported=true;
          clearTimeout(timer);
          for(const ack of this.acknowledgements.values()){clearTimeout(ack.timer);ack.reject();}
          this.acknowledgements.clear();
          if(ready)onLost();else reject(new CourierError('auth_required'));
        };
        worker.on('error',lost);worker.on('exit',lost);
        worker.on('message',(message:{type:string;transportMessageId?:string;data?:string})=>{
          if(message.type==='ready'){ready=true;clearTimeout(timer);resolve();}
          else if(message.type==='callback' && message.transportMessageId && typeof message.data==='string') {
            // ACK is sent only by the callback after the durable application transaction.
            void onCallback(message.transportMessageId,message.data).catch(()=>{});
          }else if((message.type==='acked'||message.type==='ack_failed') && message.transportMessageId) {
            const pending=this.acknowledgements.get(message.transportMessageId);
            if(pending){clearTimeout(pending.timer);this.acknowledgements.delete(message.transportMessageId);
              if(message.type==='acked')pending.resolve();else pending.reject();}
          }else if(message.type==='failed'||message.type==='lost')lost();
        });
      });
    }catch{await this.close();throw new CourierError('auth_required');}
  }
  async ack(id:string):Promise<void> {
    if(!this.worker)throw new CourierError('state_unknown');
    // Redelivery can overlap before its first ACK has finished.
    if(this.acknowledgements.has(id))throw new CourierError('state_unknown');
    return new Promise((resolve,reject)=>{
      const fail=()=>reject(new CourierError('state_unknown'));
      const timer=setTimeout(()=>{this.acknowledgements.delete(id);fail();},3000);
      this.acknowledgements.set(id,{resolve,reject:fail,timer});
      try{this.worker!.postMessage({type:'ack',transportMessageId:id});}
      catch{clearTimeout(timer);this.acknowledgements.delete(id);fail();}
    });
  }
  close():Promise<void> {
    if(this.closeTask)return this.closeTask;
    this.closing=true;
    const worker=this.worker;this.worker=undefined;
    this.closeTask=(async()=>{
      try {
        if(worker){
          worker.removeAllListeners('message');
          try{worker.postMessage({type:'stop'});}catch{/* 停止提示为尽力发送；本机终止仍须执行。 */}
          await worker.terminate();
        }
      }catch{throw new CourierError('state_unknown');}
      finally {
        for(const ack of this.acknowledgements.values()){clearTimeout(ack.timer);ack.reject();}
        this.acknowledgements.clear();
      }
    })();
    return this.closeTask;
  }
}
