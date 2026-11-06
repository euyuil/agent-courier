import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareContextMode,reportsDefaultMode } from '../../src/adapters/workbuddy-experimental/context-mode.js';
import { connectWorkBuddy } from '../../src/adapters/workbuddy-experimental/factory.js';
import { connectionProfileSchema } from '../../src/config/real-profiles.js';

test('default-mode confirmation requires exactly one explicit native mode value',()=>{
  assert.equal(reportsDefaultMode({configOptions:[{id:'mode',currentValue:'default'}]}),true);
  for(const value of [{},{configOptions:[{id:'other',currentValue:'default'}]},{configOptions:[{id:'mode',currentValue:'initial'}]},
    {configOptions:[{id:'mode',currentValue:'default'},{id:'mode',currentValue:'initial'}]}])assert.equal(reportsDefaultMode(value),false);
});
test('unknown context configuration is not repeated, while a later authoritative native state can verify the desired mode without rewriting its operation result',async()=>{
  const data=new Map<string,unknown>(),store={get:(key:string)=>data.get(key),set:(key:string,value:unknown)=>{data.set(key,value);}};let calls=0;
  const connection={call:async()=>{calls++;throw new Error('private-error');}};
  await assert.rejects(prepareContextMode(connection,store,'private-A',{}),{message:'state_unknown'});
  await assert.rejects(prepareContextMode(connection,store,'private-A',{}),{message:'state_unknown'});assert.equal(calls,1);
  const operation=[...data].find(([key])=>key.startsWith('context-mode-operation:'))!;
  await prepareContextMode(connection,store,'private-A',{configOptions:[{id:'mode',currentValue:'default'}]});assert.equal(calls,1);
  assert.equal((data.get(operation[0]) as Record<string,unknown>)['status'],'unknown');
  assert.equal((data.get('context-mode:private-A') as Record<string,unknown>)['status'],'verified');
});
test('a dedicated factory refuses missing, empty or foreign context ownership before any activation',async()=>{
  for(const kind of ['missing','empty','uninitialized']){
    const data=new Map<string,unknown>();if(kind!=='missing')data.set('session:private-A',{courierSessionId:kind==='empty'?'':'courier-A'});
    const store={get:(key:string)=>data.get(key),set:(key:string,value:unknown)=>{data.set(key,value);}};let activations=0;
    const profile=connectionProfileSchema.parse({cwd:'synthetic-workspace',cliVersion:'synthetic',authorizationScope:[],desktopDebugUrl:'http://127.0.0.1:1',ownership:{mode:'courier-exclusive'}});
    await assert.rejects(connectWorkBuddy({profile,store,instanceId:'synthetic',evidence:[],contextSessionRef:'private-A',services:{
      create:async()=>{activations++;return {status:'not_created'};},ready:async()=>assert.fail(),discover:async()=>assert.fail(),inspect:async()=>assert.fail()}}));
    assert.equal(activations,0);assert.equal(data.has('desktop-host'),false);
  }
});
test('damaged context configuration metadata cannot authorize another mutation when the actual mode is unverified',async()=>{
  const data=new Map<string,unknown>([['context-mode:private-A',{status:'damaged',mode:'default'}]]);let calls=0;
  const store={get:(key:string)=>data.get(key),set:(key:string,value:unknown)=>{data.set(key,value);}};
  const connection={call:async()=>{calls++;return {configOptions:[{id:'mode',currentValue:'default'}]};}};
  await assert.rejects(prepareContextMode(connection,store,'private-A',{}),{message:'state_unknown'});assert.equal(calls,0);
});
