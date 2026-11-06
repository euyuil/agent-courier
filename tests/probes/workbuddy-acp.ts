import { readFileSync,readdirSync,readlinkSync } from 'node:fs';
import { basename,join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AcpConnection } from '../../src/adapters/workbuddy-experimental/connection.js';
import { WorkBuddyAdapter } from '../../src/adapters/workbuddy-experimental/session.js';
import { record,string } from '../../src/adapters/workbuddy-experimental/metadata.js';
import { safeCode } from '../../src/domain/errors.js';

interface Diagnostic {evaluate(expression:string,timeout?:number):Promise<unknown>}
export async function yieldOwnIdleSession(diagnostic:Diagnostic,owner:string):Promise<'confirmed'|'rejected'|'unknown'|'owner_mismatch'|'not_idle'> {
  try {
    const result=await diagnostic.evaluate(`(async()=>{try{
      const original=${JSON.stringify(owner)},p=globalThis.__courierCapabilityProbe;
      if(p?.sessionId!==original)return 'owner_mismatch';
      const before=await globalThis.__wbInvoke('session:get',{},original);
      if(before?.__wbError||before?.sessionId!==original||before?.isProcessing!==false)return 'not_idle';
      const yielded=await globalThis.__wbInvoke('session:requestYield',{},original);
      return yielded===true?'confirmed':yielded===false?'rejected':'unknown';
    }catch{return 'unknown';}})()`,10000);
    return ['confirmed','rejected','unknown','owner_mismatch','not_idle'].includes(String(result))?result as Awaited<ReturnType<typeof yieldOwnIdleSession>>:'unknown';
  }catch{return 'unknown';}
}
const initialized='[CodeBuddyCodeBackend] initialize() succeeded';
function localAcpUrl(value:string):URL|undefined {
  try {
    const url=new URL(value);
    if(url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)&&!url.username&&!url.password&&!url.search&&!url.hash&&
      /^\/api\/v1\/acp\/?$/.test(url.pathname))return url;
  }catch{/* 非本机 ACP 地址不提供发现依据。 */}
  return undefined;
}
export async function identifyOwnAcpTransport(endpoints:string[],request:typeof fetch=fetch):Promise<{endpoint?:string;matches:number;httpStatuses:number[]}> {
  const matches=new Set<string>(),httpStatuses:number[]=[];
  for(const endpoint of endpoints) {
    const url=localAcpUrl(endpoint);if(!url)continue;
    let status=0;
    const connection=new AcpConnection({endpoint:url.href,timeoutMs:3000,request:async(input,init)=>{
      const response=await request(input,init);if(init?.method===undefined)status=response.status;return response;
    }});
    try {
      // 仅建立协议订阅，不 initialize/load 或提交 Agent 输入。连接标识只来自正常握手。
      await connection.connect();if(connection.connected)matches.add(url.href);
    }catch{/* 不把非 ACP 服务或认证拒绝当作可用目标，不更改认证配置。 */}
    finally{httpStatuses.push(status);await connection.close().catch(()=>{});}
  }
  if(matches.size===1)return {endpoint:[...matches][0]!,matches:1,httpStatuses};
  // 同一已归属进程的双栈监听可共享端口；验证 ACP 订阅后统一选回环 IPv4。
  if(matches.size>1&&new Set([...matches].map(value=>new URL(value).port)).size===1) {
    const endpoint=[...matches].find(value=>new URL(value).hostname==='127.0.0.1');
    if(endpoint)return {endpoint,matches:matches.size,httpStatuses};
  }
  return {matches:matches.size,httpStatuses};
}
export function ownRuntimeEndpoints(cwd:string,procRoot='/proc',sessionRef?:string):{runtimeCount:number;endpoints:string[]} {
  const endpoints=new Set<string>();let runtimeCount=0;
  let processes:string[];try{processes=readdirSync(procRoot).filter(name=>/^\d+$/.test(name));}catch{return {runtimeCount,endpoints:[]};}
  for(const pid of processes) {
    const directory=join(procRoot,pid);
    try {
      let ownDirectory=false;try{ownDirectory=resolve(readlinkSync(join(directory,'cwd')))===resolve(cwd);}catch{/* 参数仍可提供明确的原会话关联。 */}
      if(!ownDirectory) {
        if(!sessionRef)continue;
        const name=readFileSync(join(directory,'comm'),'utf8').trim();
        if(!/^(?:node(?:js)?|MainThread|electron|codebuddy.*|workbuddy.*)$/i.test(name))continue;
      }
      // 仅取厂商脚本标识和显式 session-id；其他参数不提供发现依据，不读取环境或内存。
      const args=readFileSync(join(directory,'cmdline'),'utf8').split('\0');
      const vendor=args.some(arg=>
        ['codebuddy-lite-wb.mjs','codebuddy-headless.js'].includes(basename(arg))||arg.replaceAll('\\','/').endsWith('/cli/bin/codebuddy'));
      if(!vendor||(!ownDirectory&&!args.some((arg,index)=>arg===`--session-id=${sessionRef}`||
        (arg==='--session-id'&&args[index+1]===sessionRef))))continue;
      runtimeCount++;
      const sockets=new Set<string>();
      for(const fd of readdirSync(join(directory,'fd')))try{
        const match=/^socket:\[(\d+)\]$/.exec(readlinkSync(join(directory,'fd',fd)));if(match)sockets.add(match[1]!);
      }catch{/* 进程可在读取描述符期间退出。 */}
      for(const table of ['tcp','tcp6']) {
        let lines:string[];try{lines=readFileSync(join(directory,'net',table),'utf8').split('\n');}catch{continue;}
        for(const line of lines) {
          const fields=line.trim().split(/\s+/);if(fields[3]!=='0A'||!sockets.has(fields[9]??''))continue;
          const [address,portText]=fields[1]!.split(':');const port=Number.parseInt(portText??'',16);
          if(!Number.isInteger(port)||port<1||port>65535)continue;
          if(address==='0100007F')endpoints.add(`http://127.0.0.1:${port}/api/v1/acp`);
          else if(address==='00000000000000000000000001000000')endpoints.add(`http://[::1]:${port}/api/v1/acp`);
        }
      }
    }catch{/* 无访问权、标识不符或已经退出的进程不提供发现依据。 */}
  }
  return {runtimeCount,endpoints:[...endpoints]};
}
export function ownAcpEndpoint(log:string,sessionRef:string):string|undefined {
  const endpoints=new Set<string>();
  for(const raw of log.split('\n')) {
    if(!raw.includes(initialized))continue;
    let message=raw;
    // 兼容普通日志行与包含 message 字段的 JSON 行；仅解析同一条初始化完成记录。
    try{const outer=record(JSON.parse(raw));message=string(outer['message'])??string(outer['msg'])??raw;}catch{/* 普通日志前缀不是 JSON。 */}
    const marker=message.indexOf(initialized);if(marker<0)continue;
    const start=message.indexOf('{',marker+initialized.length),end=message.lastIndexOf('}');if(start<0||end<start)continue;
    try {
      const details=record(JSON.parse(message.slice(start,end+1)));if(details['sessionId']!==sessionRef)continue;
      const endpoint=string(details['endpoint']);if(!endpoint)continue;const url=localAcpUrl(endpoint);if(!url)continue;
      endpoints.add(url.href);
    }catch{/* 不猜测不完整、跨行或格式不符的记录。 */}
  }
  return endpoints.size===1?[...endpoints][0]:undefined;
}
export async function acpSurfaceExperiment(diagnostic:Diagnostic,logPath:string,cwd:string,processDiscovery=false,handoff=false):Promise<Record<string,unknown>> {
  const owner=await diagnostic.evaluate("(()=>{const p=globalThis.__courierCapabilityProbe;return typeof p?.sessionId==='string'?p.sessionId:undefined;})()");
  if(typeof owner!=='string'||!owner)return {status:'owner_unverified'};
  const log=readFileSync(logPath,'utf8'),runtime=processDiscovery?ownRuntimeEndpoints(cwd,'/proc',owner):undefined;
  const identified=runtime?await identifyOwnAcpTransport(runtime.endpoints):undefined;
  const endpoint=processDiscovery?identified?.endpoint:ownAcpEndpoint(log,owner);
  if(!endpoint)return {status:'endpoint_not_identified',runtimeInitializationLines:log.split('\n').filter(line=>line.includes(initialized)).length,
    acpAddressMentions:(log.match(/\/api\/v1\/acp/g)??[]).length,...(runtime?{ownedRuntimes:runtime.runtimeCount,ownedLoopbackListeners:runtime.endpoints.length,
      acpTransportMatches:identified?.matches??0,httpStatuses:identified?.httpStatuses??[]}:{})};
  let httpStatus:number|undefined;
  const request:typeof fetch=async(input,init)=>{
    const response=await fetch(input,init);if(init?.method===undefined)httpStatus=response.status;return response;
  };
  const data=new Map<string,unknown>(),connection=new AcpConnection({endpoint,request,timeoutMs:5000});
  const instanceId='independent-acp-surface';
  const adapter=new WorkBuddyAdapter({connection,store:{get:key=>data.get(key),set:(key,value)=>{data.set(key,value);}},cwd,instanceId,
    contextFingerprint:'independent-observation-only',evidence:[]});
  try {
    await adapter.connect();const report=await adapter.probe(instanceId);
    let load=await adapter.resumeSession({operationId:randomUUID(),sessionRef:owner}).receipt;
    const initialLoad=load;let yieldStatus:Awaited<ReturnType<typeof yieldOwnIdleSession>>|undefined;
    // 仅明确未接收的写入权冲突允许经正常接口交接，再尝试同一原会话一次；unknown 不重放。
    if(handoff&&load.status==='rejected'&&load.errorCode==='writer_occupied'&&load.definitelyNotAccepted) {
      yieldStatus=await yieldOwnIdleSession(diagnostic,owner);
      if(yieldStatus==='confirmed')load=await adapter.resumeSession({operationId:randomUUID(),sessionRef:owner}).receipt;
    }
    return {status:'observed',endpointIdentified:true,httpStatus,acpInitialized:true,
      cliVersion:report.cliVersion&&/^\d+\.\d+\.\d+$/.test(report.cliVersion)?report.cliVersion:'unknown',
      ...(handoff?{initialSessionLoad:initialLoad.status,yieldStatus:yieldStatus??'not_requested'}:{}),
      originalSessionLoad:load.status,...(load.status==='accepted'?{}:{code:load.errorCode}),agentRunStarts:0};
  }catch(error){return {status:'unavailable',endpointIdentified:true,...(httpStatus!==undefined?{httpStatus}:{}),code:safeCode(error),agentRunStarts:0};}
  finally{await adapter.disconnect(instanceId).catch(()=>{});}
}
