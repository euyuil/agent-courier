import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
