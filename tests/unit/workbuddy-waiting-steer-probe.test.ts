import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareWaitingQuestion,waitingRoundtripObserved,waitingControlsRoundtripObserved } from '../probes/workbuddy-waiting-steer.js';

test('waiting steer requires the original live native question and never borrows an executable request or another Run',()=>{
  const snapshot={state:'question',sessionRef:'own',toolCallId:'question-tool',isProcessing:true,returned:false,failed:false,
    toolUpdates:[{sessionUpdate:'tool_call',toolCallId:'question-tool',_meta:{'codebuddy.ai/requestId':'original-run'}}],
    messages:[{jsonrpc:'2.0',id:17,method:'session/request_permission',params:{sessionId:'own',
      toolCall:{toolCallId:'question-tool',rawInput:{questions:[{question:'Synthetic choice?',options:[{label:'A'},{label:'B'}]}]},
        _meta:{'codebuddy.ai/toolName':'AskUserQuestion'}},options:[{optionId:'allow',kind:'allow_once',name:'Answer question'}]}}]};
  assert.deepEqual(prepareWaitingQuestion(snapshot,'own','original-run','B'),{toolCallId:'question-tool',sourceCount:1});
  for(const change of [{state:'running'},{sessionRef:'foreign'},{isProcessing:false},{returned:true},{failed:true},{toolUpdates:[]},{toolCallId:'foreign-tool'}])
    assert.equal(prepareWaitingQuestion({...snapshot,...change},'own','original-run','B'),undefined);
  assert.equal(prepareWaitingQuestion(snapshot,'own','foreign-run','B'),undefined);
  assert.equal(prepareWaitingQuestion(snapshot,'own','original-run','unoffered-choice'),undefined);
  const executable=structuredClone(snapshot);executable.messages[0]!.params.toolCall._meta['codebuddy.ai/toolName']='Bash';
  assert.equal(prepareWaitingQuestion(executable,'own','original-run','B'),undefined);
  const hidden=structuredClone(snapshot);Object.assign(hidden.toolUpdates[0]!._meta,{'codebuddy.ai/isTeamMember':true});
  assert.equal(prepareWaitingQuestion(hidden,'own','original-run','B'),undefined);
});

test('waiting steer must take effect before the original task returns, while consumption after a valid question answer remains eligible',()=>{
  const evidence={accepted:true,questionHeldBeforeAnswer:true,appliedBeforeTaskReturn:true,changedOutput:true,integrity:true,
    conflict:false,truncated:false,question:{answerAcknowledged:true,selectedChoiceObserved:true,completedNormally:true,isProcessing:false,noOtherToolsObserved:true}};
  assert.equal(waitingRoundtripObserved(evidence),true);
  assert.equal(waitingRoundtripObserved({...evidence,appliedBeforeTaskReturn:false}),false);
  assert.equal(waitingRoundtripObserved({...evidence,questionHeldBeforeAnswer:false}),false);
  assert.equal(waitingRoundtripObserved({...evidence,question:{...evidence.question,answerAcknowledged:false}}),false);
  assert.equal(waitingRoundtripObserved({...evidence,changedOutput:false}),false);
});

test('two waiting controls require distinct identities and independent receipts, consumption and changed output',()=>{
  const evidence={expectedControls:2 as const,questionHeldBeforeAnswer:true,integrity:true,conflict:false,truncated:false,
    question:{answerAcknowledged:true,selectedChoiceObserved:true,completedNormally:true,isProcessing:false,noOtherToolsObserved:true},
    controls:[{inputId:'input-a',operationId:'operation-a',accepted:true,appliedBeforeTaskReturn:true,changedOutput:true},
      {inputId:'input-b',operationId:'operation-b',accepted:true,appliedBeforeTaskReturn:true,changedOutput:true}]};
  assert.equal(waitingControlsRoundtripObserved(evidence),true);
  assert.equal(waitingControlsRoundtripObserved({...evidence,controls:evidence.controls.slice(0,1)}),false);
  for(const change of [{inputId:'input-a'},{operationId:'operation-a'},{inputId:''},{operationId:''},
    {accepted:false},{appliedBeforeTaskReturn:false},{changedOutput:false}]) {
    const controls=[evidence.controls[0]!,{...evidence.controls[1]!,...change}];
    assert.equal(waitingControlsRoundtripObserved({...evidence,controls}),false);
  }
  assert.equal(waitingControlsRoundtripObserved({...evidence,questionHeldBeforeAnswer:false}),false);
  assert.equal(waitingControlsRoundtripObserved({...evidence,question:{...evidence.question,answerAcknowledged:false}}),false);
  assert.equal(waitingControlsRoundtripObserved({...evidence,conflict:true}),false);
  assert.equal(waitingControlsRoundtripObserved({...evidence,integrity:false}),false);
  assert.equal(waitingControlsRoundtripObserved({...evidence,truncated:true}),false);
});
