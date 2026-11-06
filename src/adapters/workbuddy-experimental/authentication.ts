// This opt-in desktop diagnostic path calls the normal account API. It never
// requests tokens, reads browser storage or discovers credentials from a process.
import type { BootstrapRunProvenance } from './bootstrap-provenance.js';
import { isAbsolute,join } from 'node:path';
export interface DesktopStatus {authenticated:boolean;productVersion:string}
async function desktopQuery(debugUrl:string,expression:string,request:typeof fetch,Socket:typeof WebSocket,timeoutMs=5000):Promise<unknown> {
  let socket:WebSocket|undefined,timer:NodeJS.Timeout|undefined;
  try {
    const url=new URL(debugUrl);
    if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash)return undefined;
    const response=await request(new URL('/json/list',url),{redirect:'error',signal:AbortSignal.timeout(3000)});
    if(!response.ok)return undefined;
    const pages:unknown=await response.json();
    if(!Array.isArray(pages))return undefined;
    const page=pages.find((item:unknown)=>item!==null&&typeof item==='object'&&'type' in item&&item.type==='page') as {webSocketDebuggerUrl?:unknown}|undefined;
    if(typeof page?.webSocketDebuggerUrl!=='string')return undefined;
    const target=new URL(page.webSocketDebuggerUrl);
    if(target.protocol!=='ws:'||target.hostname!==url.hostname||target.port!==url.port||!target.pathname.startsWith('/devtools/page/')
      ||target.username||target.password||target.search||target.hash)return undefined;
    socket=new Socket(target);
    return await new Promise<unknown>(resolve=>{
      const finish=(value:unknown)=>{if(timer)clearTimeout(timer);resolve(value);};
      timer=setTimeout(()=>finish(undefined),timeoutMs);
      socket!.onerror=()=>finish(undefined);socket!.onclose=()=>finish(undefined);
      socket!.onopen=()=>socket!.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{awaitPromise:true,returnByValue:true,
        expression}}));
      socket!.onmessage=event=>{
        try {const text=String(event.data);if(text.length>65536){finish(undefined);return;}
          const message=JSON.parse(text) as {id?:unknown;result?:{result?:{value?:unknown}}};
          if(message.id===1)finish(message.result?.result?.value);}
        catch{finish(undefined);}
      };
    });
  }catch{return undefined;}
  finally{if(timer)clearTimeout(timer);if(socket){socket.onerror=()=>{};socket.close();}}
}
export async function desktopStatus(debugUrl:string,request:typeof fetch=fetch,Socket:typeof WebSocket=WebSocket):Promise<DesktopStatus|undefined> {
  const value=await desktopQuery(debugUrl,"(async()=>{try{if(typeof globalThis.__wbInvoke!=='function')return null;const a=await globalThis.__wbInvoke('auth:getAccount',{});if(a?.__wbError)return null;return {authenticated:!!a&&typeof a.uid==='string'&&a.uid.length>0,productVersion:globalThis.workbuddyDesktop?.appVersion};}catch{return null;}})()",request,Socket) as Partial<DesktopStatus>|null|undefined;
  return value&&typeof value.authenticated==='boolean'&&typeof value.productVersion==='string'&&/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value.productVersion)
    ?{authenticated:value.authenticated,productVersion:value.productVersion}:undefined;
}
export async function desktopBootstrapReady(debugUrl:string,cwd:string,sessionRef:string,request:typeof fetch=fetch,Socket:typeof WebSocket=WebSocket,provenance:readonly BootstrapRunProvenance[]=[]):Promise<boolean> {
  if(!cwd||!sessionRef)return false;
  const value=await desktopQuery(debugUrl,`(async()=>{try{
    if(typeof globalThis.__wbInvoke!=='function')return false;
    const account=await globalThis.__wbInvoke('auth:getAccount',{});
    if(account?.__wbError||typeof account?.uid!=='string'||!account.uid)return false;
    const s=await globalThis.__wbInvoke('session:get',{},${JSON.stringify(sessionRef)});
    if(s?.__wbError||s?.sessionId!==${JSON.stringify(sessionRef)}||s?.cwd!==${JSON.stringify(cwd)}||s?.isProcessing!==false)return false;
    for(const key of ['pendingPermissions','pendingQuestions','pendingElicitations'])if(!Array.isArray(s[key])||s[key].length)return false;
    if(!Array.isArray(s.eventHistory))return false;
    const groups=${JSON.stringify(provenance)},tools=new Map();
    const field=(m,k)=>m?.['codebuddy.ai/'+k]??m?.['codebuddy.ai']?.[k]??m?.[k];
    for(const e of s.eventHistory){const u=e?.update??{};
      if(!['user_message_chunk','agent_message_chunk','assistant_message_chunk','agent_thought_chunk','tool_call','tool_call_update'].includes(u.sessionUpdate))continue;
      const metas=[e._meta,u._meta,u.content?._meta],refs=metas.flatMap(m=>['conversationRequestId','requestId'].map(k=>field(m,k))).filter(v=>v!==undefined);
      if(u.requestId!==undefined)refs.push(u.requestId);
      const origins=metas.map(m=>field(m,'messageRequestId')).filter(v=>v!==undefined),tool=u.toolCallId;
      const matches=groups.filter(g=>refs.every(ref=>g.owners.includes(ref))&&origins.every(ref=>g.owners.includes(ref)||g.inputs.includes(ref))&&
        (refs.length>0||typeof tool==='string'&&tools.get(tool)===g.runRef));
      if(matches.length!==1)return false;
      if(u.sessionUpdate==='tool_call'&&typeof tool==='string'){
        if(tools.has(tool)&&tools.get(tool)!==matches[0].runRef)return false;tools.set(tool,matches[0].runRef);
      }
    }
    return true;
  }catch{return false;}})()`,request,Socket);
  return value===true;
}
export async function desktopAuthenticated(debugUrl:string,request:typeof fetch=fetch,Socket:typeof WebSocket=WebSocket):Promise<boolean|undefined> {
  return (await desktopStatus(debugUrl,request,Socket))?.authenticated;
}
export async function desktopRuntimeRegistryDirectory(debugUrl:string,request:typeof fetch=fetch,Socket:typeof WebSocket=WebSocket):Promise<string|undefined> {
  const value=await desktopQuery(debugUrl,"(async()=>{try{if(typeof globalThis.__wbInvoke!=='function')return;const a=await globalThis.__wbInvoke('auth:getAccount',{});if(a?.__wbError||typeof a?.uid!=='string'||!a.uid)return;const d=await globalThis.__wbInvoke('app:getConfigDir',{});return typeof d==='string'?d:undefined;}catch{return;}})()",request,Socket);
  // 正常路径元数据只用于定位自有进程的 sessions/<pid>.json，永不读取账号配置。
  return typeof value==='string'&&isAbsolute(value)&&!value.includes('\0')?join(value,'sessions'):undefined;
}
export type DesktopBootstrapCreation={status:'created';sessionRef:string}|{status:'not_created'|'unknown'};
export async function createDesktopBootstrap(debugUrl:string,cwd:string,request:typeof fetch=fetch,Socket:typeof WebSocket=WebSocket,permissionMode?:'default'):Promise<DesktopBootstrapCreation> {
  if(permissionMode!==undefined&&permissionMode!=='default')return {status:'not_created'};
  const value=await desktopQuery(debugUrl,`(async()=>{let dispatched=false;try{
    if(typeof globalThis.__wbInvoke!=='function')return {status:'not_created'};
    const a=await globalThis.__wbInvoke('auth:getAccount',{});
    if(a?.__wbError||typeof a?.uid!=='string'||!a.uid)return {status:'not_created'};
    dispatched=true;const s=await globalThis.__wbInvoke('session:create',{}, {cwd:${JSON.stringify(cwd)}${permissionMode?',permissionMode:"default"':''}});
    if(s?.__wbError||typeof s?.sessionId!=='string'||!s.sessionId||s.cwd!==${JSON.stringify(cwd)})return {status:'unknown'};
    ${permissionMode?"if(s.config?.permissionMode!=='default')return {status:'unknown'};":''}
    return {status:'created',sessionRef:s.sessionId};
  }catch{return {status:dispatched?'unknown':'not_created'};}})()`,request,Socket,60000) as Partial<DesktopBootstrapCreation>|undefined;
  if(value?.status==='created'&&'sessionRef' in value&&typeof value.sessionRef==='string'&&value.sessionRef)return {status:'created',sessionRef:value.sessionRef};
  return {status:value?.status==='not_created'?'not_created':'unknown'};
}
