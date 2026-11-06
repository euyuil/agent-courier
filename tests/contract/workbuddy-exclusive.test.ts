import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpConnection } from '../../src/adapters/workbuddy-experimental/connection.js';
import { WorkBuddyAdapter } from '../../src/adapters/workbuddy-experimental/session.js';
import { connectionProfileSchema } from '../../src/config/real-profiles.js';

function fixture(mode='normal') {
  const data=new Map<string,unknown>(),calls:string[]=[];let ready=true;
  const store={get:(key:string)=>data.get(key),set:(key:string,value:unknown)=>{data.set(key,value);}};
  const build=(contextSessionRef?:string)=>{
    let news=0,loads=0;
    const connection=new AcpConnection({endpoint:'http://127.0.0.1:1/api/v1/acp',timeoutMs:20,request:(async(_url,init)=>{
      if(init?.method==='DELETE')return new Response(null,{status:204});
      if(init?.method==='POST') {
        const rpc=JSON.parse(String(init.body)) as {id:string;method:string};calls.push(rpc.method);
        if(rpc.method==='initialize')return Response.json({jsonrpc:'2.0',id:rpc.id,result:{agentCapabilities:{loadSession:true}}});
        if(rpc.method==='session/new') {
          news++;if(mode==='unknown'&&news===1)return new Response(null,{status:202});
          return Response.json({jsonrpc:'2.0',id:rpc.id,result:{sessionId:news===1?(mode==='mismatch'?'foreign-bootstrap':'owned-bootstrap'):'owned-user-context'}});
        }
        if(rpc.method==='session/load'){
          if(mode==='writer-occupied')return Response.json({jsonrpc:'2.0',id:rpc.id,error:{code:-32000,data:{reason:'writer_occupied'}}});
          loads++;return Response.json({jsonrpc:'2.0',id:rpc.id,result:{configOptions:[{id:'mode',currentValue:mode==='reload-mode-unknown'&&loads===1?'default':'initial'}]}});
        }
        if(rpc.method==='session/set_config_option') {
          if(mode==='mode-unknown'||mode==='reload-mode-unknown')return new Response(null,{status:202});
          return Response.json({jsonrpc:'2.0',id:rpc.id,result:{configOptions:[{id:'mode',currentValue:mode==='mode-not-applied'?'initial':'default'}]}});
        }
      }
      return new Response(new ReadableStream({start(controller){init?.signal?.addEventListener('abort',()=>controller.close(),{once:true});}}),
        {headers:{'content-type':'text/event-stream','Acp-Connection-Id':'synthetic-connection'}});
    }) as typeof fetch});
    return new WorkBuddyAdapter({connection,store,cwd:'synthetic-workspace',instanceId:'synthetic-instance',contextFingerprint:'synthetic',evidence:[],
      bootstrapSessionRef:'owned-bootstrap',verifyBootstrap:async()=>ready,receiptTimeoutMs:20,...(contextSessionRef?{contextSessionRef,contextPermissionMode:'default' as const}:{})});
  };
  return {data,calls,build,setReady(value:boolean){ready=value;}};
}

