import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareObservedQuestion } from '../probes/workbuddy-question.js';

function snapshot() {
  return {sessionRef:'synthetic-session',toolCallId:'synthetic-question',
    toolUpdates:[{sessionUpdate:'tool_call',toolCallId:'synthetic-question',_meta:{'codebuddy.ai/requestId':'synthetic-run'}}],
    messages:[{jsonrpc:'2.0',id:17,method:'session/request_permission',params:{sessionId:'synthetic-session',
      toolCall:{toolCallId:'synthetic-question',rawInput:{questions:[{question:'Synthetic choice?',options:[{label:'A'},{label:'B'}]}]},
        _meta:{'codebuddy.ai/toolName':'AskUserQuestion'}},options:[{optionId:'allow',kind:'allow_once',name:'Answer question'}]}}]};
}
test('independent question probe uses production mapping and answer fields only after original tool correlation',()=>{
  const observed=snapshot();assert.deepEqual(prepareObservedQuestion(observed,'B'),{answers:{q_0:'B'},sourceCount:1});
  assert.equal(prepareObservedQuestion({...observed,toolUpdates:[]},'B'),undefined);
  assert.equal(prepareObservedQuestion({...observed,toolCallId:'foreign-tool'},'B'),undefined);
  assert.equal(prepareObservedQuestion({...observed,sessionRef:'foreign-session'},'B'),undefined);
  assert.equal(prepareObservedQuestion(observed,'unoffered-choice'),undefined);
});
test('independent question probe refuses a conflicting owner or executable tool instead of approving it',()=>{
  const observed=snapshot();
  assert.equal(prepareObservedQuestion({...observed,toolUpdates:[...observed.toolUpdates,
    {sessionUpdate:'tool_call',toolCallId:observed.toolCallId,_meta:{'codebuddy.ai/requestId':'other-run'}}]},'A'),undefined);
  const executable=snapshot();executable.messages[0]!.params.toolCall._meta['codebuddy.ai/toolName']='Bash';
  assert.equal(prepareObservedQuestion(executable,'A'),undefined);
  const child=snapshot();Object.assign(child.toolUpdates[0]!._meta,{'codebuddy.ai/isSubAgent':true});
  assert.equal(prepareObservedQuestion(child,'A'),undefined);
});
