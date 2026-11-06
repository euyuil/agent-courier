import test from 'node:test';
import assert from 'node:assert/strict';
import { ownAcpEndpoint,ownRuntimeEndpoints,identifyOwnAcpTransport,yieldOwnIdleSession } from '../probes/workbuddy-acp.js';
import { runInNewContext } from 'node:vm';
import { mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('ACP observation selects only one exact own-session initialization record without credentials',()=>{
  const prefix='[CodeBuddyCodeBackend] initialize() succeeded ';
  const own=prefix+JSON.stringify({sessionId:'own',endpoint:'http://127.0.0.1:1/api/v1/acp'});
  const foreign=prefix+JSON.stringify({sessionId:'foreign',endpoint:'http://127.0.0.1:2/api/v1/acp'});
  assert.equal(ownAcpEndpoint(foreign+'\n'+own,'own'),'http://127.0.0.1:1/api/v1/acp');
  assert.equal(ownAcpEndpoint(JSON.stringify({level:'info',message:own}),'own'),'http://127.0.0.1:1/api/v1/acp');
  assert.equal(ownAcpEndpoint(foreign,'own'),undefined);
  assert.equal(ownAcpEndpoint(own+'\n'+prefix+JSON.stringify({sessionId:'own',endpoint:'http://127.0.0.1:3/api/v1/acp'}),'own'),undefined);
  for(const endpoint of ['http://example.invalid/api/v1/acp','http://127.0.0.1:1/api/v1/acp?password=synthetic',
    'http://user:synthetic@127.0.0.1:1/api/v1/acp','http://127.0.0.1:1/other'])
    assert.equal(ownAcpEndpoint(prefix+JSON.stringify({sessionId:'own',endpoint}),'own'),undefined);
});
test('Linux runtime observation restricts process identity, cwd and listener inode before discovering a loopback address',()=>{
  const root=mkdtempSync(join(tmpdir(),'courier-proc-fixture-')),workspace=join(root,'workspace');mkdirSync(workspace);
  const process=(pid:string,cwd:string,command:string)=>{
    const dir=join(root,pid);mkdirSync(join(dir,'fd'),{recursive:true});mkdirSync(join(dir,'net'));
    symlinkSync(cwd,join(dir,'cwd'));writeFileSync(join(dir,'comm'),'node\n');writeFileSync(join(dir,'cmdline'),command);symlinkSync('socket:[42]',join(dir,'fd','7'));
    writeFileSync(join(dir,'net','tcp'),' 0: 0100007F:0001 00000000:0000 0A 0:0 0:0 0 0 0 42\n'+
      ' 1: 0100007F:0002 00000000:0000 0A 0:0 0:0 0 0 0 99\n'+
      ' 2: 00000000:0003 00000000:0000 0A 0:0 0:0 0 0 0 42\n');
  };
  try {
    process('1',workspace,'node\0/vendor/cli/bin/codebuddy\0--private\0SYNTHETIC_NOT_EXTRACTED\0');
    process('2',join(root,'foreign'),'node\0/vendor/codebuddy-lite-wb.mjs\0');
    process('3',workspace,'node\0/other/application.mjs\0');
    assert.deepEqual(ownRuntimeEndpoints(workspace,root),{runtimeCount:1,endpoints:['http://127.0.0.1:1/api/v1/acp']});
    process('4',join(root,'other-working-directory'),'node\0/vendor/codebuddy-headless.js\0--session-id\0owned-session\0');
    assert.equal(ownRuntimeEndpoints(workspace,root).runtimeCount,1);
    assert.equal(ownRuntimeEndpoints(workspace,root,'owned-session').runtimeCount,2);
    assert.equal(ownRuntimeEndpoints(workspace,root,'unrelated-session').runtimeCount,1);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('ACP transport observation uses only owned loopback subscriptions, closes its connection and never sends an Agent command',async()=>{
  const urls:string[]=[];
  const request=(async(input,init)=>{
    const url=new URL(String(input));assert.equal(init?.redirect,'error');assert.equal(new Headers(init?.headers).has('Authorization'),false);
    if(init?.method==='DELETE'){assert.equal(new Headers(init.headers).get('Acp-Connection-Id'),'synthetic-probe');return new Response(null,{status:204});}
    assert.equal(init?.method,undefined);urls.push(url.href);
    if(url.port!=='1')return new Response(null,{status:404});
    return new Response(new ReadableStream<Uint8Array>({start(controller){init?.signal?.addEventListener('abort',()=>controller.close(),{once:true});}}),
      {headers:{'content-type':'text/event-stream','Acp-Connection-Id':'synthetic-probe'}});
  }) as typeof fetch;
  assert.deepEqual(await identifyOwnAcpTransport(['http://127.0.0.1:1/api/v1/acp','http://127.0.0.1:2/api/v1/acp',
    'http://example.invalid/api/v1/acp'],request),{endpoint:'http://127.0.0.1:1/api/v1/acp',matches:1,httpStatuses:[200,404]});
  assert.deepEqual(urls,['http://127.0.0.1:1/api/v1/acp','http://127.0.0.1:2/api/v1/acp']);
});
test('normal yield observation only mutates its own idle Harness session once and preserves unknown',async()=>{
  for(const scenario of ['foreign','busy','foreign_snapshot','false','unknown','throw','true']) {
    const calls:string[]=[];
    const diagnostic={evaluate:async(expression:string)=>await runInNewContext(expression,{globalThis:{
      __courierCapabilityProbe:{sessionId:scenario==='foreign'?'other':'own'},
      __wbInvoke:async(method:string,_context:unknown,session:string)=>{
        assert.equal(session,'own');calls.push(method);
        if(method==='session:get')return {sessionId:scenario==='foreign_snapshot'?'other':'own',isProcessing:scenario==='busy'};
        assert.equal(method,'session:requestYield');
        if(scenario==='throw')throw new Error('synthetic private failure');
        return scenario==='true'?true:scenario==='false'?false:undefined;
      },
    }})};
    const observed=await yieldOwnIdleSession(diagnostic,'own');
    assert.equal(observed,scenario==='foreign'?'owner_mismatch':scenario==='busy'||scenario==='foreign_snapshot'?'not_idle':
      scenario==='true'?'confirmed':scenario==='false'?'rejected':'unknown');
    assert.equal(calls.filter(method=>method==='session:requestYield').length,['foreign','busy','foreign_snapshot'].includes(scenario)?0:1);
  }
});
