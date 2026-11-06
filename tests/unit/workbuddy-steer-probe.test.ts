import test from 'node:test';
import assert from 'node:assert/strict';
import { originalProbeRun,secondProbeControlReady,newMarkerMessageCount,slashRejectionObserved,nearCompletionControlReady } from '../probes/workbuddy-steer.js';
import type { Receipt } from '../../src/adapters/harness/port.js';

test('steer observation requires an actual event for its preassigned Run in a running own Harness session',()=>{
  const event=(ref:string)=>({update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'synthetic prompt'},
    _meta:{'codebuddy.ai/requestId':ref}}});
  const snapshot={sessionId:'own',isProcessing:true,events:[event('original-run')]};
  assert.equal(originalProbeRun(snapshot,'own','original-run'),'original-run');
  const userEcho=event('original-run');userEcho.update.sessionUpdate='user_message_chunk';
  assert.equal(originalProbeRun({...snapshot,events:[userEcho]},'own','original-run'),undefined);
  assert.equal(originalProbeRun(snapshot,'own',''),undefined);
  assert.equal(originalProbeRun({...snapshot,sessionId:'foreign'},'own','original-run'),undefined);
  assert.equal(originalProbeRun({...snapshot,isProcessing:false},'own','original-run'),undefined);
  assert.equal(originalProbeRun(snapshot,'own','foreign-run'),undefined);
  assert.equal(originalProbeRun({...snapshot,events:[event('foreign-run')]},'own','original-run'),undefined);
  const visible=event('original-run');visible.update.sessionUpdate='agent_message_chunk';
  assert.equal(originalProbeRun({...snapshot,events:[visible]},'own','original-run'),'original-run');
  const internal=event('original-run');Object.assign(internal.update._meta,{'codebuddy.ai/isTeamMember':true});
  assert.equal(originalProbeRun({...snapshot,events:[internal]},'own','original-run'),undefined);
});

test('near-completion control requires the planned late output in one original message before any task terminal',()=>{
  const prefix=Array.from({length:17},(_,i)=>`${String(i+1).padStart(2,'0')}. Synthetic fact`).join('\n')+'\n18. LATE-ANCHOR';
  const frame=(text:string)=>({sessionId:'own',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text},
    _meta:{'codebuddy.ai/conversationRequestId':'original-run','codebuddy.ai/requestId':'original-run',
      'codebuddy.ai/messageRequestId':'original-run','codebuddy.ai/messageId':'original-message'}}});
  const snapshot={sessionId:'own',isProcessing:true,returned:false,failed:false,pendingQuestions:0,pendingPermissions:0,terminalObserved:false,
    events:[frame(prefix.slice(0,-3)),frame(prefix.slice(-3))]};
  assert.equal(nearCompletionControlReady(snapshot,'own','original-run','LATE-ANCHOR'),true);
  for(const change of [{sessionId:'foreign'},{isProcessing:false},{returned:true},{failed:true},{pendingQuestions:1},
    {pendingPermissions:1},{terminalObserved:true},{events:[frame(prefix.slice(0,-3))]},{events:[frame('18. LATE-ANCHOR')]},
    {events:[frame(prefix.replace('17. Synthetic fact','16. Synthetic fact'))]}])
    assert.equal(nearCompletionControlReady({...snapshot,...change},'own','original-run','LATE-ANCHOR'),false);
  for(const meta of [{'codebuddy.ai/messageRequestId':'foreign-run'},{'codebuddy.ai/requestId':'foreign-run'},
    {'codebuddy.ai/conversationRequestId':'foreign-run'},{'codebuddy.ai/isTeamMember':true}]) {
    const event=frame(prefix);Object.assign(event.update._meta,meta);
    assert.equal(nearCompletionControlReady({...snapshot,events:[event]},'own','original-run','LATE-ANCHOR'),false);
  }
  const other=frame(prefix.slice(-3));other.update._meta['codebuddy.ai/messageId']='another-message';
  assert.equal(nearCompletionControlReady({...snapshot,events:[snapshot.events[0]!,other]},'own','original-run','LATE-ANCHOR'),false);
  const echo=frame(prefix);echo.update.sessionUpdate='user_message_chunk';
  assert.equal(nearCompletionControlReady({...snapshot,events:[echo]},'own','original-run','LATE-ANCHOR'),false);
  assert.equal(nearCompletionControlReady({...snapshot,events:[...snapshot.events,{sessionId:'own',update:{sessionUpdate:'tool_call'}}]},
    'own','original-run','LATE-ANCHOR'),false);
});

