import { readFileSync,readdirSync,readlinkSync,statSync,openSync,closeSync,fstatSync,readSync,constants } from 'node:fs';
import { basename,join,resolve } from 'node:path';
import { AcpConnection } from './connection.js';

export interface RuntimeProcessIdentity {pid:number;startTime:string;bootId:string}
export interface DiscoveredRuntime {endpoint:string;processIdentity:RuntimeProcessIdentity;cliVersion?:string}
export interface RuntimeRegistryLookup {directory:string;cwd:string}
export type RuntimeProcessState='alive'|'ended'|'unknown';

function bootIdentity(procRoot:string):string {
  const value=readFileSync(join(procRoot,'sys/kernel/random/boot_id'),'utf8').trim();
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value))throw new Error('invalid_boot_identity');
  return value;
}
function processStart(procRoot:string,pid:number):string {
  const value=readFileSync(join(procRoot,String(pid),'stat'),'utf8'),end=value.lastIndexOf(') ');
  const start=end>=0?value.slice(end+2).trim().split(/\s+/)[19]:undefined;
  if(!/^\d+$/.test(start??'')||value.slice(0,value.indexOf(' '))!==String(pid))throw new Error('invalid_process_identity');
  return start!;
}
export function inspectRuntimeProcess(identity:RuntimeProcessIdentity,procRoot='/proc'):RuntimeProcessState {
  try {
    if(bootIdentity(procRoot)!==identity.bootId)return 'ended';
    try{return processStart(procRoot,identity.pid)===identity.startTime?'alive':'ended';}
    catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT'?'ended':'unknown';}
  }catch{return 'unknown';}
}
function registration(directory:string,pid:number,sessionRef:string):{origin:string;cliVersion?:string}|undefined {
  let fd:number|undefined;
  try {
    // 只打开已归属候选进程的单份运行注册记录；不遍历配置目录，不跟随文件链接。
    fd=openSync(join(directory,`${pid}.json`),constants.O_RDONLY|constants.O_NOFOLLOW);
    const info=fstatSync(fd);if(!info.isFile()||info.size>65536||process.getuid&&info.uid!==process.getuid())return undefined;
    const buffer=Buffer.alloc(65537),size=readSync(fd,buffer,0,buffer.length,0);if(size>65536)return undefined;
    const value=JSON.parse(buffer.subarray(0,size).toString('utf8')) as Record<string,unknown>;
    if(value['pid']!==pid||value['sessionId']!==sessionRef||typeof value['endpoint']!=='string')return undefined;
    const url=new URL(value['endpoint']);
    if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')return undefined;
    const version=value['version'];
    return {origin:url.origin,...(typeof version==='string'&&/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)?{cliVersion:version}:{})};
  }catch{return undefined;}finally{if(fd!==undefined)closeSync(fd);}
}

// 核对正常启动标识，或自有预热进程的运行注册记录，再验证 socket 归属；不读取环境或内存。
export async function discoverRuntime(sessionRef:string,request:typeof fetch=fetch,procRoot='/proc',registry?:RuntimeRegistryLookup):Promise<DiscoveredRuntime|undefined> {
  if(!sessionRef)return undefined;
  const endpoints=new Set<string>();let runtimes=0;
  let processIdentity:RuntimeProcessIdentity|undefined,bootId:string;
  let requiresRegistration=false;
  try{bootId=bootIdentity(procRoot);}catch{return undefined;}
  let processes:string[];try{processes=readdirSync(procRoot).filter(name=>/^\d+$/.test(name));}catch{return undefined;}
  for(const pid of processes)try {
    const directory=join(procRoot,pid);
    if(process.getuid&&statSync(directory).uid!==process.getuid())continue;
    const name=readFileSync(join(directory,'comm'),'utf8').trim();
    if(!/^(?:node(?:js)?|MainThread|electron|codebuddy.*|workbuddy.*)$/i.test(name))continue;
    const args=readFileSync(join(directory,'cmdline'),'utf8').split('\0');
    if(!args.some(arg=>['codebuddy-lite-wb.mjs','codebuddy-headless.js'].includes(basename(arg))||arg.replaceAll('\\','/').endsWith('/cli/bin/codebuddy')))continue;
    const exact=args.some((arg,index)=>arg===`--session-id=${sessionRef}`||arg==='--session-id'&&args[index+1]===sessionRef);
    if(!exact&&(!registry||!args.includes('--prewarm')||resolve(readlinkSync(join(directory,'cwd')))!==resolve(registry.cwd)))continue;
    const registered=registry?registration(registry.directory,Number(pid),sessionRef):undefined;
    if(!exact&&!registered)continue;
    runtimes++;
    requiresRegistration=!exact;
    processIdentity={pid:Number(pid),startTime:processStart(procRoot,Number(pid)),bootId};
    const sockets=new Set<string>();
    for(const fd of readdirSync(join(directory,'fd')))try{
      const inode=/^socket:\[(\d+)\]$/.exec(readlinkSync(join(directory,'fd',fd)))?.[1];if(inode)sockets.add(inode);
    }catch{/* 只保留仍能核实的描述符。 */}
    for(const table of ['tcp','tcp6']) {
      let lines:string[];try{lines=readFileSync(join(directory,'net',table),'utf8').split('\n');}catch{continue;}
      for(const line of lines) {
        const fields=line.trim().split(/\s+/);if(fields[3]!=='0A'||!sockets.has(fields[9]??''))continue;
        const [address,portText]=fields[1]!.split(':'),port=Number.parseInt(portText??'',16);
        if(!Number.isInteger(port)||port<1||port>65535)continue;
        const endpoint=address==='0100007F'?`http://127.0.0.1:${port}/api/v1/acp`:
          address==='00000000000000000000000001000000'?`http://[::1]:${port}/api/v1/acp`:undefined;
        if(endpoint&&(exact||new URL(endpoint).origin===registered?.origin))endpoints.add(endpoint);
      }
    }
  }catch{/* 缺失或不可访问的进程不提供归属证明。 */}
  if(runtimes!==1||!processIdentity)return undefined;
  const matches:string[]=[];
  for(const endpoint of endpoints) {
    const connection=new AcpConnection({endpoint,request,timeoutMs:3000});
    try{await connection.connect();if(connection.connected)matches.push(endpoint);}catch{/* 无修改请求的协议握手不通过即排除。 */}
    finally{await connection.close().catch(()=>{});}
  }
  const endpoint=matches.length===1?matches[0]:matches.length>1&&new Set(matches.map(value=>new URL(value).port)).size===1?
    matches.find(value=>new URL(value).hostname==='127.0.0.1'):undefined;
  if(!endpoint||inspectRuntimeProcess(processIdentity,procRoot)!=='alive')return undefined;
  const registered=registry?registration(registry.directory,processIdentity.pid,sessionRef):undefined;
  const matching=registered?.origin===new URL(endpoint).origin;
  if(requiresRegistration&&!matching)return undefined;
  return {endpoint,processIdentity,...(matching&&registered.cliVersion?{cliVersion:registered.cliVersion}:{})};
}
export async function discoverRuntimeEndpoint(sessionRef:string,request:typeof fetch=fetch,procRoot='/proc'):Promise<string|undefined> {
  return (await discoverRuntime(sessionRef,request,procRoot))?.endpoint;
}
