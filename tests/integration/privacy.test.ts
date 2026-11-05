import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,lstatSync,mkdirSync,chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDatabase,sharedStatus } from '../../src/storage/private-state.js';
import { openDatabase } from '../../src/storage/database.js';
import { rig } from '../fixtures/rig.js';
import { sessionStatus } from '../../src/cli/status.js';
test('consistent SQLite backup includes committed WAL state and preserves private file permissions',async()=>{
  const r=rig(),dir=mkdtempSync(join(tmpdir(),'courier-backup-'));
  try{
    await r.courier.accept(r.platform.inbound('synthetic-sensitive-content'));
    const destination=join(dir,'backup.sqlite');await backupDatabase(r.db,destination);
    assert.equal(lstatSync(destination).mode&0o777,0o600);
    const restored=openDatabase(destination,{readonly:true});
    try{assert.equal((restored.prepare('SELECT count(*) AS n FROM inputs').get() as {n:number}).n,1);}finally{restored.close();}
    await assert.rejects(backupDatabase(r.db,destination),{message:'storage_unavailable'});
    const session=(r.db.prepare('SELECT id FROM courier_sessions').get() as {id:string}).id;
    const shared=JSON.stringify(sharedStatus(sessionStatus(r.db,session)));
    assert.doesNotMatch(shared,new RegExp(session));assert.doesNotMatch(shared,/synthetic-sensitive-content|synthetic-private-a|synthetic-scope/);
  }finally{await r.dispose();rmSync(dir,{recursive:true});}
});
test('public directories and databases in the repository are refused without changing their permissions',()=>{
  const dir=mkdtempSync(join(tmpdir(),'courier-public-'));const publicDir=join(dir,'public');mkdirSync(publicDir);chmodSync(publicDir,0o755);
  try{
    assert.throws(()=>openDatabase(join(publicDir,'state.sqlite')),{message:'storage_unavailable'});
    assert.equal(lstatSync(publicDir).mode&0o777,0o755);
    assert.throws(()=>openDatabase(join(process.cwd(),'private','forbidden.sqlite')),{message:'storage_unavailable'});
  }finally{rmSync(dir,{recursive:true});}
});
