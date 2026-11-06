import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpConnection } from '../../src/adapters/workbuddy-experimental/connection.js';
import { WorkBuddyAdapter } from '../../src/adapters/workbuddy-experimental/session.js';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';
import type { MappingStore } from '../../src/storage/adapter-mappings.js';
import { desktopAuthenticated } from '../../src/adapters/workbuddy-experimental/authentication.js';
import { rejectedReceipt } from '../../src/adapters/workbuddy-experimental/errors.js';
import { RpcFailure } from '../../src/adapters/workbuddy-experimental/connection.js';
import { interaction } from '../../src/adapters/workbuddy-experimental/interaction.js';
import { requiredCapabilities } from '../../src/domain/capabilities.js';

function fixture(resolution:unknown={resolved:true,queued:false},steerResponse:'accepted'|'timeout'='accepted',formatterLaunch?:{executable:string;entrypoint:string},typedFormatterOutput=false) {
  let stream:ReadableStreamDefaultController<Uint8Array>;
  const calls:{id:string|number;method:string;params:Record<string,unknown>;result?:unknown}[]=[];
  const request=(async(_url,init)=>{
    if(init?.method==='DELETE'){return new Response(null,{status:204});}
    if(init?.method==='POST') {
      const rpc=JSON.parse(String(init.body)) as typeof calls[number];calls.push(rpc);
      if(rpc.method==='initialize')return Response.json({jsonrpc:'2.0',id:rpc.id,result:{agentInfo:{name:'WorkBuddy',version:'synthetic'},agentCapabilities:{loadSession:true}}});
      if(rpc.method==='session/new')return Response.json({jsonrpc:'2.0',id:rpc.id,result:{sessionId:'synthetic-harness-session'}});
      if(rpc.method==='session/load')return Response.json({jsonrpc:'2.0',id:rpc.id,result:{}});
      if(rpc.method==='session/steer'&&steerResponse==='accepted')return Response.json({jsonrpc:'2.0',id:rpc.id,result:{steered:true,ownerRequestId:rpc.params['expectedRequestId']}});
      if(rpc.method==='_codebuddy.ai/resolveInterruption')return Response.json({jsonrpc:'2.0',id:rpc.id,result:resolution});
      return new Response(null,{status:202});
    }
    return new Response(new ReadableStream<Uint8Array>({start(controller){stream=controller;
      init?.signal?.addEventListener('abort',()=>controller.close(),{once:true});}}),
      {headers:{'content-type':'text/event-stream','Acp-Connection-Id':'synthetic-connection'}});
  }) as typeof fetch;
  const connection=new AcpConnection({endpoint:'http://127.0.0.1:1/api/v1/acp',request,timeoutMs:100});
  const data=new Map<string,unknown>(),store:MappingStore={get:key=>data.get(key),set:(key,value)=>{data.set(key,value);}};
  const adapter=new WorkBuddyAdapter({connection,store,cwd:'.',instanceId:'synthetic-instance',contextFingerprint:'synthetic',evidence:[],authentication:async()=>true,
    ...(formatterLaunch?{formatterLaunch}:{}),typedFormatterOutput});
  return {connection,adapter,calls,data,send(message:unknown){stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message)}\r\n\r\n`));}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('runtime CLI identity must remain confirmed and agree with an ACP version before versioned capabilities are admitted',async()=>{
  for(const runtimeVersion of ['synthetic','different',undefined]){
    const f=fixture(),data=new Map<string,unknown>();
    const evidence={id:'synthetic-proof',kind:'harness' as const,adapterVersion:'1',productVersion:'synthetic-desktop',contextFingerprint:'synthetic',
      checkedAt:1,outcome:'passed' as const,evidenceRef:'synthetic-only',scope:Object.fromEntries(requiredCapabilities.map(capability=>[capability,{states:[],limitations:[]}]))};
    const adapter=new WorkBuddyAdapter({connection:f.connection,store:{get:key=>data.get(key),set:(key,value)=>{data.set(key,value);}},cwd:'.',
      instanceId:'synthetic-instance',contextFingerprint:'synthetic',evidence:[evidence],expectedCliVersion:'synthetic',
      runtimeVersion:async()=>runtimeVersion,identity:async()=>({authenticated:true,productVersion:'synthetic-desktop'})});
    await adapter.connect();
    try{
      const report=await adapter.probe('synthetic-instance');
      assert.equal(report.cliVersion,runtimeVersion==='synthetic'?'synthetic':undefined);
      assert.equal(report.capabilities.isolatedSessions,runtimeVersion==='synthetic'?'supported':'unverified');
      assert.equal(report.capabilities.typedVisibleOutput,'unverified');
    }finally{await adapter.disconnect('synthetic-instance');}
  }
});
test('typed formatter mode requires an explicitly configured producer',()=>{
  assert.throws(()=>fixture(undefined,'accepted',undefined,true),{message:'configuration_invalid'});
});
test('changed output artifacts revoke required capability admission without rewriting prior evidence',async()=>{
  const f=fixture(),data=new Map<string,unknown>();let current=true;
  const evidence={id:'synthetic-proof',kind:'harness' as const,adapterVersion:'1',productVersion:'synthetic-desktop',contextFingerprint:'synthetic',
    checkedAt:1,outcome:'passed' as const,evidenceRef:'synthetic-only',scope:Object.fromEntries(requiredCapabilities.map(capability=>[capability,{states:[],limitations:[]}]))};
  const adapter=new WorkBuddyAdapter({connection:f.connection,store:{get:key=>data.get(key),set:(key,value)=>{data.set(key,value);}},cwd:'.',
    instanceId:'synthetic-instance',contextFingerprint:'synthetic',evidence:[evidence],identity:async()=>({authenticated:true,productVersion:'synthetic-desktop'}),
    verifyOutputProfile:()=>current});
  await adapter.connect();
  try {
    assert.equal((await adapter.probe('synthetic-instance')).capabilities.isolatedSessions,'supported');
    current=false;const changed=await adapter.probe('synthetic-instance');
    assert.ok(requiredCapabilities.every(capability=>changed.capabilities[capability]==='unverified'));
    assert.ok(changed.limitations.includes('output_profile_changed'));assert.equal(evidence.outcome,'passed');
  }finally{await adapter.disconnect('synthetic-instance');}
});
test('typed formatter follows a verified steer owner only with the original prompt provenance',async()=>{
  const f=fixture(undefined,'accepted',{executable:'/synthetic/bin/node',entrypoint:'/synthetic/formatter-server.js'},true);
  await f.adapter.connect();const session='synthetic-harness-session',events:HarnessEvent[]=[];f.adapter.subscribe(session,e=>events.push(e));
  try {
    const handle=f.adapter.start({operationId:'typed-steer-start',inputId:'input',sessionRef:session,text:'synthetic',clientRunId:'courier-run'});
    await tick();const command=f.calls.find(call=>call.method==='session/prompt')!,run=(command.params['_meta'] as Record<string,string>)['codebuddy.ai/conversationRequestId']!;
    const tracking=command.params['_meta'] as Record<string,string>;
    assert.equal(tracking['codebuddy.ai/requestId'],run);
    assert.equal(tracking['codebuddy.ai/messageRequestId'],run);
    assert.ok(!['typed-steer-start','input','courier-run'].includes(run));
    const prompt=command.params['prompt'] as {type:string;text:string}[];
    assert.equal(prompt.length,2);assert.equal(prompt[0]!.type,'text');
    assert.match(prompt[0]!.text,/courier-formatter\/1/);assert.match(prompt[0]!.text,/mcp__courier_formatter__courier_format_message/);
    assert.deepEqual(prompt[1],{type:'text',text:'synthetic'});
    const send=(update:unknown,sessionId=session)=>f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update}});
    send({sessionUpdate:'user_message_chunk',_meta:{'codebuddy.ai/requestId':run}});await handle.receipt;
    const source=(id:string,owner:string,origin:string)=>({sessionUpdate:'tool_call',toolCallId:id,status:'in_progress',rawInput:{kind:'final',text:'linked body'},
      _meta:{'codebuddy.ai/conversationRequestId':owner,'codebuddy.ai/requestId':owner,'codebuddy.ai/messageRequestId':origin,
        'codebuddy.ai/toolName':'mcp__courier_formatter__courier_format_message'}});
    const done=(id:string,owner?:string,origin=run)=>({sessionUpdate:'tool_call_update',toolCallId:id,status:'completed',
      rawOutput:{text:JSON.stringify({schemaVersion:1,kind:'final',text:'linked body'})},
      ...(owner?{_meta:{'codebuddy.ai/conversationRequestId':owner,'codebuddy.ai/requestId':owner,'codebuddy.ai/messageRequestId':origin}}:{})});
    send(source('unproved','native-next',run));send(done('unproved','native-next'));await tick();
    assert.equal(events.some(e=>e.eventType==='message.started'),false);
    const input={operationId:'typed-steer',inputId:'typed-extra',sessionRef:session,expectedRunRef:run,text:'synthetic change'};
    assert.equal((await f.adapter.steer(input).receipt).status,'accepted');
    const steer=f.calls.find(call=>call.id===input.operationId)!;
    send({sessionUpdate:'user_message_chunk',messageId:input.inputId,content:{type:'text',text:input.text},_meta:{'codebuddy.ai/conversationRequestId':run,'codebuddy.ai/requestId':'native-next',
      'codebuddy.ai/messageRequestId':input.inputId,'codebuddy.ai/messageId':input.inputId,'codebuddy.ai/steerClientMeta':steer.params['_meta']}});await tick();
    assert.equal(events.filter(e=>e.eventType==='input.applied').length,1);
    send(source('foreign-origin','native-next','foreign'));send(done('foreign-origin','native-next','foreign'));send(done('foreign-origin'));
    send({...source('conflicting','native-next',run),_meta:{...source('conflicting','native-next',run)._meta,'codebuddy.ai/requestId':'foreign'}});
    send({...source('member','native-next',run),_meta:{...source('member','native-next',run)._meta,'codebuddy.ai/isTeamMember':true}});
    send({...source('history','native-next',run),_meta:{...source('history','native-next',run)._meta,'codebuddy.ai/historyReplay':true}});
    send(source('foreign-session','native-next',run),'foreign-session');await tick();
    assert.equal(events.some(e=>e.eventType==='message.started'),false);
    send({...source('linked','native-next',run),_meta:{...source('linked','native-next',run)._meta,'codebuddy.ai/conversationRequestId':run}});
    send(done('linked','native-next'));send(done('linked'));await tick();
    const bodies=events.filter(e=>e.eventType==='message.fragment');assert.equal(bodies.length,1);
    assert.equal(bodies[0]!.eventType==='message.fragment'&&bodies[0]!.payload.text,'linked body');
    assert.equal(events.some(e=>e.eventType==='run.completed'),false);
    f.send({jsonrpc:'2.0',id:'typed-steer-start',result:{stopReason:'end_turn'}});await tick();
    assert.equal(events.filter(e=>e.eventType==='run.completed').length,1);assert.ok(events.every(e=>e.runRef===run));
  }finally{await f.adapter.disconnect('synthetic-instance');}
});
test('conflicting original formatter metadata cannot establish tool ownership for a later unscoped result',async()=>{
  const f=fixture(undefined,'accepted',{executable:'/synthetic/bin/node',entrypoint:'/synthetic/formatter-server.js'},true);
  await f.adapter.connect();const session='synthetic-harness-session',events:HarnessEvent[]=[];f.adapter.subscribe(session,e=>events.push(e));
  try {
    const handle=f.adapter.start({operationId:'conflict-start',inputId:'input',sessionRef:session,text:'synthetic',clientRunId:'courier-run'});
    await tick();const command=f.calls.find(call=>call.method==='session/prompt')!,run=(command.params['_meta'] as Record<string,string>)['codebuddy.ai/conversationRequestId']!;
    const send=(update:unknown)=>f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update}});
    send({sessionUpdate:'tool_call',toolCallId:'ambiguous',rawInput:{kind:'final',text:'untrusted'},_meta:{
      'codebuddy.ai/conversationRequestId':run,'codebuddy.ai/requestId':'foreign','codebuddy.ai/toolName':'mcp__courier_formatter__courier_format_message'}});
    await tick();assert.equal(events.some(e=>e.eventType==='run.started'||e.eventType==='message.started'),false);
    send({sessionUpdate:'user_message_chunk',_meta:{'codebuddy.ai/requestId':run}});await handle.receipt;
    send({sessionUpdate:'tool_call_update',toolCallId:'ambiguous',status:'completed',rawOutput:{text:JSON.stringify({schemaVersion:1,kind:'final',text:'untrusted'})}});
    await tick();assert.equal(events.some(e=>e.eventType==='message.fragment'),false);
  }finally{await f.adapter.disconnect('synthetic-instance');}
});
test('native human requests after verified steer retain the original Run and explicit answer or withdrawal scope',async()=>{
  const f=fixture(undefined,'accepted',{executable:'/synthetic/bin/node',entrypoint:'/synthetic/formatter-server.js'},true);
  await f.adapter.connect();const session='synthetic-harness-session',events:HarnessEvent[]=[];f.adapter.subscribe(session,event=>events.push(event));
  try {
    const started=f.adapter.start({operationId:'question-after-steer-start',inputId:'original-input',sessionRef:session,text:'synthetic',clientRunId:'courier-run'});
    await tick();const run=(f.calls.find(call=>call.id===started.operationId)!.params['_meta'] as Record<string,string>)['codebuddy.ai/conversationRequestId']!;
    const send=(update:unknown)=>f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update}});
    send({sessionUpdate:'user_message_chunk',_meta:{'codebuddy.ai/requestId':run}});await started.receipt;
    const control={operationId:'question-control',inputId:'question-control-input',sessionRef:session,expectedRunRef:run,text:'continue'};
    await f.adapter.steer(control).receipt;const command=f.calls.find(call=>call.id===control.operationId)!;
    send({sessionUpdate:'user_message_chunk',messageId:control.inputId,content:{type:'text',text:control.text},_meta:{'codebuddy.ai/conversationRequestId':run,
      'codebuddy.ai/requestId':'question-owner','codebuddy.ai/messageRequestId':control.inputId,'codebuddy.ai/messageId':control.inputId,
      'codebuddy.ai/steerClientMeta':command.params['_meta']}});await tick();
    const meta={'codebuddy.ai/requestId':'question-owner','codebuddy.ai/conversationRequestId':'question-owner','codebuddy.ai/messageRequestId':run};
    const questions=[{question:'Controlled question?',options:[{label:'A'},{label:'B'}]}];
    const ambiguous={...meta,'codebuddy.ai/conversationRequestId':run,'codebuddy.ai/requestId':'foreign-owner'};
    send({sessionUpdate:'tool_call',toolCallId:'original-conflict',rawInput:{questions},_meta:{...ambiguous,'codebuddy.ai/toolName':'AskUserQuestion'}});
    send({sessionUpdate:'session_info_update',_meta:{...ambiguous,'codebuddy.ai/interruptionRequest':{interruptionId:'foreign-q',toolCallId:'original-conflict',
      toolName:'AskUserQuestion',toolInput:{questions},options:['allow','deny']}}});
    for(const [id,extra] of [['foreign-origin',{'codebuddy.ai/messageRequestId':'foreign'}],['foreign-owner',{'codebuddy.ai/requestId':'unknown-owner'}],
      ['member',{'codebuddy.ai/isTeamMember':true}],['history',{'codebuddy.ai/historyReplay':true}]] as const)
      send({sessionUpdate:'tool_call',toolCallId:id,rawInput:{questions},_meta:{...meta,'codebuddy.ai/toolName':'AskUserQuestion',...extra}});
    await tick();assert.equal(events.some(event=>event.eventType==='input.requested'),false);
    send({sessionUpdate:'session_info_update',_meta:{'codebuddy.ai/interruptionRequest':{interruptionId:'native-q',toolCallId:'original-q',
      toolName:'AskUserQuestion',toolInput:{questions},options:['allow','deny']}}});
    await tick();assert.equal(events.some(event=>event.eventType==='input.requested'),false);
    send({sessionUpdate:'tool_call',toolCallId:'original-q',rawInput:{questions},_meta:{...meta,'codebuddy.ai/conversationRequestId':run,'codebuddy.ai/toolName':'AskUserQuestion'}});await tick();
    const requests=events.filter(event=>event.eventType==='input.requested');assert.equal(requests.length,1);
    const request=requests[0]!;assert.equal(request.runRef,run);assert.equal(request.payload.kind,'question');
    assert.equal(f.calls.filter(call=>call.method==='_codebuddy.ai/resolveInterruption').length,0);
    const answer={operationId:'explicit-question-answer',inputId:'answer-input',sessionRef:session,runRef:run,vendorRequestId:request.payload.vendorRequestId,
      answer:{kind:'form' as const,values:{q_0:'B'}}};
    assert.equal((await f.adapter.answer({...answer,runRef:'foreign-run',operationId:'wrong-answer'}).receipt).status,'rejected');
    assert.equal((await f.adapter.answer(answer).receipt).status,'accepted');
    const sent=f.calls.filter(call=>call.method==='_codebuddy.ai/resolveInterruption');assert.equal(sent.length,1);
    assert.deepEqual(sent[0]!.params,{sessionId:session,toolCallId:'original-q',decision:'allow',answers:{q_0:'B'}});
    send({sessionUpdate:'tool_call',toolCallId:'aliased-permission',rawInput:{command:'synthetic no-op'},_meta:{...meta,'codebuddy.ai/toolName':'Bash'}});
    send({sessionUpdate:'session_info_update',_meta:{...meta,'codebuddy.ai/interruptionRequest':{interruptionId:'native-p',toolCallId:'aliased-permission',
      toolName:'Bash',toolInput:{command:'synthetic no-op'},options:['allow','deny']}}});await tick();
    const permission=events.find(event=>event.eventType==='input.requested'&&event.payload.kind==='permission');assert.ok(permission?.eventType==='input.requested');
    assert.equal(f.calls.filter(call=>call.method==='_codebuddy.ai/resolveInterruption').length,1);
    send({sessionUpdate:'session_info_update',_meta:{...ambiguous,'codebuddy.ai/permissionResolved':true,'codebuddy.ai/toolCallId':'aliased-permission','codebuddy.ai/decision':'deny'}});
    await tick();assert.equal(events.filter(event=>event.eventType==='input.invalidated'&&event.payload.vendorRequestId===permission.payload.vendorRequestId).length,0);
    send({sessionUpdate:'session_info_update',_meta:{...meta,'codebuddy.ai/permissionResolved':true,'codebuddy.ai/toolCallId':'aliased-permission','codebuddy.ai/decision':'deny'}});
    send({sessionUpdate:'tool_call_update',toolCallId:'aliased-permission',status:'cancelled',_meta:meta});await tick();
    assert.equal(events.filter(event=>event.eventType==='input.invalidated'&&event.payload.vendorRequestId===permission.payload.vendorRequestId).length,1);
    assert.equal((await f.adapter.answer({...answer,operationId:'withdrawn-answer',vendorRequestId:permission.payload.vendorRequestId,
      answer:{kind:'permission',decision:'deny',optionCode:'deny'}}).receipt).status,'unknown');
    assert.equal(f.calls.filter(call=>call.method==='_codebuddy.ai/resolveInterruption').length,1);
    assert.equal(events.some(event=>event.eventType==='run.completed'),false);
    f.send({jsonrpc:'2.0',id:started.operationId,result:{stopReason:'end_turn'}});await tick();
    assert.equal(events.filter(event=>event.eventType==='run.completed').length,1);
  }finally{await f.adapter.disconnect('synthetic-instance');}
});
test('typed formatter output retains original scope and its final message never substitutes for prompt completion',async()=>{
  const f=fixture(undefined,'accepted',{executable:'/synthetic/bin/node',entrypoint:'/synthetic/formatter-server.js'},true);
  await f.adapter.connect();const session='synthetic-harness-session',events:HarnessEvent[]=[];f.adapter.subscribe(session,e=>events.push(e));
  try {
    const handle=f.adapter.start({operationId:'typed-start',inputId:'typed-input',sessionRef:session,text:'synthetic',clientRunId:'typed-run'});
    await tick();const prompt=f.calls.find(call=>call.method==='session/prompt')!,run=(prompt.params['_meta'] as Record<string,string>)['codebuddy.ai/conversationRequestId']!;
    const tool={sessionUpdate:'tool_call',toolCallId:'formatted-tool',status:'in_progress',rawInput:{kind:'final',text:'synthetic body'},
      _meta:{'codebuddy.ai/requestId':run,'codebuddy.ai/toolName':'mcp__courier_formatter__courier_format_message'}};
    const send=(sessionId:string,update:unknown)=>f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update}});
    send('foreign-session',tool);send(session,{...tool,_meta:{...tool._meta,'codebuddy.ai/requestId':'foreign-run'}});await tick();
    assert.equal(events.some(e=>e.eventType==='message.started'),false);
    send(session,tool);assert.equal((await handle.receipt).status,'accepted');
    const end={sessionUpdate:'tool_call_update',toolCallId:'formatted-tool',status:'completed',rawOutput:{text:JSON.stringify({schemaVersion:1,kind:'final',text:'synthetic body'})}};
    send(session,{...end,_meta:{'codebuddy.ai/requestId':'foreign-run'}});await tick();assert.equal(events.some(e=>e.eventType==='message.fragment'),false);
    send(session,end);send(session,end);await tick();
    assert.equal(events.filter(e=>e.eventType==='message.fragment').length,1);assert.equal(events.some(e=>e.eventType==='run.completed'),false);
    send(session,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'untyped body'},_meta:{'codebuddy.ai/requestId':run,'codebuddy.ai/messageId':'untyped'}});
    f.send({jsonrpc:'2.0',id:'typed-start',result:{stopReason:'end_turn'}});await tick();
    assert.equal(events.filter(e=>e.eventType==='run.completed').length,1);assert.equal(events.filter(e=>e.eventType==='message.fragment').length,1);
  }finally{await f.adapter.disconnect('synthetic-instance');}
});
test('explicit formatter launch is carried through both creation and original-session resume without permission overrides',async()=>{
  const launch={executable:'/synthetic/bin/node',entrypoint:'/synthetic/formatter-server.js'},f=fixture(undefined,'accepted',launch);
  await f.adapter.connect();
  try {
    await f.adapter.createSession({operationId:'create',courierSessionId:'courier'}).receipt;
    await f.adapter.resumeSession({operationId:'resume',sessionRef:'synthetic-harness-session'}).receipt;
    const calls=f.calls.filter(call=>['session/new','session/load'].includes(call.method));assert.equal(calls.length,2);
    const expected=[{name:'courier_formatter',command:launch.executable,args:[launch.entrypoint],env:[],_meta:{_workbuddyMcpOrigin:'custom',defer_loading:false}}];
    for(const call of calls){assert.deepEqual(call.params['mcpServers'],expected);assert.equal(call.params['permissionMode'],undefined);}
    const probe=await f.adapter.probe('synthetic-instance');
    assert.equal(probe.capabilities.typedVisibleOutput,'unverified');assert.equal(probe.capabilities.messageAssembly,'unverified');
  }finally{await f.adapter.disconnect('synthetic-instance');}
  const plain=fixture();await plain.adapter.connect();
  try{await plain.adapter.createSession({operationId:'plain-create',courierSessionId:'plain'}).receipt;
    assert.deepEqual(plain.calls.find(call=>call.method==='session/new')?.params['mcpServers'],[]);
  }finally{await plain.adapter.disconnect('synthetic-instance');}
});
test('ACP handshake enables native questions without advertising client filesystem or execution capabilities',async()=>{
  const f=fixture();await f.adapter.connect();
  try {
    const initialize=f.calls.find(call=>call.method==='initialize');
    assert.deepEqual(initialize?.params['clientCapabilities'],{
      fs:{readTextFile:false,writeTextFile:false},_meta:{'codebuddy.ai':{question:true}},
    });
    assert.deepEqual(f.calls.map(call=>call.method),['initialize']);
    assert.equal((await f.adapter.probe('synthetic-instance')).capabilities.humanInteraction,'unverified');
  }finally{await f.adapter.disconnect('synthetic-instance');}
});
async function running(toolCallId:string,resolution?:unknown) {
  const f=fixture(resolution);await f.adapter.connect();const events:HarnessEvent[]=[],session='synthetic-harness-session';
  f.adapter.subscribe(session,event=>events.push(event));
  const started=f.adapter.start({operationId:'start',inputId:'input',sessionRef:session,text:'synthetic',clientRunId:'courier-run'});
  await tick();const prompt=f.calls.find(call=>call.method==='session/prompt')!;
  const run=(prompt.params['_meta'] as Record<string,string>)['codebuddy.ai/conversationRequestId']!;
  f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:{sessionUpdate:'tool_call',toolCallId,_meta:{'codebuddy.ai/requestId':run}}}});
  assert.equal((await started.receipt).status,'accepted');
  return {...f,events,session,run};
}
test('vendor mode=history never confirms a new Run or delivers old formatter snapshots as live output',async()=>{
  const f=fixture(undefined,'accepted',{executable:'/synthetic/bin/node',entrypoint:'/synthetic/formatter-server.js'},true);
  const session='synthetic-harness-session',events:HarnessEvent[]=[];await f.adapter.connect();f.adapter.subscribe(session,event=>events.push(event));
  try {
    const started=f.adapter.start({operationId:'history-start',inputId:'history-input',sessionRef:session,text:'synthetic',clientRunId:'history-courier'});
    await tick();const run=(f.calls.find(call=>call.id==='history-start')!.params['_meta'] as Record<string,string>)['codebuddy.ai/conversationRequestId']!;
    const meta={'codebuddy.ai/requestId':run,'codebuddy.ai/conversationRequestId':run,'codebuddy.ai/messageRequestId':run};
    for(const placement of ['params','update','content']) {
      const history={'codebuddy.ai':{mode:'history',offset:1}},id=`history-${placement}`;
      const update={sessionUpdate:'tool_call',toolCallId:id,rawInput:{kind:'final',text:'PRIVATE_OLD_BODY'},
        _meta:{...meta,'codebuddy.ai/toolName':'mcp__courier_formatter__courier_format_message',...(placement==='update'?history:{})},
        ...(placement==='content'?{content:{type:'text',text:'',_meta:history}}:{})};
      f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update,...(placement==='params'?{_meta:history}:{})}});
      f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,_meta:history,update:{sessionUpdate:'tool_call_update',toolCallId:id,status:'completed',
        rawOutput:{text:JSON.stringify({schemaVersion:1,kind:'final',text:'PRIVATE_OLD_BODY'})},_meta:meta}}});
    }
    await tick();assert.equal(events.some(event=>event.eventType==='run.started'||event.eventType==='message.started'),false);
    f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:{sessionUpdate:'user_message_chunk',_meta:{...meta,'codebuddy.ai':{mode:'ask'}}}}});
    assert.equal((await started.receipt).status,'accepted');
    f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:{sessionUpdate:'tool_call',toolCallId:'live-final',rawInput:{kind:'final',text:'LIVE_BODY'},
      _meta:{...meta,'codebuddy.ai/toolName':'mcp__courier_formatter__courier_format_message'}}}});
    f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:{sessionUpdate:'tool_call_update',toolCallId:'live-final',status:'completed',
      rawOutput:{text:JSON.stringify({schemaVersion:1,kind:'final',text:'LIVE_BODY'})},_meta:meta}}});
    f.send({jsonrpc:'2.0',id:'history-start',result:{stopReason:'end_turn'}});await tick();
    assert.deepEqual(events.filter(event=>event.eventType==='message.fragment').map(event=>event.payload.text),['LIVE_BODY']);
    assert.equal(events.filter(event=>event.eventType==='run.completed').length,1);
  }finally{await f.adapter.disconnect('synthetic-instance');}
});

test('history-mode controls cannot create or withdraw human requests or advance steer ownership',async()=>{
  const f=await running('live-permission-tool');
  try {
    const history={'codebuddy.ai':{mode:'history',offset:4}},base={'codebuddy.ai/requestId':f.run};
    const send=(update:unknown,meta?:unknown)=>f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update,...(meta?{_meta:meta}:{})}});
    send({sessionUpdate:'session_info_update',_meta:{...base,'codebuddy.ai/interruptionRequest':{interruptionId:'live-request',toolCallId:'live-permission-tool',
      toolName:'Bash',toolInput:{command:'synthetic'},options:['allow','deny']}}});await tick();
    const request=f.events.find(event=>event.eventType==='input.requested');assert.ok(request?.eventType==='input.requested');
    send({sessionUpdate:'session_info_update',_meta:{...base,'codebuddy.ai/permissionResolved':true,'codebuddy.ai/toolCallId':'live-permission-tool'}},history);
    send({sessionUpdate:'tool_call',toolCallId:'history-question',rawInput:{questions:[{question:'Private old question',options:[{label:'A'},{label:'B'}]}]},
      _meta:{...base,...history,'codebuddy.ai/toolName':'AskUserQuestion'}});
    f.send({jsonrpc:'2.0',id:'history-question-rpc',method:'session/request_permission',params:{sessionId:f.session,_meta:history,
      toolCall:{toolCallId:'history-question',rawInput:{questions:[{question:'Private old question',options:[{label:'A'},{label:'B'}]}]},_meta:{'codebuddy.ai/toolName':'AskUserQuestion'}},
      options:[{optionId:'allow',kind:'allow_once',name:'Allow'}]}});
    const input={operationId:'live-history-steer',inputId:'live-history-extra',sessionRef:f.session,expectedRunRef:f.run,text:'live change'};
    await f.adapter.steer(input).receipt;const command=f.calls.find(call=>call.id===input.operationId)!;
    const echo={sessionUpdate:'user_message_chunk',messageId:input.inputId,content:{type:'text',text:input.text},_meta:{
      'codebuddy.ai/conversationRequestId':f.run,'codebuddy.ai/requestId':'history-next','codebuddy.ai/messageRequestId':input.inputId,
      'codebuddy.ai/messageId':input.inputId,'codebuddy.ai/steerClientMeta':command.params['_meta']}};
    send(echo,history);await tick();
    assert.equal(f.events.filter(event=>event.eventType==='input.requested').length,1);
    assert.equal(f.events.some(event=>event.eventType==='input.invalidated'||event.eventType==='input.applied'),false);
    await f.adapter.steer({...input,operationId:'after-history',inputId:'after-history-input'}).receipt;
    assert.equal(f.calls.find(call=>call.id==='after-history')!.params['expectedRequestId'],f.run);
    assert.equal((await f.adapter.answer({operationId:'live-denial',inputId:'live-denial-input',sessionRef:f.session,runRef:f.run,
      vendorRequestId:request.payload.vendorRequestId,answer:{kind:'permission',optionCode:'deny',decision:'deny'}}).receipt).status,'accepted');
    send(echo);await tick();assert.equal(f.events.filter(event=>event.eventType==='input.applied').length,1);
    assert.equal(f.calls.filter(call=>call.method==='_codebuddy.ai/resolveInterruption').length,1);
  }finally{await f.adapter.disconnect('synthetic-instance');}
});
test('ACP adapter preserves original Harness session, early Run receipt, steer correlation and explicit completion',async()=>{
  const f=fixture();await f.adapter.connect();const events:HarnessEvent[]=[];
  try {
    const created=await f.adapter.createSession({operationId:'create',courierSessionId:'courier'}).receipt;
    assert.equal(created.status,'accepted');
    f.adapter.subscribe('synthetic-harness-session',event=>events.push(event));
    const handle=f.adapter.start({operationId:'start',inputId:'input',sessionRef:'synthetic-harness-session',text:'hello',clientRunId:'courier-run'});
    await tick();const prompt=f.calls.find(call=>call.method==='session/prompt')!;
    const run=(prompt.params['_meta'] as Record<string,string>)['codebuddy.ai/conversationRequestId']!;
    f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'synthetic-harness-session',update:{sessionUpdate:'user_message_chunk',content:{type:'text',text:'hello'},_meta:{'codebuddy.ai/requestId':run}}}});
    const receipt=await handle.receipt;assert.equal(receipt.status,'accepted');
    assert.equal(events.filter(event=>event.eventType==='run.completed').length,0);
    const steering=await f.adapter.steer({operationId:'steer',inputId:'extra',sessionRef:'synthetic-harness-session',text:'change',expectedRunRef:run}).receipt;
    assert.equal(steering.status,'accepted');
    const sent=f.calls.find(call=>call.method==='session/steer')!;
    assert.equal(sent.params['clientUserMessageId'],'extra');assert.equal(sent.params['expectedRequestId'],run);
    for(const text of ['same','same'])f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'synthetic-harness-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text},_meta:{'codebuddy.ai/requestId':run,'codebuddy.ai/messageId':'message'}}}});
    f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'synthetic-harness-session',update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'private thought'},_meta:{'codebuddy.ai/requestId':run}}}});
    f.send({jsonrpc:'2.0',id:'start',result:{stopReason:'end_turn'}});await tick();
    assert.equal(events.filter(event=>event.eventType==='message.fragment').length,2);
    assert.equal(events.filter(event=>event.eventType==='run.completed').length,1);
    assert.equal(JSON.stringify(events).includes('private thought'),false);
    assert.equal(events.some(event=>event.eventType==='message.started'&&event.payload.kind==='final'),false);
    assert.deepEqual(await f.adapter.inspect({operationId:'unknown'}),{status:'unsupported'});
    const report=await f.adapter.probe('synthetic-instance');assert.equal(report.capabilities.typedVisibleOutput,'unverified');
  }finally{await f.adapter.disconnect('synthetic-instance');}
});
test('ACP HTTP 202 and closed stream never imply receipt acceptance or Run completion, and no command is retried',async()=>{
  const f=fixture();await f.adapter.connect();const events:HarnessEvent[]=[];
  f.adapter.subscribe('synthetic-harness-session',event=>events.push(event));
  const handle=f.adapter.start({operationId:'start',inputId:'input',sessionRef:'synthetic-harness-session',text:'hello',clientRunId:'courier-run'});
  await tick();await f.adapter.disconnect('synthetic-instance');
  assert.equal((await handle.receipt).status,'unknown');
  assert.equal(f.calls.filter(call=>call.method==='session/prompt').length,1);
  assert.equal(events.some(event=>event.eventType==='run.completed'),false);
});

test('a new-session response cannot overwrite an existing Courier mapping when the Harness reuses its session identifier',async()=>{
  const f=fixture();await f.adapter.connect();
  try {
    const first=await f.adapter.createSession({operationId:'create-first',courierSessionId:'courier-first'}).receipt;
    assert.equal(first.status,'accepted');
    const before=structuredClone(f.data.get('session:synthetic-harness-session'));
    const second=await f.adapter.createSession({operationId:'create-other',courierSessionId:'courier-other'}).receipt;
    assert.equal(second.status,'unknown');assert.equal(second.errorCode,'protocol_conflict');
    assert.deepEqual(f.data.get('session:synthetic-harness-session'),before);
    assert.equal(f.calls.filter(call=>call.method==='session/new').length,2);
    assert.equal(f.calls.some(call=>call.method==='session/load'||call.method==='session/prompt'),false);
  }finally{await f.adapter.disconnect('synthetic-instance');}
  const restored=fixture();await restored.adapter.connect();
  try {
    assert.equal((await restored.adapter.resumeSession({operationId:'restore-known',sessionRef:'synthetic-harness-session'}).receipt).status,'accepted');
    const before=structuredClone(restored.data.get('session:synthetic-harness-session'));
    const created=await restored.adapter.createSession({operationId:'new-after-restore',courierSessionId:'different-courier'}).receipt;
    assert.equal(created.status,'unknown');assert.equal(created.errorCode,'protocol_conflict');
    assert.deepEqual(restored.data.get('session:synthetic-harness-session'),before);
    assert.equal(restored.calls.filter(call=>call.method==='session/new').length,1);
    assert.equal(restored.calls.filter(call=>call.method==='session/load').length,1);
    assert.equal(restored.calls.some(call=>call.method==='session/prompt'),false);
  }finally{await restored.adapter.disconnect('synthetic-instance');}
});
test('permissions require an explicit matching scope, preserve the original RPC identity and never infer answer acceptance',async()=>{
  const f=fixture();await f.adapter.connect();const events:HarnessEvent[]=[];
  try {
    f.adapter.subscribe('synthetic-harness-session',event=>events.push(event));
    const started=f.adapter.start({operationId:'start',inputId:'input',sessionRef:'synthetic-harness-session',text:'hello',clientRunId:'courier-run'});
    await tick();const prompt=f.calls.find(call=>call.method==='session/prompt')!;
    const run=(prompt.params['_meta'] as Record<string,string>)['codebuddy.ai/conversationRequestId']!;
    f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'synthetic-harness-session',update:{sessionUpdate:'user_message_chunk',_meta:{'codebuddy.ai/requestId':run}}}});
    await started.receipt;
    f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'synthetic-harness-session',update:{sessionUpdate:'tool_call',toolCallId:'tool',_meta:{'codebuddy.ai/requestId':run}}}});
    f.send({jsonrpc:'2.0',id:47,method:'session/request_permission',params:{sessionId:'synthetic-harness-session',
      toolCall:{toolCallId:'tool',title:'Synthetic permission'},options:[{optionId:'once',name:'Once',kind:'allow_once'},
        {optionId:'always',name:'Always',kind:'allow_always'},{optionId:'reject',name:'Reject',kind:'reject_once'}]}});
    await tick();const requested=events.find(event=>event.eventType==='input.requested');assert.ok(requested?.eventType==='input.requested');
    const base={sessionRef:'synthetic-harness-session',runRef:run,vendorRequestId:requested.payload.vendorRequestId,inputId:'answer'};
    const before=f.calls.length;
    assert.equal((await f.adapter.answer({...base,operationId:'wrong-scope',answer:{kind:'permission',decision:'approve'}}).receipt).status,'rejected');
    assert.equal((await f.adapter.answer({...base,sessionRef:'other',operationId:'wrong-target',answer:{kind:'permission',decision:'deny',optionCode:'reject'}}).receipt).status,'rejected');
    assert.equal(f.calls.length,before);
    assert.equal((await f.adapter.answer({...base,operationId:'answer',answer:{kind:'permission',decision:'deny',optionCode:'reject'}}).receipt).status,'unknown');
    const answer=f.calls[f.calls.length-1]!;assert.equal(answer.id,47);assert.deepEqual((answer as unknown as {result:unknown}).result,{outcome:{outcome:'selected',optionId:'reject'}});
    await f.adapter.answer({...base,operationId:'repeated',answer:{kind:'permission',decision:'approve',optionCode:'always'}}).receipt;
    assert.equal(f.calls.length,before+1);
    f.send({jsonrpc:'2.0',id:'start',result:{stopReason:'end_turn'}});await tick();
  }finally{await f.adapter.disconnect('synthetic-instance');}
});
test('RPC errors only prove rejection for known pre-execution failures; opaque errors remain unknown',()=>{
  assert.deepEqual(rejectedReceipt(new RpcFailure({data:{code:'writer_occupied'}})),{status:'rejected',errorCode:'writer_occupied',definitelyNotAccepted:true});
  assert.deepEqual(rejectedReceipt(new RpcFailure({code:-32000,message:'Persistent Session already has an external writer',data:{reason:'writer_occupied'}})),
    {status:'rejected',errorCode:'writer_occupied',definitelyNotAccepted:true});
  for(const message of ['constructor','__proto__','toString'])assert.deepEqual(rejectedReceipt(new RpcFailure({message})),{status:'unknown',errorCode:'state_unknown'});
  assert.equal(rejectedReceipt(new RpcFailure({message:'private unknown error'})).status,'unknown');
  assert.equal(rejectedReceipt(new Error('private connection details')).status,'unknown');
});
test('desktop authentication probes only the normal account API and rejects a non-loopback debug target',async()=>{
  const request=(async()=>Response.json([{type:'page',webSocketDebuggerUrl:'ws://127.0.0.1:1/devtools/page/synthetic'}])) as typeof fetch;
  class Socket {
    onopen:(()=>void)|undefined;onerror:(()=>void)|undefined;onclose:(()=>void)|undefined;onmessage:((event:{data:string})=>void)|undefined;
    constructor(){queueMicrotask(()=>this.onopen?.());}
    send(body:string){assert.match(body,/auth:getAccount/);assert.equal(/getToken|localStorage|cookie/i.test(body),false);
      queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({id:1,result:{result:{value:{authenticated:true,productVersion:'5.6.2'}}}})}));}
    close(){}
  }
  assert.equal(await desktopAuthenticated('http://127.0.0.1:1',request,Socket as unknown as typeof WebSocket),true);
  assert.equal(await desktopAuthenticated('http://example.invalid',(async()=>{assert.fail('network prohibited');}) as typeof fetch),undefined);
  assert.equal(await desktopAuthenticated('http://127.0.0.1:1',(async()=>Response.json([{type:'page',webSocketDebuggerUrl:'ws://example.invalid/devtools/page/synthetic'}])) as typeof fetch),undefined);
});
test('native AskUserQuestion is an explicit form request, while arbitrary tool input never becomes a question',()=>{
  const params={sessionId:'s',toolCall:{toolCallId:'ask-1',rawInput:{questions:[{question:'Synthetic choice?',options:[{label:'A'},{label:'B'}]}]},
    _meta:{'codebuddy.ai/toolName':'AskUserQuestion'}},options:[{kind:'allow_once',optionId:'allow',name:'Allow'},{kind:'reject_once',optionId:'reject',name:'Reject'}]};
  const native=interaction({jsonrpc:'2.0',id:1,method:'session/request_permission',params},'s','r','epoch');
  assert.equal(native?.kind,'question');
  assert.deepEqual(native?.answerSchema,{mode:'form',fields:[{fieldId:'q_0',label:'Synthetic choice?',required:true,valueType:'choice',options:[{code:'A',label:'A'},{code:'B',label:'B'}]}]});
  const executable=interaction({jsonrpc:'2.0',id:2,method:'session/request_permission',params:{...params,toolCall:{...params.toolCall,_meta:{'codebuddy.ai/toolName':'Bash'}}}},'s','r','epoch');
  assert.equal(executable?.kind,'permission');
});
test('native broadcast interruption preserves original scope and refuses member requests',()=>{
  const data={interruptionId:'ir-1',toolCallId:'tool-1',toolName:'Bash',toolTitle:'Synthetic command',toolInput:{command:'echo synthetic'},options:['allow','allowAll','deny']};
  const request={jsonrpc:'2.0' as const,method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'session_info_update',_meta:{'codebuddy.ai/interruptionRequest':data}}}};
  const mapped=interaction(request,'s','r','epoch');assert.equal(mapped?.kind,'permission');
  assert.deepEqual(mapped?.options?.map(option=>[option.code,option.decision]),[['allow','approve'],['allowAll','approve'],['deny','deny']]);
  assert.equal(interaction({...request,params:{...request.params,update:{...request.params.update,_meta:{'codebuddy.ai/interruptionRequest':{...data,isSubAgent:true}}}}},'s','r','epoch'),undefined);
});
test('explicit native question answer uses the original interruption and requires a positive non-queued receipt',async()=>{
  const f=await running('ask-1');
  try {
    const params={sessionId:f.session,toolCall:{toolCallId:'ask-1',rawInput:{questions:[{question:'Synthetic choice?',options:[{label:'A'},{label:'B'}]}]},
      _meta:{'codebuddy.ai/toolName':'AskUserQuestion'}},options:[{kind:'allow_once',optionId:'allow',name:'Allow'},{kind:'reject_once',optionId:'reject',name:'Reject'}]};
    f.send({jsonrpc:'2.0',id:44,method:'session/request_permission',params});await tick();
    const requested=f.events.find(event=>event.eventType==='input.requested');assert.ok(requested?.eventType==='input.requested');
    assert.equal(requested.payload.kind,'question');assert.equal(f.calls.some(call=>call.method==='_codebuddy.ai/resolveInterruption'),false);
    const base={sessionRef:f.session,runRef:f.run,vendorRequestId:requested.payload.vendorRequestId,inputId:'answer'};
    assert.equal((await f.adapter.answer({...base,operationId:'bad-answer',answer:{kind:'form',values:{q_0:'unoffered'}}}).receipt).status,'rejected');
    const input={...base,operationId:'answer',answer:{kind:'form' as const,values:{q_0:'A'}}};
    const first=f.adapter.answer(input),duplicate=f.adapter.answer(input);assert.equal(first.receipt,duplicate.receipt);
    const result=await first.receipt;assert.equal(result.status,'accepted');
    assert.deepEqual(f.calls.find(call=>call.method==='_codebuddy.ai/resolveInterruption')?.params,{sessionId:f.session,toolCallId:'ask-1',decision:'allow',answers:{q_0:'A'}});
    assert.equal(f.calls.filter(call=>call.method==='_codebuddy.ai/resolveInterruption').length,1);
    assert.equal(f.events.filter(event=>event.eventType==='input.accepted').length,1);
    await f.adapter.answer({...base,operationId:'another-answer',answer:{kind:'form',values:{q_0:'B'}}}).receipt;
    assert.equal(f.calls.filter(call=>call.method==='_codebuddy.ai/resolveInterruption').length,1);
  }finally{await f.adapter.disconnect('synthetic-instance');}
});
test('unknown native answer never falls back to another channel or repeats the decision',async()=>{
  const f=await running('tool-1',{resolved:false,queued:true});
  try {
    f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update:{sessionUpdate:'session_info_update',_meta:{'codebuddy.ai/interruptionRequest':{
      interruptionId:'ir-1',toolCallId:'tool-1',toolName:'Bash',toolInput:{command:'echo synthetic'},options:['allow','deny']}}}}});await tick();
    const requested=f.events.find(event=>event.eventType==='input.requested');assert.ok(requested?.eventType==='input.requested');
    const input={operationId:'answer',inputId:'input-answer',sessionRef:f.session,runRef:f.run,vendorRequestId:requested.payload.vendorRequestId,
      answer:{kind:'permission' as const,decision:'deny' as const,optionCode:'deny'}};
    assert.equal((await f.adapter.answer(input).receipt).status,'unknown');
    assert.equal((await f.adapter.answer({...input,operationId:'again'}).receipt).status,'unknown');
    assert.equal(f.calls.filter(call=>call.method==='_codebuddy.ai/resolveInterruption').length,1);
    assert.equal(f.events.some(event=>event.eventType==='input.accepted'),false);
  }finally{await f.adapter.disconnect('synthetic-instance');}
});
test('broadcast and standard permission routes share one request without expanding the visible grant scope',async()=>{
  const f=await running('tool-1');
  try {
    f.send({jsonrpc:'2.0',id:47,method:'session/request_permission',params:{sessionId:f.session,toolCall:{toolCallId:'tool-1',rawInput:{command:'echo synthetic'},_meta:{'codebuddy.ai/toolName':'Bash'}},
      options:[{kind:'allow_once',optionId:'allow',name:'Once'},{kind:'reject_once',optionId:'reject',name:'Reject'}]}});
    f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update:{sessionUpdate:'session_info_update',_meta:{'codebuddy.ai/interruptionRequest':{
      interruptionId:'ir-1',toolCallId:'tool-1',toolName:'Bash',toolInput:{command:'echo synthetic'},options:['allow','allowAll','deny']}}}}});await tick();
    const requests=f.events.filter(event=>event.eventType==='input.requested');assert.equal(requests.length,1);
    const requested=requests[0]!;assert.equal(requested.eventType,'input.requested');
    const base={inputId:'answer',sessionRef:f.session,runRef:f.run,vendorRequestId:requested.payload.vendorRequestId};
    assert.equal((await f.adapter.answer({...base,operationId:'broader',answer:{kind:'permission',decision:'approve',optionCode:'allowAll'}}).receipt).status,'rejected');
    assert.equal((await f.adapter.answer({...base,operationId:'once',answer:{kind:'permission',decision:'approve',optionCode:'allow'}}).receipt).status,'accepted');
    assert.equal(f.calls.filter(call=>call.method==='_codebuddy.ai/resolveInterruption').length,1);
    assert.equal(f.calls.find(call=>call.method==='_codebuddy.ai/resolveInterruption')?.params['decision'],'allow');
  }finally{await f.adapter.disconnect('synthetic-instance');}
});
test('conflicting native payload invalidates the original request and blocks later decisions',async()=>{
  const f=await running('tool-1');
  try {
    const send=(command:string)=>f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update:{sessionUpdate:'session_info_update',_meta:{'codebuddy.ai/interruptionRequest':{
      interruptionId:'ir-1',toolCallId:'tool-1',toolName:'Bash',toolInput:{command},options:['allow','deny']}}}}});
    send('echo original');await tick();const requested=f.events.find(event=>event.eventType==='input.requested');assert.ok(requested?.eventType==='input.requested');
    send('echo changed');await tick();
    assert.equal(f.events.filter(event=>event.eventType==='input.requested').length,1);
    assert.equal(f.events.some(event=>event.eventType==='input.invalidated'),true);
    assert.equal((await f.adapter.answer({operationId:'answer',inputId:'answer',sessionRef:f.session,runRef:f.run,vendorRequestId:requested.payload.vendorRequestId,
      answer:{kind:'permission',decision:'approve',optionCode:'allow'}}).receipt).status,'unknown');
    assert.equal((await f.adapter.steer({operationId:'steer',inputId:'extra',sessionRef:f.session,expectedRunRef:f.run,text:'continue'}).receipt).status,'unknown');
    assert.equal(f.calls.some(call=>call.method==='_codebuddy.ai/resolveInterruption'||call.method==='session/steer'),false);
  }finally{await f.adapter.disconnect('synthetic-instance');}
});
test('permission without an original correlated tool never borrows the active Run or exposes its body',async()=>{
  const f=await running('owned-tool');
  try {
    f.send({jsonrpc:'2.0',id:88,method:'session/request_permission',params:{sessionId:f.session,toolCall:{toolCallId:'foreign-tool',title:'unrelated-synthetic-body'},
      options:[{kind:'allow_once',optionId:'allow',name:'Allow'}]}});await tick();
    assert.equal(f.events.some(event=>event.eventType==='input.requested'),false);
    assert.equal(JSON.stringify(f.events).includes('unrelated-synthetic-body'),false);
    assert.equal(f.events.some(event=>event.eventType==='message.started'&&event.payload.kind==='error'),true);
  }finally{await f.adapter.disconnect('synthetic-instance');}
});
test('another client resolving the same permission withdraws the request without confirming this operation',async()=>{
  const f=await running('tool-1');
  try {
    f.send({jsonrpc:'2.0',id:47,method:'session/request_permission',params:{sessionId:f.session,toolCall:{toolCallId:'tool-1'},
      options:[{kind:'reject_once',optionId:'reject',name:'Reject'}]}});await tick();
    const request=f.events.find(event=>event.eventType==='input.requested');assert.ok(request?.eventType==='input.requested');
    const input={operationId:'answer',inputId:'answer',sessionRef:f.session,runRef:f.run,vendorRequestId:request.payload.vendorRequestId,
      answer:{kind:'permission' as const,decision:'deny' as const,optionCode:'reject'}};
    assert.equal((await f.adapter.answer(input).receipt).status,'unknown');
    f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update:{sessionUpdate:'session_info_update',_meta:{
      'codebuddy.ai/permissionResolved':true,'codebuddy.ai/toolCallId':'tool-1','codebuddy.ai/decision':'deny'}}}});await tick();
    assert.equal(f.events.some(event=>event.eventType==='input.invalidated'),true);
    assert.equal(f.events.some(event=>event.eventType==='input.accepted'),false);
    const posts=f.calls.length;await f.adapter.answer({...input,operationId:'retry'}).receipt;assert.equal(f.calls.length,posts);
  }finally{await f.adapter.disconnect('synthetic-instance');}
});
test('cancelled original tools withdraw pending questions and permissions without confirming an answer',async()=>{
  for(const nativeToolName of ['Bash','AskUserQuestion']) {
    const f=await running('owned-tool');
    try {
      f.send({jsonrpc:'2.0',id:71,method:'session/request_permission',params:{sessionId:f.session,
        toolCall:{toolCallId:'owned-tool',rawInput:nativeToolName==='AskUserQuestion'?{questions:[{question:'Synthetic question?',options:[{label:'A'},{label:'B'}]}]}:{command:'echo synthetic'},
          _meta:{'codebuddy.ai/toolName':nativeToolName}},options:[{optionId:'reject',kind:'reject_once',name:'Reject'}]}});await tick();
      const requested=f.events.find(event=>event.eventType==='input.requested');assert.ok(requested?.eventType==='input.requested');
      for(const update of [
        {sessionUpdate:'tool_call_update',toolCallId:'foreign-tool',status:'cancelled'},
        {sessionUpdate:'tool_call_update',toolCallId:'owned-tool',status:'cancelled',_meta:{'codebuddy.ai/requestId':'foreign-run'}},
        {sessionUpdate:'tool_call_update',toolCallId:'owned-tool',status:'cancelled',_meta:{'codebuddy.ai/isTeamMember':true}},
      ])f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update}});
      await tick();assert.equal(f.events.some(event=>event.eventType==='input.invalidated'),false);
      const cancelled={jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update:{sessionUpdate:'tool_call_update',toolCallId:'owned-tool',status:'cancelled',
        _meta:{'codebuddy.ai/toolCancelReason':'permission_denied'}}}};
      f.send(cancelled);f.send(cancelled);await tick();
      const withdrawn=f.events.filter(event=>event.eventType==='input.invalidated');assert.equal(withdrawn.length,1);
      assert.equal(withdrawn[0]!.eventType==='input.invalidated'&&withdrawn[0]!.payload.vendorRequestId,requested.payload.vendorRequestId);
      assert.equal(f.events.some(event=>event.eventType==='input.accepted'),false);
      assert.equal(f.calls.some(call=>call.method==='_codebuddy.ai/resolveInterruption'),false);
    }finally{await f.adapter.disconnect('synthetic-instance');}
  }
});
test('completed native question is withdrawn, while a permission broadcast alone never answers it',async()=>{
  const f=await running('ask-1');
  try {
    f.send({jsonrpc:'2.0',id:44,method:'session/request_permission',params:{sessionId:f.session,toolCall:{toolCallId:'ask-1',rawInput:{questions:[{question:'Synthetic?',options:[{label:'A'}]}]},
      _meta:{'codebuddy.ai/toolName':'AskUserQuestion'}},options:[{kind:'allow_once',optionId:'allow',name:'Allow'}]}});await tick();
    const request=f.events.find(event=>event.eventType==='input.requested');assert.ok(request?.eventType==='input.requested');
    f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update:{sessionUpdate:'session_info_update',_meta:{
      'codebuddy.ai/permissionResolved':true,'codebuddy.ai/toolCallId':'ask-1','codebuddy.ai/decision':'allow'}}}});await tick();
    assert.equal(f.events.some(event=>event.eventType==='input.invalidated'||event.eventType==='input.accepted'),false);
    f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update:{sessionUpdate:'tool_call_update',toolCallId:'ask-1',status:'completed',_meta:{'codebuddy.ai/requestId':f.run}}}});await tick();
    assert.equal(f.events.some(event=>event.eventType==='input.invalidated'),true);
    assert.equal((await f.adapter.answer({operationId:'late',inputId:'late',sessionRef:f.session,runRef:f.run,vendorRequestId:request.payload.vendorRequestId,
      answer:{kind:'form',values:{q_0:'A'}}}).receipt).status,'unknown');
    assert.equal(f.calls.some(call=>call.method==='_codebuddy.ai/resolveInterruption'),false);
  }finally{await f.adapter.disconnect('synthetic-instance');}
});
test('unidentifiable visible output produces one explicit limitation without forwarding its body or ending the Run',async()=>{
  const f=await running('tool-1');
  try {
    for(let i=0;i<2;i++)f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update:{sessionUpdate:'agent_message_chunk',
      content:{type:'text',text:'unidentified-synthetic-private-body'},_meta:{'codebuddy.ai/requestId':f.run}}}});
    await tick();
    assert.equal(JSON.stringify(f.events).includes('unidentified-synthetic-private-body'),false);
    assert.equal(f.events.filter(event=>event.eventType==='message.started'&&event.payload.kind==='error').length,1);
    assert.equal(f.events.some(event=>event.eventType==='run.completed'),false);
  }finally{await f.adapter.disconnect('synthetic-instance');}
});

test('unsupported human request shapes report a safe blockage without exposing their body or approving them',async()=>{
  const f=await running('owned-tool');
  try {
    f.send({jsonrpc:'2.0',id:90,method:'_codebuddy.ai/question',params:{sessionId:f.session,toolCallId:'owned-tool',
      questions:[{id:'field',question:'synthetic-private-child-question'}],_meta:{'codebuddy.ai/isSubAgent':true}}});
    await tick();assert.equal(f.events.some(event=>event.eventType==='input.requested'),false);
    const send=(member:boolean)=>f.send({jsonrpc:'2.0',id:92,method:'session/request_permission',params:{sessionId:f.session,
      toolCall:{toolCallId:'owned-tool',title:'synthetic-private-unsupported-question',rawInput:{questions:[{question:'synthetic-private-unsupported-question',options:[{label:'duplicate'},{label:'duplicate'}]}]},
        _meta:{'codebuddy.ai/toolName':'AskUserQuestion',...(member?{'codebuddy.ai/isTeamMember':true}:{})}},options:[{optionId:'allow',kind:'allow_once',name:'Allow'}]}});
    send(true);await tick();assert.equal(f.events.some(event=>event.eventType==='message.started'),false);
    send(false);send(false);await tick();
    assert.equal(f.events.filter(event=>event.eventType==='message.started'&&event.payload.kind==='error').length,1);
    assert.equal(JSON.stringify(f.events).includes('synthetic-private-unsupported-question'),false);
    assert.equal(f.events.some(event=>event.eventType==='input.requested'||event.eventType==='run.completed'),false);
    assert.equal(f.calls.some(call=>call.method==='_codebuddy.ai/resolveInterruption'||!call.method),false);
  }finally{await f.adapter.disconnect('synthetic-instance');}
});

test('human requests arriving before the correlated tool wait for their original Run before display or blockage',async()=>{
  for(const supported of [true,false]) {
    const f=fixture();await f.adapter.connect();const events:HarnessEvent[]=[],session='synthetic-harness-session';
    f.adapter.subscribe(session,event=>events.push(event));
    try {
      const start=f.adapter.start({operationId:'start-before-tool',inputId:'input-before-tool',sessionRef:session,text:'synthetic',clientRunId:'courier-run'});
      await tick();const prompt=f.calls.find(call=>call.method==='session/prompt')!;
      const run=(prompt.params['_meta'] as Record<string,string>)['codebuddy.ai/conversationRequestId']!;
      f.send({jsonrpc:'2.0',id:91,method:'session/request_permission',params:{sessionId:session,
        toolCall:{toolCallId:'late-owned-tool',_meta:{'codebuddy.ai/toolName':'AskUserQuestion'},rawInput:{questions:[{
          question:'synthetic question before tool',options:supported?[{label:'A'},{label:'B'}]:[{label:'same'},{label:'same'}]}]}},
        options:[{optionId:'allow',kind:'allow_once',name:'Allow'}]}});await tick();
      assert.equal(events.length,0);
      f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:{sessionUpdate:'tool_call',toolCallId:'late-owned-tool',_meta:{'codebuddy.ai/requestId':run}}}});
      assert.equal((await start.receipt).status,'accepted');await tick();
      assert.equal(events.filter(event=>event.eventType==='input.requested').length,supported?1:0);
      assert.equal(events.filter(event=>event.eventType==='message.started'&&event.payload.kind==='error').length,supported?0:1);
      assert.equal(events[0]!.eventType,'run.started');
      assert.equal(f.calls.some(call=>call.method==='_codebuddy.ai/resolveInterruption'||!call.method),false);
    }finally{await f.adapter.disconnect('synthetic-instance');}
  }
});

test('permission scopes without a native equivalent retain their original RPC route after a broadcast',async()=>{
  const f=await running('owned-tool');
  try {
    f.send({jsonrpc:'2.0',id:96,method:'session/request_permission',params:{sessionId:f.session,
      toolCall:{toolCallId:'owned-tool',rawInput:{command:'synthetic'},_meta:{'codebuddy.ai/toolName':'Bash'}},
      options:[{optionId:'deny-always',kind:'reject_always',name:'Reject future matching requests'}]}});
    f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update:{sessionUpdate:'session_info_update',_meta:{'codebuddy.ai/interruptionRequest':{
      interruptionId:'ir-scope',toolCallId:'owned-tool',toolName:'Bash',toolInput:{command:'synthetic'},options:['allow','deny']}}}}});await tick();
    const request=f.events.find(event=>event.eventType==='input.requested');assert.ok(request?.eventType==='input.requested');
    assert.equal((await f.adapter.answer({operationId:'scope-answer',inputId:'scope-input',sessionRef:f.session,runRef:f.run,
      vendorRequestId:request.payload.vendorRequestId,answer:{kind:'permission',decision:'deny',optionCode:'deny-always'}}).receipt).status,'unknown');
    assert.equal(f.calls.some(call=>call.method==='_codebuddy.ai/resolveInterruption'),false);
    const reply=f.calls.find(call=>call.id===96);
    assert.deepEqual(reply?.result,{outcome:{outcome:'selected',optionId:'deny-always'}});
  }finally{await f.adapter.disconnect('synthetic-instance');}
});

test('steer acceptance is separate from consumption, and only the original injected echo proves applied once',async()=>{
  const f=await running('owned-tool');
  try {
    const input={operationId:'steer-consumed',inputId:'extra-consumed',sessionRef:f.session,expectedRunRef:f.run,text:'synthetic change'};
    const handle=f.adapter.steer(input);assert.equal((await handle.receipt).status,'accepted');
    assert.equal(f.events.some(event=>event.eventType==='input.applied'),false);
    const command=f.calls.find(call=>call.method==='session/steer')!;
    assert.ok(command.params['_meta']);
    const echo=(run=f.run,message=input.inputId,meta=command.params['_meta'])=>({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,
      update:{sessionUpdate:'user_message_chunk',messageId:message,content:{type:'text',text:input.text},_meta:{'codebuddy.ai/requestId':run,
        'codebuddy.ai/messageId':message,'codebuddy.ai/steerClientMeta':meta}}}});
    f.send(echo('different-run'));f.send(echo(f.run,'foreign-input'));f.send(echo(f.run,input.inputId,{}));await tick();
    assert.equal(f.events.some(event=>event.eventType==='input.applied'),false);
    const hidden=echo();(hidden.params.update._meta as Record<string,unknown>)['codebuddy.ai/historyReplay']=true;
    f.send(hidden);await tick();assert.equal(f.events.some(event=>event.eventType==='input.applied'),false);
    f.send(echo());f.send(echo());await tick();
    const applied=f.events.filter(event=>event.eventType==='input.applied');assert.equal(applied.length,1);
    assert.equal(applied[0]!.eventType,'input.applied');assert.equal(applied[0]!.payload.inputId,input.inputId);
    assert.equal(applied[0]!.runRef,f.run);assert.equal(applied[0]!.sessionRef,f.session);
    assert.equal((f.data.get(`steer:${input.operationId}`) as {status:string}).status,'applied');
    assert.equal(f.calls.filter(call=>call.method==='session/prompt').length,1);
  }finally{await f.adapter.disconnect('synthetic-instance');}
});

test('steer injection proof requires the exact complete input text before adopting its native owner',async()=>{
  const f=await running('owned-tool');
  try {
    const input={operationId:'body-steer',inputId:'body-input',sessionRef:f.session,expectedRunRef:f.run,text:'保留空格  和换行\nsynthetic change'};
    assert.equal((await f.adapter.steer(input).receipt).status,'accepted');
    const command=f.calls.find(call=>call.id===input.operationId)!;
    const echo=(content:unknown)=>({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update:{
      sessionUpdate:'user_message_chunk',messageId:input.inputId,content,_meta:{
        'codebuddy.ai/conversationRequestId':f.run,'codebuddy.ai/requestId':'body-next-owner',
        'codebuddy.ai/messageRequestId':input.inputId,'codebuddy.ai/messageId':input.inputId,'codebuddy.ai/steerClientMeta':command.params['_meta']}}}});
    for(const content of [undefined,{type:'text',text:'保留空格'}, {type:'text',text:input.text.replace('  ',' ')}, {type:'image',text:input.text}])f.send(echo(content));
    await tick();
    assert.equal(f.events.some(event=>event.eventType==='input.applied'),false);
    assert.equal((f.data.get(`steer:${input.operationId}`) as {status:string}).status,'accepted');
    const second={...input,operationId:'before-body-proof',inputId:'before-body-input'};
    await f.adapter.steer(second).receipt;
    assert.equal(f.calls.find(call=>call.id===second.operationId)!.params['expectedRequestId'],f.run);
    f.send(echo({type:'text',text:input.text}));f.send(echo({type:'text',text:input.text}));await tick();
    assert.equal(f.events.filter(event=>event.eventType==='input.applied').length,1);
    await f.adapter.steer({...second,operationId:'after-body-proof',inputId:'after-body-input'}).receipt;
    assert.equal(f.calls.find(call=>call.id==='after-body-proof')!.params['expectedRequestId'],'body-next-owner');
    assert.equal(f.calls.filter(call=>call.method==='session/prompt').length,1);
  }finally{await f.adapter.disconnect('synthetic-instance');}
});

test('a persisted steer intent never redispatches after its in-memory receipt was lost',async()=>{
  const f=await running('owned-tool');
  try {
    const input={operationId:'persisted-steer',inputId:'persisted-extra',sessionRef:f.session,expectedRunRef:f.run,text:'synthetic change'};
    f.data.set(`steer:${input.operationId}`,{input,status:'dispatching'});
    assert.equal((await f.adapter.steer(input).receipt).status,'unknown');
    f.data.set(`steer-input:other-extra`,{operationId:'other-operation'});
    assert.equal((await f.adapter.steer({...input,operationId:'another-steer',inputId:'other-extra'}).receipt).status,'unknown');
    assert.equal(f.calls.some(call=>call.method==='session/steer'),false);
  }finally{await f.adapter.disconnect('synthetic-instance');}
});

test('an injected steer echo arriving after completion stays with the completed Run',async()=>{
  const f=await running('owned-tool');
  try {
    const input={operationId:'last-steer',inputId:'last-extra',sessionRef:f.session,expectedRunRef:f.run,text:'synthetic change'};
    await f.adapter.steer(input).receipt;
    const command=f.calls.find(call=>call.method==='session/steer')!;
    f.send({jsonrpc:'2.0',id:'start',result:{stopReason:'end_turn'}});await tick();
    assert.equal(f.events.filter(event=>event.eventType==='run.completed').length,1);
    const next=f.adapter.start({operationId:'new-start',inputId:'new-input',sessionRef:f.session,text:'synthetic next task',clientRunId:'new-courier-run'});
    await tick();const prompt=f.calls.find(call=>call.method==='session/prompt'&&call.id==='new-start')!;
    const nextRun=(prompt.params['_meta'] as Record<string,string>)['codebuddy.ai/conversationRequestId']!;
    f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update:{sessionUpdate:'user_message_chunk',_meta:{'codebuddy.ai/requestId':nextRun}}}});await next.receipt;
    f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update:{sessionUpdate:'user_message_chunk',messageId:input.inputId,content:{type:'text',text:input.text},
      _meta:{'codebuddy.ai/conversationRequestId':f.run,'codebuddy.ai/requestId':'late-native-owner',
        'codebuddy.ai/messageRequestId':input.inputId,'codebuddy.ai/messageId':input.inputId,'codebuddy.ai/steerClientMeta':command.params['_meta']}}}});await tick();
    f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update:{sessionUpdate:'agent_message_chunk',
      content:{type:'text',text:'LATE_FOREIGN_OUTPUT'},_meta:{'codebuddy.ai/conversationRequestId':'late-native-owner',
        'codebuddy.ai/requestId':'late-native-owner','codebuddy.ai/messageRequestId':f.run,'codebuddy.ai/messageId':'late-output'}}}});
    await f.adapter.steer({operationId:'new-run-steer',inputId:'new-run-extra',sessionRef:f.session,expectedRunRef:nextRun,text:'new change'}).receipt;
    assert.equal(f.calls.find(call=>call.id==='new-run-steer')!.params['expectedRequestId'],nextRun);
    f.send({jsonrpc:'2.0',id:'new-start',result:{stopReason:'end_turn'}});await tick();
    const applied=f.events.filter(event=>event.eventType==='input.applied');assert.equal(applied.length,1);assert.equal(applied[0]!.runRef,f.run);
    assert.equal(f.events.filter(event=>event.eventType==='run.completed').length,2);
    assert.equal(f.events.filter(event=>event.eventType==='run.started').length,2);
    assert.ok(!JSON.stringify(f.events).includes('LATE_FOREIGN_OUTPUT'));
  }finally{await f.adapter.disconnect('synthetic-instance');}
});

test('duplicate steer operations share one dispatch, while reused operation or input identities cannot submit another change',async()=>{
  const f=await running('owned-tool');
  try {
    const input={operationId:'one-steer',inputId:'one-extra',sessionRef:f.session,expectedRunRef:f.run,text:'synthetic change'};
    const first=f.adapter.steer(input),same=f.adapter.steer({...input});assert.equal(first.receipt,same.receipt);
    assert.equal((await first.receipt).status,'accepted');
    const changed=await f.adapter.steer({...input,text:'different change'}).receipt;
    assert.equal(changed.status,'unknown');assert.equal(changed.errorCode,'protocol_conflict');
    assert.equal((await f.adapter.steer({...input,operationId:'new-operation'}).receipt).status,'unknown');
    assert.equal(f.calls.filter(call=>call.method==='session/steer').length,1);
  }finally{await f.adapter.disconnect('synthetic-instance');}
});

test('a late injected steer echo can resolve an unknown receipt without replaying the original command',async()=>{
  const f=fixture(undefined,'timeout');await f.adapter.connect();const events:HarnessEvent[]=[],session='synthetic-harness-session';
  f.adapter.subscribe(session,event=>events.push(event));
  try {
    const start=f.adapter.start({operationId:'start-late',inputId:'start-input',sessionRef:session,text:'synthetic',clientRunId:'courier-run'});
    await tick();const prompt=f.calls.find(call=>call.method==='session/prompt')!;
    const run=(prompt.params['_meta'] as Record<string,string>)['codebuddy.ai/conversationRequestId']!;
    f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:{sessionUpdate:'user_message_chunk',_meta:{'codebuddy.ai/requestId':run}}}});
    await start.receipt;
    const input={operationId:'timed-out-steer',inputId:'late-extra',sessionRef:session,expectedRunRef:run,text:'synthetic change'};
    const handle=f.adapter.steer(input);assert.equal((await handle.receipt).status,'unknown');
    const command=f.calls.find(call=>call.method==='session/steer')!;
    f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:{sessionUpdate:'user_message_chunk',messageId:input.inputId,content:{type:'text',text:input.text},
      _meta:{'codebuddy.ai/requestId':run,'codebuddy.ai/messageId':input.inputId,'codebuddy.ai/steerClientMeta':command.params['_meta']}}}});await tick();
    assert.equal(events.filter(event=>event.eventType==='input.applied').length,1);
    await f.adapter.steer(input).receipt;
    assert.equal(f.calls.filter(call=>call.method==='session/steer').length,1);
    assert.equal((f.data.get(`steer:${input.operationId}`) as {status:string}).status,'applied');
  }finally{await f.adapter.disconnect('synthetic-instance');}
});

test('a verified steer transition keeps visible output in the original Run and targets the next native owner',async()=>{
  const f=await running('owned-tool');
  try {
    const first={operationId:'transition-one',inputId:'transition-input-one',sessionRef:f.session,expectedRunRef:f.run,text:'change one'};
    assert.equal((await f.adapter.steer(first).receipt).status,'accepted');
    const command=f.calls.find(call=>call.id===first.operationId)!;
    const visible=(owner:string,origin:string,id:string,text:string)=>({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,
      update:{sessionUpdate:'agent_message_chunk',messageId:id,content:{type:'text',text},_meta:{
        'codebuddy.ai/conversationRequestId':owner,'codebuddy.ai/requestId':owner,'codebuddy.ai/messageRequestId':origin,'codebuddy.ai/messageId':id}}}});
    f.send(visible('native-next',f.run,'before-proof','UNPROVEN_OUTPUT'));
    const echo={jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update:{sessionUpdate:'user_message_chunk',
      messageId:first.inputId,content:{type:'text',text:first.text},_meta:{'codebuddy.ai/conversationRequestId':f.run,'codebuddy.ai/requestId':'native-next',
        'codebuddy.ai/messageRequestId':first.inputId,'codebuddy.ai/messageId':first.inputId,'codebuddy.ai/steerClientMeta':command.params['_meta']}}}};
    for(const invalid of [
      {'codebuddy.ai/messageRequestId':'foreign-input'},
      {'codebuddy.ai/conversationRequestId':'foreign-owner'},
      {'codebuddy.ai/historyReplay':true},
    ]) {
      const bad=structuredClone(echo);Object.assign(bad.params.update._meta,invalid);f.send(bad);
    }
    await tick();assert.equal(f.events.some(event=>event.eventType==='input.applied'),false);
    f.send(echo);await tick();
    f.send(visible('native-next',f.run,'linked-output','LINKED_OUTPUT'));
    f.send(visible('native-next','foreign-origin','wrong-origin','FOREIGN_OUTPUT'));
    f.send(visible('unproven-owner',f.run,'wrong-owner','FOREIGN_OUTPUT'));
    const second={...first,operationId:'transition-two',inputId:'transition-input-two',text:'change two'};
    assert.equal((await f.adapter.steer(second).receipt).status,'accepted');
    const next=f.calls.find(call=>call.id===second.operationId)!;
    assert.equal(next.params['expectedRequestId'],'native-next');
    assert.equal((next.params['_meta'] as {'agent-courier':{runRef:string}})['agent-courier'].runRef,f.run);
    f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update:{sessionUpdate:'user_message_chunk',messageId:second.inputId,content:{type:'text',text:second.text},
      _meta:{'codebuddy.ai/conversationRequestId':'native-next','codebuddy.ai/requestId':'native-third',
        'codebuddy.ai/messageRequestId':second.inputId,'codebuddy.ai/messageId':second.inputId,'codebuddy.ai/steerClientMeta':next.params['_meta']}}}});
    await tick();f.send(echo);await tick();
    f.send(visible('native-third',f.run,'second-linked-output','SECOND_LINKED_OUTPUT'));
    await f.adapter.steer({...second,operationId:'transition-three',inputId:'transition-input-three'}).receipt;
    assert.equal(f.calls.find(call=>call.id==='transition-three')!.params['expectedRequestId'],'native-third');
    assert.equal((await f.adapter.steer(first).receipt).status,'accepted');
    assert.equal(f.calls.filter(call=>call.id===first.operationId).length,1);
    f.send({jsonrpc:'2.0',id:'start',result:{stopReason:'end_turn'}});await tick();
    const encoded=JSON.stringify(f.events);
    assert.ok(encoded.includes('LINKED_OUTPUT'));assert.ok(encoded.includes('SECOND_LINKED_OUTPUT'));
    assert.ok(!encoded.includes('UNPROVEN_OUTPUT'));assert.ok(!encoded.includes('FOREIGN_OUTPUT'));
    assert.equal(f.events.filter(event=>event.eventType==='run.completed').length,1);
    assert.ok(f.events.every(event=>event.runRef===f.run));
  }finally{await f.adapter.disconnect('synthetic-instance');}
});

test('conflicting steer transitions block later control instead of assigning a new native owner',async()=>{
  const f=await running('owned-tool');
  try {
    const inputs=[1,2].map(i=>({operationId:`fork-${i}`,inputId:`fork-input-${i}`,sessionRef:f.session,expectedRunRef:f.run,text:'change'}));
    for(const input of inputs)assert.equal((await f.adapter.steer(input).receipt).status,'accepted');
    for(let i=0;i<inputs.length;i++) {
      const input=inputs[i]!,command=f.calls.find(call=>call.id===input.operationId)!;
      f.send({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.session,update:{sessionUpdate:'user_message_chunk',messageId:input.inputId,content:{type:'text',text:input.text},
        _meta:{'codebuddy.ai/conversationRequestId':f.run,'codebuddy.ai/requestId':`fork-owner-${i}`,
          'codebuddy.ai/messageRequestId':input.inputId,'codebuddy.ai/messageId':input.inputId,'codebuddy.ai/steerClientMeta':command.params['_meta']}}}});
      await tick();
    }
    const next=await f.adapter.steer({...inputs[0]!,operationId:'after-fork',inputId:'after-fork-input'}).receipt;
    assert.equal(next.status,'unknown');assert.equal(next.errorCode,'protocol_conflict');
    assert.equal(f.calls.filter(call=>call.method==='session/steer').length,2);
    assert.ok(JSON.stringify(f.events).includes('protocol_conflict'));
  }finally{await f.adapter.disconnect('synthetic-instance');}
});
