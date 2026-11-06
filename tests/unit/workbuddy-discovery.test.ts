import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverRuntime,discoverRuntimeEndpoint,inspectRuntimeProcess } from '../../src/adapters/workbuddy-experimental/runtime-discovery.js';

const bootId='00000000-0000-4000-8000-000000000001';
function boot(root:string) {mkdirSync(join(root,'sys/kernel/random'),{recursive:true});writeFileSync(join(root,'sys/kernel/random/boot_id'),bootId);}
function processStat(pid:string,start='100') {return `${pid} (node (worker)) S ${Array(18).fill('0').join(' ')} ${start} 0\n`;}

test('production discovery requires an exact owned startup identity and probes only its loopback sockets',async()=>{
  const root=mkdtempSync(join(tmpdir(),'courier-discovery-'));let requests=0;
  boot(root);
  const process=(pid:string,session:string,address='0100007F',port='0002')=>{
    const dir=join(root,pid);mkdirSync(join(dir,'fd'),{recursive:true});mkdirSync(join(dir,'net'));
    writeFileSync(join(dir,'comm'),'node');writeFileSync(join(dir,'cmdline'),['node','/synthetic/codebuddy-lite-wb.mjs','--session-id',session,''].join('\0'));
    writeFileSync(join(dir,'stat'),processStat(pid));
    symlinkSync('socket:[42]',join(dir,'fd','1'));
    writeFileSync(join(dir,'net','tcp'),`header\n0: ${address}:${port} 00000000:0000 0A 0 0 0 0 0 42\n`);writeFileSync(join(dir,'net','tcp6'),'header\n');
  };
  const request=(async(_url,init)=>{
    requests++;assert.ok(String(_url).startsWith('http://127.0.0.1:2/'));if(init?.method==='DELETE')return new Response(null,{status:204});
    return new Response(new ReadableStream({start(controller){init?.signal?.addEventListener('abort',()=>controller.close(),{once:true});}}),
      {headers:{'content-type':'text/event-stream','Acp-Connection-Id':'synthetic-connection'}});
  }) as typeof fetch;
  try {
    process('10','foreign-host');assert.equal(await discoverRuntimeEndpoint('own-host',request,root),undefined);assert.equal(requests,0);
    process('11','own-host','00000000');assert.equal(await discoverRuntimeEndpoint('own-host',request,root),undefined);assert.equal(requests,0);
    rmSync(join(root,'11'),{recursive:true});process('11','own-host');
    assert.equal(await discoverRuntimeEndpoint('own-host',request,root),'http://127.0.0.1:2/api/v1/acp');
    assert.deepEqual(await discoverRuntime('own-host',request,root),{endpoint:'http://127.0.0.1:2/api/v1/acp',processIdentity:{pid:11,startTime:'100',bootId}});
    const count=requests;process('12','own-host');assert.equal(await discoverRuntimeEndpoint('own-host',request,root),undefined);assert.equal(requests,count);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('runtime death requires a readable kernel identity and distinguishes PID reuse, reboot and malformed metadata',()=>{
  const root=mkdtempSync(join(tmpdir(),'courier-liveness-'));boot(root);mkdirSync(join(root,'11'));
  const identity={pid:11,startTime:'100',bootId};
  try {
    writeFileSync(join(root,'11/stat'),processStat('11'));
    assert.equal(inspectRuntimeProcess(identity,root),'alive');
    writeFileSync(join(root,'11/stat'),processStat('11','101'));
    assert.equal(inspectRuntimeProcess(identity,root),'ended');
    writeFileSync(join(root,'11/stat'),'invalid');assert.equal(inspectRuntimeProcess(identity,root),'unknown');
    rmSync(join(root,'11'),{recursive:true});assert.equal(inspectRuntimeProcess(identity,root),'ended');
    writeFileSync(join(root,'sys/kernel/random/boot_id'),'00000000-0000-4000-8000-000000000002');
    assert.equal(inspectRuntimeProcess(identity,root),'ended');
    rmSync(join(root,'sys'),{recursive:true});assert.equal(inspectRuntimeProcess(identity,root),'unknown');
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('a process replaced during protocol discovery cannot provide an endpoint identity',async()=>{
  const root=mkdtempSync(join(tmpdir(),'courier-discovery-race-'));boot(root);const dir=join(root,'11');
  mkdirSync(join(dir,'fd'),{recursive:true});mkdirSync(join(dir,'net'));
  writeFileSync(join(dir,'comm'),'node');writeFileSync(join(dir,'cmdline'),'node\0/synthetic/codebuddy-lite-wb.mjs\0--session-id=own-host\0');
  writeFileSync(join(dir,'stat'),processStat('11'));symlinkSync('socket:[42]',join(dir,'fd','1'));
  writeFileSync(join(dir,'net/tcp'),'header\n0: 0100007F:0002 00000000:0000 0A 0 0 0 0 0 42\n');
  const request=(async(_url,init)=>{
    if(init?.method==='DELETE')return new Response(null,{status:204});
    writeFileSync(join(dir,'stat'),processStat('11','101'));
    return new Response(new ReadableStream({start(controller){init?.signal?.addEventListener('abort',()=>controller.close(),{once:true});}}),
      {headers:{'content-type':'text/event-stream','Acp-Connection-Id':'synthetic-connection'}});
  }) as typeof fetch;
  try{assert.equal(await discoverRuntime('own-host',request,root),undefined);}finally{rmSync(root,{recursive:true,force:true});}
});
test('a prewarmed runtime requires matching PID, host and owned endpoint in its normal private registry',async()=>{
  const root=mkdtempSync(join(tmpdir(),'courier-prewarm-'));boot(root);
  const dir=join(root,'11'),workspace=join(root,'workspace'),registry=join(root,'registry');
  mkdirSync(join(dir,'fd'),{recursive:true});mkdirSync(join(dir,'net'));mkdirSync(workspace);mkdirSync(registry);
  symlinkSync(workspace,join(dir,'cwd'));writeFileSync(join(dir,'comm'),'node');
  writeFileSync(join(dir,'cmdline'),'node\0/synthetic/codebuddy-lite-wb.mjs\0--prewarm\0');
  writeFileSync(join(dir,'stat'),processStat('11'));symlinkSync('socket:[42]',join(dir,'fd','1'));
  writeFileSync(join(dir,'net/tcp'),'header\n0: 0100007F:0002 00000000:0000 0A 0 0 0 0 0 42\n');
  let requests=0;const request=(async(_url,init)=>{
    requests++;if(init?.method==='DELETE')return new Response(null,{status:204});
    return new Response(new ReadableStream({start(controller){init?.signal?.addEventListener('abort',()=>controller.close(),{once:true});}}),
      {headers:{'content-type':'text/event-stream','Acp-Connection-Id':'synthetic-connection'}});
  }) as typeof fetch;
  const data={pid:11,sessionId:'own-host',endpoint:'http://127.0.0.1:2',version:'2.147.0'};
  const save=(patch:object)=>writeFileSync(join(registry,'11.json'),JSON.stringify({...data,...patch}),{mode:0o600});
  const lookup={directory:registry,cwd:workspace};
  try{
    for(const patch of [{sessionId:'foreign'},{pid:12},{endpoint:'http://127.0.0.1:3'},{endpoint:'http://example.invalid:2'}]){
      save(patch);assert.equal(await discoverRuntime('own-host',request,root,lookup),undefined);assert.equal(requests,0);
    }
    save({});assert.deepEqual(await discoverRuntime('own-host',request,root,lookup),
      {endpoint:'http://127.0.0.1:2/api/v1/acp',processIdentity:{pid:11,startTime:'100',bootId},cliVersion:'2.147.0'});
    rmSync(join(registry,'11.json'));symlinkSync(join(root,'foreign.json'),join(registry,'11.json'));writeFileSync(join(root,'foreign.json'),JSON.stringify(data));
    assert.equal(await discoverRuntime('own-host',request,root,lookup),undefined);
  }finally{rmSync(root,{recursive:true,force:true});}
});
