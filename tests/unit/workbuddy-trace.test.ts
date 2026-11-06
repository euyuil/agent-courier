import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkBuddyTrace } from '../probes/workbuddy-trace.js';

test('an explicitly larger trace budget remains bounded and rejects invalid or unbounded capacities',()=>{
  const trace=new WorkBuddyTrace('own',{run:'run',input:'input',operation:'operation'},{original:'',changed:''},()=>0,5000);
  for(let index=0;index<3000;index++)trace.mark('run_activity');
  assert.equal(trace.snapshot().rows.length,3000);assert.equal(trace.snapshot().truncated,false);
  for(let index=0;index<2001;index++)trace.mark('run_activity');
  assert.equal(trace.snapshot().rows.length,5000);assert.equal(trace.snapshot().truncated,true);
  for(const capacity of [0,-1,10001,Infinity,NaN,1.5])
    assert.throws(()=>new WorkBuddyTrace('own',{run:'run',input:'input',operation:'operation'},{original:'',changed:''},()=>0,capacity),
      {message:'invalid_trace_limit'});
});

test('the owned protocol trace preserves reference relationships without retaining identifiers, private text or internal thought',()=>{
  let time=100;const owner='PRIVATE_OWNER',run='PRIVATE_RUN',input='PRIVATE_INPUT',operation='PRIVATE_OPERATION';
  const trace=new WorkBuddyTrace(owner,{run,input,operation},{original:'ORIGINAL',changed:'CHANGED'},()=>time++);
  const event=(session:string,kind:string,text:string,meta:Record<string,unknown>)=>({sessionId:session,
    update:{sessionUpdate:kind,content:{type:'text',text},_meta:meta}});
  trace.event('acp',event('foreign','agent_message_chunk','PRIVATE_FOREIGN_TEXT',{'codebuddy.ai/requestId':'FOREIGN_REFERENCE'}));
  const thought=event(owner,'agent_thought_chunk','PRIVATE_THOUGHT_TEXT',{'codebuddy.ai/conversationRequestId':run,
    'codebuddy.ai/authToken':'PRIVATE_AUTH_TOKEN','codebuddy.ai/unknown':{path:'/private/synthetic/profile'}});
  Object.assign(thought.update,{toolCallId:'PRIVATE_TOOL'});trace.event('acp',thought);
  const meta={'codebuddy.ai/conversationRequestId':'PRIVATE_CHANGED_RUN','codebuddy.ai/messageId':'PRIVATE_MESSAGE',
    'codebuddy.ai/messageRequestId':input,'codebuddy.ai/steerClientMeta':{'codebuddy.ai':{queueOrigin:'steer'},
      'agent-courier':{operationId:operation,inputId:input,runRef:run}}};
  trace.event('acp',event(owner,'agent_message_chunk','CHA',meta));trace.event('acp',event(owner,'agent_message_chunk','NGED',meta));
  trace.event('desktop',event(owner,'agent_message_chunk','CHANGED',meta),7);
  trace.mark('task_return_observed',{returned:true,processing:false,resultElapsedMs:50,stopReason:'end_turn'});
  const result=trace.snapshot(),encoded=JSON.stringify(result);
  assert.equal(result.rows.length,5);assert.equal(result.rows[0]!.references['conversationRequestId'],'original-run');
  assert.notEqual(result.rows[1]!.references['conversationRequestId'],'original-run');
  assert.equal(result.rows[1]!.references['steerRun'],'original-run');assert.equal(result.rows[1]!.references['messageRequestId'],'control-input');
  assert.equal(result.rows[2]!.changedMarker,true);assert.equal(result.rows[3]!.references['messageId'],result.rows[2]!.references['messageId']);
  assert.equal(result.rows[0]!.changedMarker,undefined);assert.equal(result.rows[3]!.historyIndex,7);
  for(const privateValue of [owner,run,input,operation,'PRIVATE_CHANGED_RUN','PRIVATE_MESSAGE','PRIVATE_TOOL','PRIVATE_THOUGHT_TEXT','PRIVATE_AUTH_TOKEN',
    'PRIVATE_FOREIGN_TEXT','FOREIGN_REFERENCE','/private/synthetic/profile','CHANGED'])assert.ok(!encoded.includes(privateValue));
  assert.equal(JSON.stringify(trace),'{}');assert.equal(result.truncated,false);
});
