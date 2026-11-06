import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Readable,Writable } from 'node:stream';
import { resolve } from 'node:path';
import { formatMessage,decodeFormatterResult,formatterToolName } from '../../src/adapters/workbuddy-experimental/formatter.js';
import { FormatterServer,serveFormatter,formatterLineLimit } from '../../src/adapters/workbuddy-experimental/formatter-server.js';

const request=(id:string|number,method:string,params:unknown={})=>({jsonrpc:'2.0',id,method,params});
const initialize=request(0,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'synthetic',version:'1'}});
const call=(id:number,kind:string,text='same text')=>request(id,'tools/call',{name:formatterToolName,arguments:{kind,text}});
const line=(value:unknown)=>Buffer.from(JSON.stringify(value)+'\n');
async function exchange(chunks:Uint8Array[]) {
  const parts:Buffer[]=[];
  await serveFormatter(Readable.from(chunks),new Writable({write(chunk,_encoding,next){parts.push(Buffer.from(chunk));next();}}));
  return Buffer.concat(parts).toString('utf8').trimEnd().split('\n').map(value=>JSON.parse(value));
}

test('pure formatting preserves explicit types and repeated text while rejecting identity or control fields',()=>{
  for(const kind of ['progress','final'] as const)assert.deepEqual(formatMessage({kind,text:'same text'}),{schemaVersion:1,kind,text:'same text'});
  for(const value of [{kind:'analysis',text:'private'},{kind:'final',text:''},{kind:'final',text:'x'.repeat(65537)},
    {kind:'final',text:'text',sessionRef:'foreign'},{kind:'final',text:'text',decision:'approve'}])assert.equal(formatMessage(value),undefined);
});

test('formatter result decoding requires one structured payload and never guesses from plain text or ambiguous content',()=>{
  const payload={schemaVersion:1,kind:'final',text:'same same'};
  for(const text of [JSON.stringify(payload),JSON.stringify([{type:'text',text:JSON.stringify(payload)}])])
    assert.deepEqual(decodeFormatterResult({text}),payload);
  for(const raw of [{text:'Final answer: same same'},{text:'not JSON'},{text:JSON.stringify([{type:'text',text:JSON.stringify(payload)},{type:'text',text:JSON.stringify(payload)}])},
    {text:JSON.stringify({...payload,sessionRef:'foreign'})},{text:JSON.stringify(payload),isError:true},{text:JSON.stringify(payload),error:'private failure'}])
    assert.equal(decodeFormatterResult(raw),undefined);
});

test('formatter MCP negotiation and responses preserve transport IDs without accepting permissions or unsupported operations',()=>{
  const server=new FormatterServer();
  assert.ok(JSON.stringify(server.receive(call(1,'final'))).includes('Initialization required'));
  assert.equal((server.receive(initialize) as {id:number}).id,0);
  const list=server.receive(request('list','tools/list')) as {result:{tools:{annotations:{readOnlyHint:boolean};name:string}[]}};
  assert.equal(list.result.tools.length,1);assert.equal(list.result.tools[0]!.annotations.readOnlyHint,true);
  assert.equal(server.receive({jsonrpc:'2.0',method:'notifications/initialized'}),undefined);
  for(const kind of ['progress','final']) {
    const output=server.receive(call(2,kind)) as {id:number;result:{structuredContent:unknown}};
    assert.equal(output.id,2);assert.deepEqual(output.result.structuredContent,{schemaVersion:1,kind,text:'same text'});
  }
  const invalid=server.receive(request('synthetic-id','tools/call',{name:formatterToolName,arguments:{kind:'final',text:'body',path:'fixture-private-path'}}));
  assert.equal(JSON.stringify(invalid).includes('fixture-private'),false);
  assert.deepEqual(server.receive(request(3,'approve')),{jsonrpc:'2.0',id:3,error:{code:-32601,message:'Method not available'}});
  assert.deepEqual(server.receive({jsonrpc:'2.0',id:null,method:'ping'}),{jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}});
});

test('formatter stdio handles split Unicode, malformed lines, partial EOF and bounded input without echoing raw data',async()=>{
  const data=Buffer.concat([line(initialize),line(call(2,'progress','中文')),Buffer.from('fixture-private-invalid\n'),line(call(3,'final'))]);
  const middle=data.indexOf(Buffer.from('中文'))+1;
  const output=await exchange([data.subarray(0,middle),data.subarray(middle,middle+1),data.subarray(middle+1)]);
  assert.equal(output.length,4);assert.equal(output[1].result.structuredContent.text,'中文');assert.equal(output[2].error.code,-32700);
  assert.equal(output[3].result.structuredContent.kind,'final');assert.equal(JSON.stringify(output).includes('fixture-private'),false);
  assert.equal((await exchange([Buffer.from('{"jsonrpc":')]))[0].error.message,'Incomplete request');
  const bounded=await exchange([Buffer.alloc(formatterLineLimit+1,120),line(initialize)]);
  assert.deepEqual(bounded,[{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Request limit exceeded'}}]);
});

test('compiled formatter entry speaks only MCP JSON-RPC and exits when the Harness closes stdin',()=>{
  const input=Buffer.concat([line(initialize),line({jsonrpc:'2.0',method:'notifications/initialized'}),line(call(2,'final','synthetic result'))]);
  const stdout=execFileSync(process.execPath,[resolve('build/test/src/adapters/workbuddy-experimental/formatter-server.js')],
    {input,env:{},timeout:5000,encoding:'utf8',maxBuffer:1048576});
  const rows=stdout.trimEnd().split('\n').map(value=>JSON.parse(value));assert.equal(rows.length,2);
  assert.equal(rows[1].result.structuredContent.text,'synthetic result');assert.equal(rows[1].result.isError,false);
});
