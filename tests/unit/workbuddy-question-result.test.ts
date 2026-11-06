import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeQuestionResult } from '../probes/workbuddy-question-result.js';

test('question-result diagnostics expose only known structure and selected-label presence without claiming consumption',()=>{
  const result=summarizeQuestionResult({status:'completed',rawOutput:{text:'Chosen: private-selected',privateUnknown:'private-body'}},'private-selected','private-other');
  assert.equal(result['status'],'completed');assert.equal(result['source'],'raw_output');
  assert.deepEqual(result['fields'],['text']);assert.equal(result['selectedLabelPresent'],true);assert.equal(result['unselectedLabelPresent'],false);
  assert.equal(JSON.stringify(result).includes('private-'),false);assert.equal('consumed' in result,false);
  const both=summarizeQuestionResult({status:'completed',content:[{type:'text',text:'private-selected or private-other'}]},'private-selected','private-other');
  assert.equal(both['source'],'content');assert.equal(both['selectedLabelPresent'],true);assert.equal(both['unselectedLabelPresent'],true);
});

test('completed status without a result, unbounded payloads and serialization failures remain unknown diagnostics',()=>{
  const missing=summarizeQuestionResult({status:'completed'},'selected','other');
  assert.equal(missing['source'],'missing');assert.equal(missing['selectedLabelPresent'],null);
  const tooLarge=summarizeQuestionResult({status:'completed',rawOutput:{text:'x'.repeat(1048577)}},'selected','other');
  assert.equal(tooLarge['bounded'],false);assert.equal(tooLarge['selectedLabelPresent'],null);
  const cyclic:Record<string,unknown>={};cyclic['cycle']=cyclic;
  const bad=summarizeQuestionResult({status:'private-status',rawOutput:cyclic},'selected','other');
  assert.equal(bad['status'],'other');assert.equal(bad['bounded'],false);assert.equal(JSON.stringify(bad).includes('private-'),false);
});
