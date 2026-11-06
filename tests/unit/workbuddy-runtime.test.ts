import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionProfileSchema } from '../../src/config/real-profiles.js';
import { resolveWorkBuddyRuntime } from '../../src/adapters/workbuddy-experimental/runtime.js';
import { bootstrapProvenance,rememberBootstrapRun } from '../../src/adapters/workbuddy-experimental/bootstrap-provenance.js';

function fixture(mode='normal') {
  const data=new Map<string,unknown>(),calls:string[]=[];
  const profile=connectionProfileSchema.parse({cwd:'synthetic-workspace',cliVersion:'synthetic',authorizationScope:[],
    desktopDebugUrl:'http://127.0.0.1:1',ownership:{mode:'courier-exclusive'}});
  const store={get:(key:string)=>data.get(key),set:(key:string,value:unknown)=>{data.set(key,value);}};
  const services={create:async()=>{calls.push('create');return mode==='unknown'?{status:'unknown' as const}:
    mode==='not-created'?{status:'not_created' as const}:{status:'created' as const,sessionRef:'own-host'};},
    ready:async()=>{calls.push('ready');return mode!=='busy';},
    discover:async()=>{calls.push('discover');return mode==='missing'?undefined:{endpoint:'http://127.0.0.1:2/api/v1/acp',processIdentity:{pid:10,startTime:'100',bootId:'synthetic-boot'}};},
    inspect:async()=>{calls.push('inspect');return 'alive' as const;}};
  return {profile,store,data,calls,services,resolve:()=>resolveWorkBuddyRuntime(profile,store,services)};
}
test('automatic desktop bootstrap creates once, persists the host and discovers its current endpoint on later startup',async()=>{
  const f=fixture();
  for(let i=0;i<2;i++){
    const {inspectCliVersion,...target}=await f.resolve();assert.equal(typeof inspectCliVersion,'function');
    assert.deepEqual(target,{endpoint:'http://127.0.0.1:2/api/v1/acp',bootstrapSessionRef:'own-host'});
  }
  assert.deepEqual(f.calls,['create','ready','discover','inspect','ready','discover']);
  assert.ok(f.data.size>=2);
});
test('runtime CLI attestation rechecks the same live process and endpoint without creating another host',async()=>{
  const f=fixture();let mode='normal';
  const runtime=await resolveWorkBuddyRuntime(f.profile,f.store,{...f.services,inspect:async()=>mode==='dead'?'ended':'alive',
    discover:async()=>({endpoint:mode==='endpoint'?'http://127.0.0.1:3/api/v1/acp':'http://127.0.0.1:2/api/v1/acp',
      processIdentity:{pid:10,startTime:mode==='reused'?'101':'100',bootId:'synthetic-boot'},cliVersion:'2.147.0'})});
  assert.equal(await runtime.inspectCliVersion!(),'2.147.0');
  for(const change of ['dead','reused','endpoint']){mode=change;assert.equal(await runtime.inspectCliVersion!(),undefined);}
  assert.equal(f.calls.filter(call=>call==='create').length,1);
});
test('uncertain bootstrap creation and an interrupted persisted dispatch never create another host',async()=>{
  const f=fixture('unknown');await assert.rejects(f.resolve(),{message:'state_unknown'});
  await assert.rejects(f.resolve(),{message:'state_unknown'});assert.deepEqual(f.calls,['create']);
  const g=fixture();g.data.set('desktop-host',{schemaVersion:1,cwd:g.profile.cwd,status:'dispatching',operationId:'old-op'});
  await assert.rejects(g.resolve(),{message:'state_unknown'});assert.deepEqual(g.calls,[]);
});
test('a busy or undiscoverable known host is retained without replacement, and a changed workspace cannot adopt it',async()=>{
  for(const mode of ['busy','missing']) {const f=fixture(mode);
    await assert.rejects(f.resolve(),{message:'unconfigured'});await assert.rejects(f.resolve(),{message:'unconfigured'});
    assert.equal(f.calls.filter(call=>call==='create').length,1);
  }
  const f=fixture();await f.resolve();f.profile.cwd='different-workspace';
  await assert.rejects(f.resolve(),{message:'configuration_invalid'});assert.equal(f.calls.filter(call=>call==='create').length,1);
});
test('configured transport retains compatibility and automatic mode rejects ambiguous endpoint or missing desktop configuration',async()=>{
  const f=fixture();const plain=connectionProfileSchema.parse({endpoint:'http://127.0.0.1:2/api/v1/acp',cwd:'.',cliVersion:'synthetic',authorizationScope:[]});
  assert.deepEqual(await resolveWorkBuddyRuntime(plain,f.store,{create:async()=>assert.fail(),ready:async()=>assert.fail(),discover:async()=>assert.fail(),inspect:async()=>assert.fail()}),{endpoint:plain.endpoint});
  assert.equal(connectionProfileSchema.safeParse({...f.profile,endpoint:'http://127.0.0.1:2/api/v1/acp'}).success,false);
  const {desktopDebugUrl:_,...missing}=f.profile;assert.equal(connectionProfileSchema.safeParse(missing).success,false);
});
test('explicit default permission mode applies only when creating an automatic host and cannot silently adopt a differently configured cache',async()=>{
  const f=fixture();const profile=connectionProfileSchema.parse({...f.profile,bootstrapPermissionMode:'default'});let selected:unknown;
  await resolveWorkBuddyRuntime(profile,f.store,{...f.services,create:async(_cwd,permissionMode)=>{selected=permissionMode;return {status:'created',sessionRef:'default-host'};}});
  assert.equal(selected,'default');
  await assert.rejects(f.resolve(),{message:'configuration_invalid'});
  assert.equal(connectionProfileSchema.safeParse({...profile,ownership:{mode:'courier-exclusive',bootstrapSessionRef:'fixed-host'},endpoint:'http://127.0.0.1:2/api/v1/acp'}).success,false);
  assert.equal(connectionProfileSchema.safeParse({...profile,bootstrapPermissionMode:'bypassPermissions'}).success,false);
});
test('a context-only resolution cannot activate a missing or proven-dead startup host',async()=>{
  const f=fixture();await assert.rejects(resolveWorkBuddyRuntime(f.profile,f.store,f.services,true),{message:'unconfigured'});
  assert.deepEqual(f.calls,[]);await f.resolve();const before=f.calls.filter(call=>call==='create').length;
  await assert.rejects(resolveWorkBuddyRuntime(f.profile,f.store,{...f.services,inspect:async()=> 'ended'},true),{message:'unconfigured'});
  assert.equal(f.calls.filter(call=>call==='create').length,before);
});
test('only proven process death replaces an empty startup host and keeps original user bindings and operation history',async()=>{
  const f=fixture();await f.resolve();const original=f.data.get('desktop-host') as Record<string,unknown>;
  f.data.set('session:original-user-context',{courierSessionId:'original-courier-context'});
  const resolved=await resolveWorkBuddyRuntime(f.profile,f.store,{...f.services,inspect:async()=> 'ended',
    create:async()=>({status:'created',sessionRef:'replacement-host'}),
    discover:async()=>({endpoint:'http://127.0.0.1:3/api/v1/acp',processIdentity:{pid:20,startTime:'200',bootId:'synthetic-boot'}})});
  assert.equal(resolved.bootstrapSessionRef,'replacement-host');
  assert.deepEqual(f.data.get('session:original-user-context'),{courierSessionId:'original-courier-context'});
  const next=f.data.get('desktop-host') as Record<string,unknown>;
  assert.equal(next['previousOperationId'],original['operationId']);
  assert.equal((f.data.get(`desktop-host-operation:${original['operationId']}`) as Record<string,unknown>)['status'],'retired');
});
test('unknown process state, a live process with a changed identity, and ambiguous replacement never silently create again',async()=>{
  const f=fixture();await f.resolve();let creates=0;
  await assert.rejects(resolveWorkBuddyRuntime(f.profile,f.store,{...f.services,inspect:async()=> 'unknown',
    create:async()=>{creates++;return {status:'created',sessionRef:'unexpected'};}}),{message:'state_unknown'});
  assert.equal(creates,0);
  await assert.rejects(resolveWorkBuddyRuntime(f.profile,f.store,{...f.services,
    discover:async()=>({endpoint:'http://127.0.0.1:2/api/v1/acp',processIdentity:{pid:10,startTime:'101',bootId:'synthetic-boot'}})}),{message:'state_unknown'});
  await assert.rejects(resolveWorkBuddyRuntime(f.profile,f.store,{...f.services,inspect:async()=> 'ended',
    create:async()=>{creates++;return {status:'unknown'};}}),{message:'state_unknown'});
  await assert.rejects(f.resolve(),{message:'state_unknown'});assert.equal(creates,1);
});
test('a safely uncreated replacement retains its predecessor and cannot adopt the retired host on retry',async()=>{
  const f=fixture();await f.resolve();
  await assert.rejects(resolveWorkBuddyRuntime(f.profile,f.store,{...f.services,inspect:async()=> 'ended',
    create:async()=>({status:'not_created'})}),{message:'unconfigured'});
  assert.equal((f.data.get('desktop-host') as Record<string,unknown>)['previousSessionRef'],'own-host');
  await assert.rejects(f.resolve(),{message:'state_unknown'});
});
test('a cached host without process evidence stays retained and damaged process evidence cannot authorize replacement',async()=>{
  const f=fixture();f.data.set('desktop-host',{schemaVersion:1,cwd:f.profile.cwd,status:'ready',operationId:'old-op',sessionRef:'old-host'});
  await assert.rejects(resolveWorkBuddyRuntime(f.profile,f.store,{...f.services,ready:async()=>false}),{message:'unconfigured'});
  assert.equal(f.calls.includes('create'),false);
  f.data.set('desktop-host',{...(f.data.get('desktop-host') as object),processIdentity:{pid:10,startTime:100,bootId:'synthetic-boot'}});
  await assert.rejects(f.resolve(),{message:'state_unknown'});assert.equal(f.calls.includes('create'),false);
});
test('persisted bootstrap provenance keeps original Runs separate and accepts new owners only within their recorded group',()=>{
  const f=fixture();rememberBootstrapRun(f.store,'host','original-run','original-input');
  rememberBootstrapRun(f.store,'host','original-run','steer-input','verified-next');
  rememberBootstrapRun(f.store,'host','other-run','other-input');
  assert.deepEqual(bootstrapProvenance(f.store,'host'),[
    {runRef:'original-run',owners:['original-run','verified-next'],inputs:['original-input','steer-input']},
    {runRef:'other-run',owners:['other-run'],inputs:['other-input']}]);
  assert.throws(()=>rememberBootstrapRun(f.store,'host','other-run','other-input','verified-next'),{message:'protocol_conflict'});
  f.data.set('bootstrap-provenance:host',[{runRef:'broken',owners:[],inputs:[]}]);
  assert.throws(()=>bootstrapProvenance(f.store,'host'),{message:'state_unknown'});
});