test('slash rejection needs a definite content refusal while the original Run continues unchanged, never an idle refusal or unknown',()=>{
  const evidence={receipt:{status:'rejected',errorCode:'steer_rejected',definitelyNotAccepted:true} as Receipt,rawSteered:false,
    dispatchedWhileProcessing:true,applied:false,ownerUnchanged:true,originalOutput:true,changedOutput:false,
    completedNormally:true,processing:false,toolCallFrames:0,integrity:true,conflict:false,truncated:false};
  assert.equal(slashRejectionObserved(evidence),true);
  for(const change of [{rawSteered:true},{dispatchedWhileProcessing:false},{applied:true},{ownerUnchanged:false},{originalOutput:false},
    {changedOutput:true},{completedNormally:false},{processing:true},{toolCallFrames:1},{integrity:false},{conflict:true},{truncated:true}])
    assert.equal(slashRejectionObserved({...evidence,...change}),false);
  for(const receipt of [{status:'unknown',errorCode:'state_unknown'},
    {status:'rejected',errorCode:'stale_run',definitelyNotAccepted:true},{status:'accepted',receiptEvidence:'synthetic'}] as Receipt[])
    assert.equal(slashRejectionObserved({...evidence,receipt}),false);
});

test('same-text observation counts new logical output identities without treating repeated fragments, echoes or thought as a second result',()=>{
  const frame=(id:string,text:string)=>({sessionId:'own',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text},
    _meta:{'codebuddy.ai/messageId':id}}});
  const before=[frame('first','MARKER')],after=[frame('first','MARKER'),frame('second','MAR'),frame('second','KER')];
  assert.equal(newMarkerMessageCount(before,after,'MARKER','own'),1);
  assert.equal(newMarkerMessageCount([],before.concat(after),'MARKER','own'),2);
  assert.equal(newMarkerMessageCount(before,[frame('first','MARKER')],'MARKER','own'),0);
  assert.equal(newMarkerMessageCount([],[frame('left','MAR'),frame('right','KER')],'MARKER','own'),0);
  assert.equal(newMarkerMessageCount([],after,'','own'),0);
  const thought=frame('thought','MARKER');thought.update.sessionUpdate='agent_thought_chunk';
  const echo=frame('input','MARKER');echo.update.sessionUpdate='user_message_chunk';
  const foreign=frame('foreign','MARKER');foreign.sessionId='other';
  const internal=frame('replayed','MARKER');Object.assign(internal.update._meta,{'codebuddy.ai/historyReplay':true});
  assert.equal(newMarkerMessageCount([],[thought,echo,foreign,internal],'MARKER','own'),0);
});

test('the second steer requires changed visible content from the verified next owner while the original submission is still running',()=>{
  const frame=(text:string)=>({sessionId:'own',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text},
    _meta:{'codebuddy.ai/conversationRequestId':'next-owner','codebuddy.ai/requestId':'next-owner',
      'codebuddy.ai/messageRequestId':'original-run','codebuddy.ai/messageId':'visible-message'}}});
  const snapshot={sessionId:'own',isProcessing:true,returned:false,failed:false,pendingPermissions:0,pendingQuestions:0,
    events:[frame('FIRST-'),frame('CHANGE')]};
  assert.equal(secondProbeControlReady(snapshot,'own','next-owner','original-run','FIRST-CHANGE'),true);
  for(const change of [{sessionId:'foreign'},{isProcessing:false},{returned:true},{failed:true},{pendingQuestions:1},
    {pendingPermissions:1},{events:[]},{events:[frame('incomplete')]}])
    assert.equal(secondProbeControlReady({...snapshot,...change},'own','next-owner','original-run','FIRST-CHANGE'),false);
  assert.equal(secondProbeControlReady(snapshot,'own','original-run','original-run','FIRST-CHANGE'),false);
  assert.equal(secondProbeControlReady(snapshot,'own','next-owner','original-run',''),false);
  for(const meta of [{'codebuddy.ai/messageRequestId':'foreign-run'},{'codebuddy.ai/conversationRequestId':'foreign-owner'},
    {'codebuddy.ai/requestId':'foreign-owner'},{'codebuddy.ai/isSubAgent':true},{'codebuddy.ai/messageId':''}]) {
    const event=frame('FIRST-CHANGE');Object.assign(event.update._meta,meta);
    assert.equal(secondProbeControlReady({...snapshot,events:[event]},'own','next-owner','original-run','FIRST-CHANGE'),false);
  }
  const thought=frame('FIRST-CHANGE');thought.update.sessionUpdate='agent_thought_chunk';
  assert.equal(secondProbeControlReady({...snapshot,events:[thought]},'own','next-owner','original-run','FIRST-CHANGE'),false);
  const foreign=frame('FIRST-CHANGE');foreign.sessionId='foreign';
  assert.equal(secondProbeControlReady({...snapshot,events:[foreign]},'own','next-owner','original-run','FIRST-CHANGE'),false);
  const separated=frame('CHANGE');separated.update._meta['codebuddy.ai/messageId']='different-message';
  assert.equal(secondProbeControlReady({...snapshot,events:[frame('FIRST-'),separated]},'own','next-owner','original-run','FIRST-CHANGE'),false);
});
