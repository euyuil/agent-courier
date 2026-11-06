import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync,spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { rig } from '../fixtures/rig.js';
import { acquireInstanceLock } from '../../src/storage/instance-lock.js';
import { reconcileCommand } from '../../src/cli/reconcile.js';
test('compiled CLI validates config, runs a synthetic three-output journey and queries safe read-only status',()=>{
  const dir=mkdtempSync(join(tmpdir(),'courier-cli-')),path=join(dir,'config.json');
  const main=fileURLToPath(new URL('../../src/main.js',import.meta.url));
  const config={schemaVersion:1,storage:{databasePath:'./private/state.sqlite'},platform:{kind:'fake',scopeRef:'synthetic-scope',robotRef:'synthetic-robot'},harness:{instanceId:'synthetic-harness',adapter:'mock'}};
  const run=(args:string[],input='')=>spawnSync(process.execPath,[main,...args],{input,encoding:'utf8'});
  try{
    writeFileSync(path,JSON.stringify(config),{mode:0o600});
    assert.equal(run(['validate-config','--config',path]).status,0);
    const served=run(['serve','--config',path],'not-json\n{"text":"synthetic-cli-only-content"}\n');assert.equal(served.status,0,served.stderr);
    const lines=served.stdout.trim().split('\n').map(line=>JSON.parse(line) as Record<string,unknown>);
    assert.equal(lines.at(-1)!['delivered'],3);assert.doesNotMatch(served.stdout,/synthetic-cli-only-content/);
    const state=spawnSync(process.execPath,['--input-type=module','-e',
      `import D from 'better-sqlite3';const d=new D(process.argv[1],{readonly:true});console.log(d.prepare('SELECT id FROM courier_sessions').get().id);d.close();`,join(dir,'private/state.sqlite')],{encoding:'utf8'});
    assert.equal(state.status,0);
    const status=run(['status','--config',path,'--session',state.stdout.trim(),'--json']);assert.equal(status.status,0,status.stderr);
    assert.equal(JSON.parse(status.stdout).execution.status,'completed');assert.doesNotMatch(status.stdout,/synthetic-cli-only-content|synthetic-scope|synthetic-robot|https?:/);
    assert.equal(run(['reconcile','--config',path,'--operation','synthetic','--delivery','synthetic']).status,2);
    assert.equal(run(['force-takeover','--config',path]).status,2);
    const noLive=run(['serve','--config',path,'--unknown-option','synthetic']);assert.equal(noLive.status,2);
  }finally{rmSync(dir,{recursive:true});}
});
test('CLI reconcile refuses a running service lock and unsupported inspection keeps unknown without sending',async()=>{
  const r=rig();try{
    await r.courier.accept(r.platform.inbound());const [ref,state]=[...r.harness.sessions][0]!;
    r.harness.message(ref,state.activeRun!,'final','synthetic');r.harness.complete(ref);
    r.platform.plans.push({result:{status:'unknown',safeReason:'synthetic'}});await r.courier.flush();
    const delivery=(r.db.prepare('SELECT id FROM outbound_deliveries').get() as {id:string}).id;
    const release=acquireInstanceLock(r.config.storage.databasePath);
    try{await assert.rejects(reconcileCommand(r.config,{delivery}),{message:'instance_locked'});}finally{release();}
    assert.equal(await reconcileCommand(r.config,{delivery}),5);assert.equal(r.platform.attempts.length,1);
    assert.equal((r.db.prepare('SELECT status FROM outbound_deliveries').get() as {status:string}).status,'unknown');
  }finally{await r.dispose();}
});
test('a running CLI reports a safe configuration reload failure and continues the next input with the last valid configuration',{timeout:10000},async(t)=>{
  const dir=mkdtempSync(join(tmpdir(),'courier-cli-reload-')),path=join(dir,'config.json');
  const main=fileURLToPath(new URL('../../src/main.js',import.meta.url));
  const config={schemaVersion:1,storage:{databasePath:'./private/state.sqlite'},platform:{kind:'fake',scopeRef:'synthetic-scope',robotRef:'synthetic-robot'},
    harness:{instanceId:'synthetic-harness',adapter:'mock'}};
  writeFileSync(path,JSON.stringify(config),{mode:0o600});
  const child=spawn(process.execPath,[main,'serve','--config',path],{stdio:['pipe','pipe','pipe']}),ended=once(child,'close');
  t.signal.addEventListener('abort',()=>{child.kill('SIGTERM');},{once:true});
  const lines=createInterface({input:child.stdout}),iterator=lines[Symbol.asyncIterator]();let errors='';
  child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{errors+=String(chunk);});child.stdin.on('error',()=>{});
  const read=async()=>{const line=await iterator.next();assert.equal(line.done,false);return JSON.parse(line.value!) as {status?:string;input?:{status:string};delivered?:number};};
  try {
    assert.equal((await read()).status,'ready');
    child.stdin.write('{"text":"synthetic first input"}\n');assert.equal((await read()).delivered,3);
    writeFileSync(path,'SYNTHETIC_PRIVATE_CONFIG_DETAIL',{mode:0o600});
    child.stdin.write('{"text":"synthetic second input"}\n');const second=await read();
    assert.equal(second.input?.status,'accepted');assert.equal(second.delivered,6);
    child.stdin.end();const [code]=await ended;assert.equal(code,0);
    assert.notEqual(errors.trim(),'','reload failure must be visible to the operator');
    const messages=errors.trim().split('\n').map(line=>JSON.parse(line) as {code:string;message:string});
    assert.equal(messages.length,1);assert.equal(messages[0]!.code,'configuration_invalid');assert.match(messages[0]!.message,/保留原有效配置/);
    assert.doesNotMatch(errors,/SYNTHETIC_PRIVATE_CONFIG_DETAIL|config\.json|courier-cli-reload-/);
  }finally{child.kill('SIGTERM');child.stdin.end();lines.close();await ended.catch(()=>{});rmSync(dir,{recursive:true,force:true});}
});
