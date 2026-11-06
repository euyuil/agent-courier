import test from 'node:test';
import assert from 'node:assert/strict';
import { freshOwnedSession,initializeOwnedBootstrap } from '../probes/workbuddy-owned.js';

test('explicit bootstrap initialization matches only the probe-owned identity and sends no prompt',async()=>{
  const calls:{method:string;params:unknown;id:string|undefined}[]=[];
  const connection={call:async(method:string,params:unknown,id?:string)=>{calls.push({method,params,id});return {sessionId:'own-bootstrap'};}};
  assert.equal(await initializeOwnedBootstrap(connection,'synthetic-workspace','own-bootstrap'),'matched');
  assert.equal(calls.length,1);assert.equal(calls[0]!.method,'session/new');
  assert.deepEqual(calls[0]!.params,{cwd:'synthetic-workspace',mcpServers:[]});
  assert.ok(calls[0]!.id);
});

test('bootstrap mismatch or uncertainty stops initialization without retries or prompts',async()=>{
  for(const result of [{sessionId:'foreign'}, {}, {sessionId:''}, null]) {
    let calls=0;
    assert.equal(await initializeOwnedBootstrap({call:async()=>{calls++;return result;}},'synthetic-workspace','own-bootstrap'),'identity_mismatch');
    assert.equal(calls,1);
  }
  let calls=0;
  const connection={call:async()=>{calls++;throw new Error('synthetic transport loss');}};
  assert.equal(await initializeOwnedBootstrap(connection,'synthetic-workspace','own-bootstrap'),'unknown');
  assert.equal(calls,1);
  assert.equal(await initializeOwnedBootstrap(connection,'synthetic-workspace',''),'invalid');
  assert.equal(await initializeOwnedBootstrap(connection,'','own-bootstrap'),'invalid');
  assert.equal(calls,1);
});

test('the owned ACP experiment starts only in an explicitly accepted session different from its desktop bootstrap',()=>{
  assert.equal(freshOwnedSession({status:'accepted',sessionRef:'new-owned',receiptEvidence:'synthetic'},'bootstrap'),'new-owned');
  assert.equal(freshOwnedSession({status:'accepted',sessionRef:'bootstrap',receiptEvidence:'synthetic'},'bootstrap'),undefined);
  assert.equal(freshOwnedSession({status:'accepted',receiptEvidence:'synthetic'},'bootstrap'),undefined);
  assert.equal(freshOwnedSession({status:'accepted',sessionRef:'',receiptEvidence:'synthetic'},'bootstrap'),undefined);
  assert.equal(freshOwnedSession({status:'accepted',sessionRef:'new-owned',receiptEvidence:'synthetic'},''),undefined);
  assert.equal(freshOwnedSession({status:'unknown',errorCode:'state_unknown'},'bootstrap'),undefined);
  assert.equal(freshOwnedSession({status:'rejected',errorCode:'writer_occupied',definitelyNotAccepted:true},'bootstrap'),undefined);
});
