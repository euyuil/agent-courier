import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareObservedDenial } from '../probes/workbuddy-permission.js';

const command='python3 -I -S -c "print(\'synthetic\')"';
function snapshot() {
  const input={command},tool='synthetic-tool',session='synthetic-session';
  return {sessionRef:session,toolCallId:tool,
    toolUpdates:[{sessionUpdate:'tool_call',toolCallId:tool,_meta:{'codebuddy.ai/requestId':'synthetic-run'}}],
    messages:[{jsonrpc:'2.0',id:17,method:'session/request_permission',params:{sessionId:session,
      toolCall:{toolCallId:tool,rawInput:input,_meta:{'codebuddy.ai/toolName':'Bash'}},
      options:[{optionId:'yes',kind:'allow_once',name:'Allow once'},{optionId:'no',kind:'reject_once',name:'Deny once'}]}},
    {jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:{sessionUpdate:'session_info_update',
      _meta:{'codebuddy.ai/interruptionRequest':{interruptionId:'synthetic-interruption',toolCallId:tool,toolName:'Bash',toolInput:input,options:['allow','deny']}}}}}]};
}
test('execution permission observation prepares only an explicit denial of the exact original synthetic command',()=>{
  assert.deepEqual(prepareObservedDenial(snapshot(),command),{decision:'deny',sourceCount:2});
  assert.equal(prepareObservedDenial(snapshot(),'different command'),undefined);
  assert.equal(prepareObservedDenial({...snapshot(),toolUpdates:[]},command),undefined);
  assert.equal(prepareObservedDenial({...snapshot(),sessionRef:'foreign-session'},command),undefined);
  const noDenial=snapshot();noDenial.messages[0]!.params.options=noDenial.messages[0]!.params.options!.filter(item=>item.kind!=='reject_once');
  assert.equal(prepareObservedDenial(noDenial,command),undefined);
});
test('execution denial observation rejects conflicting tools, owners and unmapped reply paths without approval fallback',()=>{
  const original=snapshot();
  assert.equal(prepareObservedDenial({...original,messages:original.messages.slice(0,1)},command),undefined);
  const conflict=snapshot();conflict.toolUpdates.push({sessionUpdate:'tool_call',toolCallId:conflict.toolCallId,_meta:{'codebuddy.ai/requestId':'foreign-run'}});
  assert.equal(prepareObservedDenial(conflict,command),undefined);
  const other=snapshot();other.messages[1]!.params.update!._meta['codebuddy.ai/interruptionRequest'].toolName='OtherTool';
  assert.equal(prepareObservedDenial(other,command),undefined);
});
