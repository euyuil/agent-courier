import type { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { record } from './metadata.js';
import { formatMessage,formatterTool,formatterToolName,formatterServerInstructions } from './formatter.js';

export const formatterLineLimit=1048576;
const supportedVersions=new Set(['2024-11-05','2025-03-26','2025-06-18']);
const error=(id:string|number|null,code:number,message:string)=>({jsonrpc:'2.0',id,error:{code,message}});
const validId=(id:unknown):id is string|number=>typeof id==='string'||typeof id==='number'&&Number.isSafeInteger(id);

export class FormatterServer {
  private initialized=false;
  receive(value:unknown):unknown|undefined {
    const request=record(value),id=validId(request['id'])?request['id']:null;
    if(request['jsonrpc']!=='2.0'||typeof request['method']!=='string'||Array.isArray(value)||
      Object.hasOwn(request,'id')&&!validId(request['id']))return error(id,-32600,'Invalid request');
    if(!Object.hasOwn(request,'id'))return undefined;
    const result=(result:unknown)=>({jsonrpc:'2.0',id,result}),params=record(request['params']);
    if(request['method']==='initialize') {
      if(typeof params['protocolVersion']!=='string')return error(id,-32602,'Invalid initialization');
      this.initialized=true;
      return result({protocolVersion:supportedVersions.has(params['protocolVersion'])?params['protocolVersion']:'2025-06-18',
        capabilities:{tools:{}},serverInfo:{name:'Agent Courier message formatter',version:'1'},instructions:formatterServerInstructions});
    }
    if(request['method']==='ping')return result({});
    if(!this.initialized)return error(id,-32000,'Initialization required');
    if(request['method']==='tools/list') {
      if(params['cursor']!==undefined)return error(id,-32602,'Invalid cursor');
      return result({tools:[formatterTool]});
    }
    if(request['method']==='tools/call') {
      if(params['name']!==formatterToolName)return error(id,-32602,'Unknown tool');
      const payload=formatMessage(params['arguments']);
      if(!payload)return error(id,-32602,'Invalid formatter input');
      return result({content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:payload,isError:false});
    }
    return error(id,-32601,'Method not available');
  }
}

// stdout 只写 JSON-RPC；不读取配置、环境或文件，不访问网络/模型，
// 也不执行权限决定。
export async function serveFormatter(input:AsyncIterable<Uint8Array>,output:Writable):Promise<void> {
  const server=new FormatterServer();let parts:Buffer[]=[],size=0;
  const send=async(value:unknown)=>{
    if(value===undefined)return;
    await new Promise<void>((resolve,reject)=>output.write(JSON.stringify(value)+'\n',failure=>failure?reject(failure):resolve()));
  };
  for await(const raw of input) {
    const chunk=Buffer.from(raw);let start=0;
    while(start<chunk.length) {
      const newline=chunk.indexOf(10,start),end=newline<0?chunk.length:newline,part=chunk.subarray(start,end);
      if(size+part.length>formatterLineLimit){await send(error(null,-32700,'Request limit exceeded'));return;}
      parts.push(part);size+=part.length;
      if(newline<0)break;
      const bytes=Buffer.concat(parts,size);parts=[];size=0;
      if(bytes.length) {
        let request:unknown;
        try{request=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}
        catch{await send(error(null,-32700,'Invalid JSON'));start=newline+1;continue;}
        await send(server.receive(request));
      }
      start=newline+1;
    }
  }
  if(size)await send(error(null,-32700,'Incomplete request'));
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try{await serveFormatter(process.stdin,process.stdout);}catch{process.exitCode=1;}
}
