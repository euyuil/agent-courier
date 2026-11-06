import { randomUUID } from 'node:crypto';
import { CourierError } from '../../domain/errors.js';

export interface RpcMessage { jsonrpc:'2.0';id?:string|number;method?:string;params?:unknown;result?:unknown;error?:unknown }
export class RpcFailure extends Error {constructor(readonly detail:unknown){super('harness_rpc_rejected');}}
export interface AcpOptions { endpoint:string;headers?:Record<string,string>;timeoutMs?:number;request?:typeof fetch }
export class AcpConnection {
  private connectionId:string|undefined;
  private readonly controller=new AbortController();
  private readonly pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:unknown)=>void;timer:NodeJS.Timeout}>();
  private readonly streams=new Set<Promise<void>>();
  private disconnected=false;
  onMessage:(message:RpcMessage)=>void=()=>{};
  onLost:()=>void=()=>{};
  constructor(private readonly options:AcpOptions) {
    const url=new URL(options.endpoint);
    if(url.protocol!=='http:' || !['127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password || url.hash || url.search)
      throw new CourierError('configuration_invalid');
  }
  get connected():boolean{return this.connectionId!==undefined&&!this.disconnected;}
  private headers():Record<string,string> {
    return {...this.options.headers,'X-CodeBuddy-Request':'1',...(this.connectionId?{'Acp-Connection-Id':this.connectionId}:{})};
  }
  async connect():Promise<void> {
    if(this.connectionId || this.disconnected)throw new CourierError('state_unknown');
    const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(),this.options.timeoutMs??10000);
    try {
      const response=await (this.options.request??fetch)(this.options.endpoint,{headers:{...this.headers(),Accept:'text/event-stream'},
        redirect:'error',signal:AbortSignal.any([timeout.signal,this.controller.signal])});
      this.connectionId=response.headers.get('Acp-Connection-Id')??undefined;
      if(!response.ok || !this.connectionId || !response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
        throw new CourierError('unconfigured');
      clearTimeout(timer);
      this.track(this.readSse(response.body).then(()=>{if(!this.disconnected)this.lost();}).catch(()=>this.lost()));
    }catch{this.connectionId=undefined;throw new CourierError('unconfigured');}
    finally{clearTimeout(timer);}
  }
  call(method:string,params:unknown,id:string=randomUUID(),timeoutMs=this.options.timeoutMs??10000):Promise<unknown> {
    if(!this.connected)return Promise.reject(new CourierError('state_unknown'));
    if(this.pending.has(id))return Promise.reject(new CourierError('protocol_conflict'));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new CourierError('state_unknown'));},timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      void this.post({jsonrpc:'2.0',id,method,params}).catch(()=>{
        const pending=this.pending.get(id);if(pending){clearTimeout(pending.timer);this.pending.delete(id);pending.reject(new CourierError('state_unknown'));}
      });
    });
  }
  async respond(id:string|number,result:unknown):Promise<void> {await this.post({jsonrpc:'2.0',id,result});}
  private async post(message:RpcMessage):Promise<void> {
    if(!this.connected)throw new CourierError('state_unknown');
    const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(),this.options.timeoutMs??10000);
    try {
      const response=await (this.options.request??fetch)(this.options.endpoint,{method:'POST',redirect:'error',
        headers:{...this.headers(),'content-type':'application/json',Accept:'application/json, text/event-stream'},
        signal:AbortSignal.any([this.controller.signal,timeout.signal]),body:JSON.stringify(message)});
      if(!response.ok){await response.body?.cancel();throw new CourierError('state_unknown');}
      if(response.headers.get('content-type')?.includes('text/event-stream') && response.body) {
        clearTimeout(timer);this.track(this.readSse(response.body).catch(()=>this.lost()));
      }else if(response.status!==202 && response.status!==204 && response.body) {
        const reader=response.body.getReader(),decoder=new TextDecoder();let text='';
        try {while(true){const next=await reader.read();if(next.done)break;text+=decoder.decode(next.value,{stream:true});
          if(text.length>1048576)throw new CourierError('protocol_conflict');}text+=decoder.decode();}
        finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
        if(text)this.deliver(JSON.parse(text) as unknown);
      }else await response.body?.cancel();
    }finally{clearTimeout(timer);}
  }
  private track(task:Promise<void>):void {this.streams.add(task);void task.finally(()=>this.streams.delete(task));}
  private async readSse(body:ReadableStream<Uint8Array>):Promise<void> {
    const reader=body.getReader(),decoder=new TextDecoder();let buffer='',data:string[]=[];
    try {
      while(true) {
        const next=await reader.read();if(next.done)break;
        buffer+=decoder.decode(next.value,{stream:true});
        if(buffer.length+data.join('').length>1048576)throw new CourierError('protocol_conflict');
        let newline:number;
        while((newline=buffer.indexOf('\n'))>=0) {
          const line=buffer.slice(0,newline).replace(/\r$/,'');buffer=buffer.slice(newline+1);
          if(line===''){if(data.length)this.deliver(JSON.parse(data.join('\n')) as unknown);data=[];}
          else if(line.startsWith('data:'))data.push(line.slice(5).replace(/^ /,''));
        }
      }
      // An unterminated SSE frame is not a complete protocol message.
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  private deliver(raw:unknown):void {
    if(!raw || typeof raw!=='object' || !('jsonrpc' in raw) || raw.jsonrpc!=='2.0')throw new CourierError('protocol_conflict');
    const message=raw as RpcMessage;
    if(Object.hasOwn(message,'method')) {
      if(typeof message.method!=='string'||!message.method||Object.hasOwn(message,'result')||Object.hasOwn(message,'error')
        ||(message.id!==undefined&&typeof message.id!=='string'&&(typeof message.id!=='number'||!Number.isFinite(message.id))))throw new CourierError('protocol_conflict');
      this.onMessage(message);return;
    }
    // 本端命令 ID 为字符串；JSON-RPC 的数字 ID 与同形字符串不是同一个请求。
    if(typeof message.id!=='string')return;
    const pending=this.pending.get(message.id);if(!pending)return;
    if(Object.hasOwn(message,'result')===Object.hasOwn(message,'error'))throw new CourierError('protocol_conflict');
    clearTimeout(pending.timer);this.pending.delete(message.id);
    if(message.error!==undefined)pending.reject(new RpcFailure(message.error));else pending.resolve(message.result);
  }
  private lost():void {
    if(this.disconnected)return;this.disconnected=true;this.controller.abort();
    for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new CourierError('state_unknown'));}
    this.pending.clear();
    // 持久层/订阅者已失败时仍须完成断连；原异常不离开适配器，也不改写未知操作。
    try{this.onLost();}catch{/* 应用恢复将根据已持久化的派发意图保留 unknown。 */}
  }
  async close():Promise<void> {
    const headers=this.headers(),wasConnected=this.connected;
    this.lost();this.connectionId=undefined;
    if(wasConnected)try{await (this.options.request??fetch)(this.options.endpoint,{method:'DELETE',headers,redirect:'error',signal:AbortSignal.timeout(3000)});}catch{/* Closing this connection never cancels a Run. */}
    await Promise.allSettled(this.streams);
  }
}