test('exclusive configuration requires an explicit desktop verifier and rejects unsupported ownership modes',()=>{
  const base={endpoint:'http://127.0.0.1:1/api/v1/acp',cwd:'.',cliVersion:'synthetic',authorizationScope:[],
    ownership:{mode:'courier-exclusive',bootstrapSessionRef:'owned-bootstrap'}};
  assert.equal(connectionProfileSchema.safeParse(base).success,false);
  assert.equal(connectionProfileSchema.safeParse({...base,desktopDebugUrl:'http://127.0.0.1:2'}).success,true);
  assert.equal(connectionProfileSchema.safeParse({...base,desktopDebugUrl:'http://127.0.0.1:2',ownership:{...base.ownership,mode:'force-takeover'}}).success,false);
});
test('a dedicated context connection loads only the original owned A first, confirms its default mode and never reinitializes H',async()=>{
  const f=fixture(),management=f.build();await management.connect();
  await management.createSession({operationId:'create-A',courierSessionId:'courier-A'}).receipt;await management.disconnect('synthetic-instance');
  const before=f.calls.length,context=f.build('owned-user-context');await context.connect();
  try {
    assert.deepEqual(f.calls.slice(before),['initialize']);
    const mark=f.calls.length;
    assert.equal((await context.createSession({operationId:'wrong-create',courierSessionId:'other'}).receipt).status,'rejected');
    assert.equal((await context.start({operationId:'before-load',sessionRef:'owned-user-context',inputId:'i',text:'must not run',clientRunId:'r'}).receipt).status,'unknown');
    assert.equal((await context.resumeSession({operationId:'foreign-load',sessionRef:'foreign'}).receipt).status,'rejected');
    assert.equal(f.calls.length,mark);
    assert.equal((await context.resumeSession({operationId:'load-A',sessionRef:'owned-user-context'}).receipt).status,'accepted');
    assert.deepEqual(f.calls.slice(before),['initialize','session/load','session/set_config_option']);
    assert.deepEqual(f.data.get('session:owned-user-context'),{courierSessionId:'courier-A'});
  }finally{await context.disconnect('synthetic-instance');}
});
test('dedicated connections require an accepted known bootstrap and an existing original Courier association before any RPC',async()=>{
  for(const kind of ['missing-bootstrap','foreign-context','bootstrap-as-context']){
    const f=fixture();if(kind!=='missing-bootstrap'){
      f.data.set('bootstrap:owned-bootstrap',{status:'accepted'});f.data.set('session:owned-bootstrap',{kind:'courier_bootstrap'});
    }
    if(kind==='missing-bootstrap')f.data.set('session:owned-user-context',{courierSessionId:'courier-A'});
    const context=f.build(kind==='bootstrap-as-context'?'owned-bootstrap':'owned-user-context');
    try{await assert.rejects(context.connect());assert.deepEqual(f.calls,[]);}finally{await context.disconnect('synthetic-instance');}
  }
});
test('uncertain default-mode setup survives reconstruction without repeating the mode change or starting a task',async()=>{
  const f=fixture('mode-unknown');f.data.set('bootstrap:owned-bootstrap',{status:'accepted'});f.data.set('session:owned-bootstrap',{kind:'courier_bootstrap'});
  f.data.set('session:owned-user-context',{courierSessionId:'courier-A'});
  for(let i=0;i<2;i++){
    const context=f.build('owned-user-context');await context.connect();
    try{assert.equal((await context.resumeSession({operationId:`load-${i}`,sessionRef:'owned-user-context'}).receipt).status,'unknown');}
    finally{await context.disconnect('synthetic-instance');}
  }
  assert.equal(f.calls.filter(method=>method==='session/set_config_option').length,1);assert.equal(f.calls.includes('session/prompt'),false);
});
test('an uncertain reload revokes an earlier context readiness before any new user input can start',async()=>{
  const f=fixture('reload-mode-unknown');f.data.set('bootstrap:owned-bootstrap',{status:'accepted'});f.data.set('session:owned-bootstrap',{kind:'courier_bootstrap'});
  f.data.set('session:owned-user-context',{courierSessionId:'courier-A'});const context=f.build('owned-user-context');await context.connect();
  try {
    assert.equal((await context.resumeSession({operationId:'first-load',sessionRef:'owned-user-context'}).receipt).status,'accepted');
    assert.equal((await context.resumeSession({operationId:'next-load',sessionRef:'owned-user-context'}).receipt).status,'unknown');
    assert.equal((await context.start({operationId:'blocked-start',sessionRef:'owned-user-context',inputId:'i',text:'must not run',clientRunId:'r'}).receipt).status,'unknown');
    assert.equal(f.calls.includes('session/prompt'),false);
  }finally{await context.disconnect('synthetic-instance');}
});
test('a foreign writer rejects dedicated load before mode changes and preserves the original A association',async()=>{
  const f=fixture('writer-occupied');f.data.set('bootstrap:owned-bootstrap',{status:'accepted'});f.data.set('session:owned-bootstrap',{kind:'courier_bootstrap'});
  f.data.set('session:owned-user-context',{courierSessionId:'courier-A'});const context=f.build('owned-user-context');await context.connect();
  try {
    assert.deepEqual(await context.resumeSession({operationId:'occupied-load',sessionRef:'owned-user-context'}).receipt,
      {status:'rejected',errorCode:'writer_occupied',definitelyNotAccepted:true});
    assert.equal(f.calls.includes('session/set_config_option'),false);assert.equal(f.calls.includes('session/new'),false);
    assert.deepEqual(f.data.get('session:owned-user-context'),{courierSessionId:'courier-A'});
  }finally{await context.disconnect('synthetic-instance');}
});
test('exclusive initialization reserves the desktop bootstrap and routes only separately created Courier contexts',async()=>{
  const f=fixture(),adapter=f.build();await adapter.connect();
  try {
    assert.deepEqual(f.calls,['initialize','session/new']);
    const created=await adapter.createSession({operationId:'create-own',courierSessionId:'courier-owner'}).receipt;
    assert.equal(created.status,'accepted');assert.equal(created.status==='accepted'&&created.sessionRef,'owned-user-context');
    const count=f.calls.length;
    f.data.set('session:malformed-owner',{courierSessionId:''});
    assert.equal((await adapter.resumeSession({operationId:'bad-host',sessionRef:'owned-bootstrap'}).receipt).status,'rejected');
    assert.equal((await adapter.resumeSession({operationId:'bad-external',sessionRef:'external-desktop-session'}).receipt).status,'rejected');
    assert.equal((await adapter.resumeSession({operationId:'bad-owner',sessionRef:'malformed-owner'}).receipt).status,'rejected');
    assert.equal((await adapter.start({operationId:'bad-start',sessionRef:'owned-bootstrap',inputId:'input',text:'must not dispatch',clientRunId:'run'}).receipt).status,'rejected');
    assert.equal(f.calls.length,count);
    assert.equal((await adapter.resumeSession({operationId:'load-own',sessionRef:'owned-user-context'}).receipt).status,'accepted');
    assert.deepEqual(f.data.get('session:owned-user-context'),{courierSessionId:'courier-owner'});
    assert.deepEqual(f.data.get('session:owned-bootstrap'),{kind:'courier_bootstrap'});
    assert.equal(f.calls.includes('session/prompt'),false);
  }finally{await adapter.disconnect('synthetic-instance');}
});
test('unknown or mismatched bootstrap initialization survives adapter reconstruction without another new request',async()=>{
  for(const mode of ['unknown','mismatch']) {
    const f=fixture(mode),first=f.build();await assert.rejects(first.connect());await first.disconnect('synthetic-instance');
    const count=f.calls.length,second=f.build();
    try {await assert.rejects(second.connect());assert.equal(f.calls.length,count);assert.equal(f.calls.filter(method=>method==='session/new').length,1);}
    finally{await second.disconnect('synthetic-instance');}
  }
});
test('a busy, unverified or already bound bootstrap cannot initialize or overwrite a Courier context',async()=>{
  for(const mode of ['unready','already-bound']) {
    const f=fixture();if(mode==='unready')f.setReady(false);else f.data.set('session:owned-bootstrap',{courierSessionId:'previous-owner'});
    const adapter=f.build();try {await assert.rejects(adapter.connect());assert.deepEqual(f.calls,[]);
      if(mode==='already-bound')assert.deepEqual(f.data.get('session:owned-bootstrap'),{courierSessionId:'previous-owner'});
    }finally{await adapter.disconnect('synthetic-instance');}
  }
});
