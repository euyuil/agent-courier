import test from 'node:test';
import assert from 'node:assert/strict';
import { acpQuestionExperiment } from '../probes/workbuddy-acp-question.js';
import type { HarnessPort } from '../../src/adapters/harness/port.js';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';

function fixture(mode:'valid'|'permission'|'wrong_marker'|'stale'|'foreign'|'unknown'|'echo_only'='valid') {
  let listener:((event:HarnessEvent)=>void)|undefined,selected='',answers=0,released=false;
  const base={schemaVersion:1 as const,eventKey:'synthetic-event',sessionRef:'own-harness',runRef:'own-run'};
  const adapter:Pick<HarnessPort,'start'|'answer'|'subscribe'>={
    subscribe:(_session,consume)=>{listener=consume;return ()=>{released=true;listener=undefined;};},
    start:input=>{
      const question=/CourierQuestion-[a-f0-9-]+/.exec(input.text)![0],labelA=/CourierA-[a-f0-9-]+/.exec(input.text)![0];
      selected=/CourierB-[a-f0-9-]+/.exec(input.text)![0];
      listener!({...base,...(mode==='foreign'?{runRef:'foreign-run'}:{}),eventType:'input.requested',payload:{vendorRequestId:'own-question',
        messageId:'question-body',kind:mode==='permission'?'permission':'question',adapterMappingRef:'synthetic-mapping',
        answerSchema:{mode:'form',fields:[{fieldId:'q_0',label:mode==='wrong_marker'?'foreign question':question,required:true,valueType:'choice',
          options:[{code:labelA,label:labelA},{code:selected,label:selected}]}]}}});
      if(mode==='stale')listener!({...base,eventType:'input.invalidated',payload:{vendorRequestId:'own-question',reason:'withdrawn'}});
      if(mode==='foreign')listener!({...base,eventType:'run.completed',payload:{stopReason:'end_turn',completionEvidence:'synthetic-stop'}});
      return {operationId:input.operationId,receipt:Promise.resolve({status:'accepted',sessionRef:'own-harness',runRef:'own-run',receiptEvidence:'synthetic-start'})};
    },
    answer:input=>{
      answers++;assert.equal(input.sessionRef,'own-harness');assert.equal(input.runRef,'own-run');assert.equal(input.vendorRequestId,'own-question');
      assert.deepEqual(input.answer,{kind:'form',values:{q_0:selected}});
      listener!({...base,eventType:'input.accepted',payload:{operationId:input.operationId,inputId:input.inputId,receiptEvidence:'synthetic-answer'}});
      const messageId=mode==='echo_only'?'question-body':'agent-reply';
      listener!({...base,eventType:'message.fragment',payload:{messageId,fragmentKey:'part-a',fragmentIndex:0,text:selected.slice(0,10)}});
      listener!({...base,eventType:'message.fragment',payload:{messageId,fragmentKey:'part-b',fragmentIndex:1,text:selected.slice(10)}});
      listener!({...base,eventType:'run.completed',payload:{stopReason:'end_turn',completionEvidence:'synthetic-stop'}});
      return {operationId:input.operationId,receipt:Promise.resolve(mode==='unknown'?{status:'unknown',errorCode:'state_unknown'}:
        {status:'accepted',sessionRef:'own-harness',runRef:'own-run',vendorRequestId:'own-question',receiptEvidence:'synthetic-answer'})};
    },
  };
  return {adapter,withdraw:()=>listener?.({...base,eventType:'input.invalidated',payload:{vendorRequestId:'own-question',reason:'withdrawn'}}),
    get answers(){return answers;},get released(){return released;}};
}

test('owned ACP question observation requires the original accepted answer and actual assembled continuation',async()=>{
  const f=fixture(),report=await acpQuestionExperiment(f.adapter,'own-harness');
  assert.equal(report['status'],'observed');assert.equal(report['answerAcceptedEvent'],true);assert.equal(report['selectedChoiceObserved'],true);
  assert.equal(report['executionPermissionApprovals'],0);assert.equal(f.answers,1);assert.equal(f.released,true);
});

test('owned question probe never answers permissions, wrong questions, withdrawn inputs or another Run',async()=>{
  for(const mode of ['permission','wrong_marker','stale','foreign'] as const) {
    const f=fixture(mode),report=await acpQuestionExperiment(f.adapter,'own-harness');
    assert.equal(report['status'],'unverified');assert.equal(f.answers,0);assert.equal(f.released,true);
  }
});

test('unknown answers are not retried and a question-body echo cannot prove Agent continuation',async()=>{
  for(const mode of ['unknown','echo_only'] as const) {
    const f=fixture(mode),report=await acpQuestionExperiment(f.adapter,'own-harness');
    assert.equal(report['status'],'unverified');assert.equal(f.answers,1);assert.equal(f.released,true);
  }
});

test('a coordinated peer observation runs before the exact question answer and cannot answer after withdrawal or failed observation',async()=>{
  for(const mode of ['valid','failed','withdrawn'] as const){
    const f=fixture();let hooks=0;
    const report=await acpQuestionExperiment(f.adapter,'own-harness',1000,async observation=>{
      hooks++;assert.equal(f.answers,0);assert.equal(observation.request.payload.vendorRequestId,'own-question');
      assert.equal(observation.labels.length,2);assert.equal(observation.selected,observation.labels[1]);
      if(mode==='withdrawn')f.withdraw();return mode!=='failed';
    });
    assert.equal(hooks,1);assert.equal(f.answers,mode==='valid'?1:0);assert.equal(report['status'],mode==='valid'?'observed':'unverified');
    assert.equal(f.released,true);
  }
});

test('peer work cannot consume the independent observation window for the original question continuation',async()=>{
  const f=fixture(),report=await acpQuestionExperiment(f.adapter,'own-harness',20,async()=>{
    await new Promise(resolve=>setTimeout(resolve,30));return true;
  });
  assert.equal(report['status'],'observed');assert.equal(f.answers,1);assert.equal(report['answerAcceptedEvent'],true);
});
