// This opt-in desktop diagnostic path calls the normal account API. It never
// requests tokens, reads browser storage or discovers credentials from a process.
export interface DesktopStatus {authenticated:boolean;productVersion:string}
export async function desktopStatus(debugUrl:string,request:typeof fetch=fetch,Socket:typeof WebSocket=WebSocket):Promise<DesktopStatus|undefined> {
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
    return await new Promise<DesktopStatus|undefined>(resolve=>{
      const finish=(value:DesktopStatus|undefined)=>{if(timer)clearTimeout(timer);resolve(value);};
      timer=setTimeout(()=>finish(undefined),5000);
      socket!.onerror=()=>finish(undefined);socket!.onclose=()=>finish(undefined);
      socket!.onopen=()=>socket!.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{awaitPromise:true,returnByValue:true,
        expression:"(async()=>{try{if(typeof globalThis.__wbInvoke!=='function')return null;const a=await globalThis.__wbInvoke('auth:getAccount',{});if(a?.__wbError)return null;return {authenticated:!!a&&typeof a.uid==='string'&&a.uid.length>0,productVersion:globalThis.workbuddyDesktop?.appVersion};}catch{return null;}})()"}}));
      socket!.onmessage=event=>{
        try {const message=JSON.parse(String(event.data)) as {id?:unknown;result?:{result?:{value?:unknown}}};
          if(message.id===1){const value=message.result?.result?.value as Partial<DesktopStatus>|null|undefined;
            finish(value&&typeof value.authenticated==='boolean'&&typeof value.productVersion==='string'&&/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value.productVersion)
              ?{authenticated:value.authenticated,productVersion:value.productVersion}:undefined);}}
        catch{finish(undefined);}
      };
    });
  }catch{return undefined;}
  finally{if(timer)clearTimeout(timer);if(socket){socket.onerror=()=>{};socket.close();}}
}
export async function desktopAuthenticated(debugUrl:string,request:typeof fetch=fetch,Socket:typeof WebSocket=WebSocket):Promise<boolean|undefined> {
  return (await desktopStatus(debugUrl,request,Socket))?.authenticated;
}
