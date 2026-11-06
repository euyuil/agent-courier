import test from 'node:test';
import assert from 'node:assert/strict';
import { completedRunReady,unchangedCompletedRun } from '../probes/workbuddy-completed-steer.js';

test('completed-run controls require original normal completion and never treat new work or lost history as unchanged',()=>{
  const snapshot={sessionId:'own',isProcessing:false,returned:true,failed:false,stopReason:'end_turn',pendingQuestions:0,pendingPermissions:0,
    events:[{sessionId:'own',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'synthetic marker'},
      _meta:{'codebuddy.ai/requestId':'original-run','codebuddy.ai/messageId':'original-message'}}}]};
  assert.equal(completedRunReady(snapshot,'own','original-run','synthetic marker'),true);
  assert.equal(unchangedCompletedRun(snapshot,structuredClone(snapshot),'own','original-run','synthetic marker'),true);
  const scoped={...snapshot,events:snapshot.events.map(({sessionId:_,...event})=>event)};
  assert.equal(completedRunReady(scoped,'own','original-run','synthetic marker'),true);
  assert.equal(unchangedCompletedRun(scoped,structuredClone(scoped),'own','original-run','synthetic marker'),true);
  assert.equal(completedRunReady({...scoped,sessionId:'foreign'},'own','original-run','synthetic marker'),false);
  for(const change of [{sessionId:'foreign'},{isProcessing:true},{returned:false},{failed:true},{stopReason:'cancelled'},
    {pendingQuestions:1},{pendingPermissions:1},{events:[]}])
    assert.equal(completedRunReady({...snapshot,...change},'own','original-run','synthetic marker'),false);
  assert.equal(completedRunReady(snapshot,'own','another-run','synthetic marker'),false);
  assert.equal(completedRunReady(snapshot,'own','original-run','absent marker'),false);
  const echo=structuredClone(snapshot);echo.events[0]!.update.sessionUpdate='user_message_chunk';
  assert.equal(completedRunReady(echo,'own','original-run','synthetic marker'),false);
  const foreign=structuredClone(snapshot);foreign.events[0]!.sessionId='foreign';
  assert.equal(completedRunReady(foreign,'own','original-run','synthetic marker'),false);
  const hidden=structuredClone(snapshot);Object.assign(hidden.events[0]!.update._meta,{'codebuddy.ai/isTeamMember':true});
  assert.equal(completedRunReady(hidden,'own','original-run','synthetic marker'),false);
  const tool={sessionId:'own',update:{sessionUpdate:'tool_call',toolCallId:'another-tool'}};
  assert.equal(completedRunReady({...snapshot,events:[...snapshot.events,tool]},'own','original-run','synthetic marker'),false);
  const next=structuredClone(snapshot);next.events.push({...next.events[0]!,update:{...next.events[0]!.update,
    _meta:{'codebuddy.ai/requestId':'new-run','codebuddy.ai/messageId':'new-message'}}});
  assert.equal(unchangedCompletedRun(snapshot,next,'own','original-run','synthetic marker'),false);
  const replaced=structuredClone(snapshot);replaced.events[0]!.update.content.text='synthetic marker and later content';
  assert.equal(unchangedCompletedRun(snapshot,replaced,'own','original-run','synthetic marker'),false);
  const raw={...snapshot,history:[{kind:'desktop_projection'}]};
  assert.equal(unchangedCompletedRun(raw,structuredClone(raw),'own','original-run','synthetic marker'),true);
  assert.equal(unchangedCompletedRun(raw,{...raw,history:[]},'own','original-run','synthetic marker'),false);
  assert.equal(unchangedCompletedRun(raw,{...raw,history:[...raw.history,{kind:'later_desktop_projection'}]},'own','original-run','synthetic marker'),false);
});
