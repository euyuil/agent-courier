import { randomUUID } from 'node:crypto';
import { prepareInteractionAnswer } from '../../src/adapters/workbuddy-experimental/interaction-command.js';
import { observedInteraction } from './workbuddy-interaction.js';

interface Diagnostic { evaluate(expression:string,timeout?:number):Promise<unknown> }
export interface QuestionExperimentControl {
  runRef:string;afterQuestion:(observation:unknown,selected:string)=>Promise<boolean>;beforeAnswer:()=>void;
}
export function prepareObservedQuestion(value:unknown,selected:string):{answers:Record<string,string|string[]>;sourceCount:number}|undefined {
  const observed=observedInteraction(value,'question','AskUserQuestion');if(!observed)return undefined;
  const {mapping,sourceCount}=observed;
  const result=prepareInteractionAnswer(mapping,{operationId:'independent-answer',inputId:'independent-answer-input',sessionRef:mapping.sessionRef,
    runRef:mapping.runRef,vendorRequestId:mapping.vendorRequestId,answer:{kind:'form',values:{q_0:selected}}});
  return result?.answers&&result.decision==='allow'?{answers:result.answers,sourceCount}:undefined;
}
export async function questionExperiment(diagnostic:Diagnostic,replyPath:'question'|'interruption'='question',control?:QuestionExperimentControl):Promise<Record<string,unknown>> {
  const options=[`Choice-A-${randomUUID()}`,`Choice-B-${randomUUID()}`],selected=options[1]!;
  const prompt=`Use the built-in AskUserQuestion tool to ask exactly one single-choice question with these exact two option labels: ${options.join(' and ')}. `
    +'Wait for my answer. Then reply with only the exact selected option label. Do not run any other tools, read files, write files, or request execution permissions.';
  const started=await diagnostic.evaluate(`(async()=>{const p=globalThis.__courierCapabilityProbe;if(!p?.sessionId)return false;
    const before=await globalThis.__wbInvoke('session:get',{},p.sessionId);if(before?.__wbError)return false;
    p.questionStartCount=(before?.eventHistory??[]).length;p.questionResult=undefined;p.questionFailed=false;
    p.questionPromise=globalThis.__wbInvoke('session:sendMessage',{},p.sessionId,[{type:'text',text:${JSON.stringify(prompt)}}]${control?
      `,{'codebuddy.ai/conversationRequestId':${JSON.stringify(control.runRef)},'codebuddy.ai/requestId':${JSON.stringify(control.runRef)},'codebuddy.ai':{requestId:${JSON.stringify(control.runRef)}}}`:''})
    .then(result=>{p.questionResult=result;}).catch(()=>{p.questionFailed=true;});return true;})()`);
  if(started!==true)return {status:'not_started'};
  let observed=false,questionState:unknown,prepared:ReturnType<typeof prepareObservedQuestion>;
  const until=Date.now()+60000;
  while(Date.now()<until) {
    const state=await diagnostic.evaluate(`(async()=>{const p=globalThis.__courierCapabilityProbe;const s=await globalThis.__wbInvoke('session:get',{},p.sessionId);
      if(s?.__wbError)return {state:'unknown'};
      const choices=${JSON.stringify(options)},requests=[];
      for(const e of (s.eventHistory??[]).slice(p.questionStartCount)){const u=e.update??{},m=u._meta??{};
        if(u.sessionUpdate==='tool_call'&&(m['codebuddy.ai/toolName']??m['codebuddy.ai']?.toolName)!=='AskUserQuestion')return {state:'other_tool_observed'};}
      for(const item of s?.pendingPermissions??[]){const r=item.request??{},call=r.toolCall??{},meta=call._meta??{};
        const name=meta['codebuddy.ai/toolName']??meta['codebuddy.ai']?.toolName;
        if(name==='AskUserQuestion')requests.push({id:call.toolCallId,questions:call.rawInput?.questions,
          message:{jsonrpc:'2.0',id:item.requestId,method:'session/request_permission',params:r}});
        else return {state:'other_permission'};}
      for(const item of s?.pendingQuestions??[]){const r=item.request??{};requests.push({id:item.toolCallId??r.toolCallId,questions:r.questions});}
      for(const r of requests){if(typeof r.id!=='string'||!Array.isArray(r.questions)||r.questions.length!==1)continue;
        const q=r.questions[0],labels=(q?.options??[]).map(o=>o.label);
        if(labels.length===2&&choices.every(label=>labels.includes(label))&&!q.multiSelect){
          const updates=(s.eventHistory??[]).map(e=>e.update).filter(u=>u?.sessionUpdate==='tool_call'&&u.toolCallId===r.id);
          const messages=requests.filter(item=>item.id===r.id&&item.message).map(item=>item.message);
          for(const e of s.eventHistory??[]){const u=e.update??{},i=u._meta?.['codebuddy.ai/interruptionRequest'];
            if(u.sessionUpdate==='session_info_update'&&i?.toolCallId===r.id)messages.push({jsonrpc:'2.0',method:'session/update',params:{sessionId:p.sessionId,update:u}});}
          p.questionToolCallId=r.id;return {state:'question',sessionRef:p.sessionId,toolCallId:r.id,toolUpdates:updates,messages,
            isProcessing:s.isProcessing===true,returned:p.questionResult!==undefined,failed:p.questionFailed===true};}}
      if(p.questionFailed||p.questionResult)return {state:'finished_without_matching_question'};
      return {state:requests.length?'question_shape_unverified':'running'};})()`) as {state?:string}|undefined;
    if(state?.state==='question'){observed=true;questionState=state;prepared=prepareObservedQuestion(state,selected);break;}
    if(state?.state==='other_permission'||state?.state==='other_tool_observed'||state?.state==='finished_without_matching_question'||state?.state==='question_shape_unverified')return {status:state.state,questionObserved:false,executionPermissionApprovals:0};
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  if(!observed)return {status:'question_not_observed',questionObserved:false,executionPermissionApprovals:0};
  if(!prepared)return {status:'production_mapping_unverified',questionObserved:true,productionMappingObserved:false,executionPermissionApprovals:0};
  const expectedQuestions=control?observedInteraction(questionState,'question','AskUserQuestion')?.mapping.nativeInput['questions']:undefined;
  if(control&&(!Array.isArray(expectedQuestions)||!await control.afterQuestion(questionState,selected)))
    return {status:'stopped_before_answer',questionObserved:true,productionMappingObserved:true,executionPermissionApprovals:0};
  control?.beforeAnswer();
  const answered=await diagnostic.evaluate(`(async()=>{const p=globalThis.__courierCapabilityProbe;
    if(typeof p?.questionToolCallId!=='string')return false;
    const before=await globalThis.__wbInvoke('session:get',{},p.sessionId);
    if(before?.__wbError||before?.sessionId!==p.sessionId)return false;
    ${control?`const expected=${JSON.stringify(expectedQuestions)},same=(id,questions)=>id===p.questionToolCallId&&JSON.stringify(questions)===JSON.stringify(expected);
      const original=(before.pendingPermissions??[]).some(item=>{const t=item.request?.toolCall??{};return same(t.toolCallId,t.rawInput?.questions)&&
        (t._meta?.['codebuddy.ai/toolName']??t._meta?.['codebuddy.ai']?.toolName)==='AskUserQuestion';})||
        (before.pendingQuestions??[]).some(item=>same(item.toolCallId??item.request?.toolCallId,item.request?.questions));
      if(!original||p.questionResult!==undefined||p.questionFailed)return false;`:''}
    p.questionBeforeAnswerCount=(before.eventHistory??[]).length;
    return await globalThis.__wbInvoke(${JSON.stringify(replyPath==='interruption'?'session:resolveInterruption':'session:answerQuestion')},{},p.sessionId,p.questionToolCallId,${replyPath==='interruption'?"'allow',":''}${JSON.stringify(prepared.answers)});})()`);
  if(answered!==true)return {status:'answer_not_acknowledged',questionObserved:true,answerAcknowledged:false,productionMappingObserved:true,executionPermissionApprovals:0};
  const finished=await diagnostic.evaluate(`(async()=>{const p=globalThis.__courierCapabilityProbe;await p.questionPromise;
    const s=await globalThis.__wbInvoke('session:get',{},p.sessionId),r=p.questionResult;
    const h=s?.eventHistory??[],cursor=p.questionBeforeAnswerCount,text=h.slice(cursor).map(e=>e.update).filter(u=>u?.sessionUpdate==='agent_message_chunk').map(u=>u.content?.text??'').join('');
    const otherTools=h.slice(p.questionStartCount).map(e=>e.update??{}).filter(u=>u.sessionUpdate==='tool_call'&&
      (u._meta?.['codebuddy.ai/toolName']??u._meta?.['codebuddy.ai']?.toolName)!=='AskUserQuestion').length;
    return {explicitCompletion:typeof r?.stopReason==='string',completedNormally:r?.stopReason==='end_turn',
      selectedChoiceObserved:typeof cursor==='number'&&h.length>=cursor&&text.includes(${JSON.stringify(selected)}),isProcessing:s?.isProcessing===true,
      noOtherToolsObserved:otherTools===0};})()`,90000);
  return {status:'observed',questionObserved:true,answerAcknowledged:true,productionMappingObserved:true,originalToolCorrelationObserved:true,
    productionAnswerFieldsObserved:true,mappedSourceCount:prepared.sourceCount,replyPath,executionPermissionApprovals:0,...(finished&&typeof finished==='object'?finished:{})};
}
