import { randomUUID } from 'node:crypto';
import { AcpConnection } from '../../src/adapters/workbuddy-experimental/connection.js';
import { WorkBuddySteering } from '../../src/adapters/workbuddy-experimental/steer.js';
import { WorkBuddyRunReferences } from '../../src/adapters/workbuddy-experimental/run-references.js';
import { record,requestRef,internalFrame,newRequestRef,metaField } from '../../src/adapters/workbuddy-experimental/metadata.js';
import { safeCode } from '../../src/domain/errors.js';
import { observedInteraction } from './workbuddy-interaction.js';
import { prepareObservedQuestion,questionExperiment } from './workbuddy-question.js';
import { ownRuntimeEndpoints,identifyOwnAcpTransport } from './workbuddy-acp.js';
import { WorkBuddyTrace } from './workbuddy-trace.js';

interface Diagnostic {evaluate(expression:string,timeout?:number):Promise<unknown>}
export function waitingRoundtripObserved(evidence:{accepted:boolean;questionHeldBeforeAnswer:boolean;appliedBeforeTaskReturn:boolean;
  changedOutput:boolean;integrity:boolean;conflict:boolean;truncated:boolean;question:Record<string,unknown>}):boolean {
  const q=evidence.question;
  return evidence.accepted&&evidence.questionHeldBeforeAnswer&&evidence.appliedBeforeTaskReturn&&evidence.changedOutput&&
    evidence.integrity&&!evidence.conflict&&!evidence.truncated&&q['answerAcknowledged']===true&&q['selectedChoiceObserved']===true&&
    q['completedNormally']===true&&q['isProcessing']===false&&q['noOtherToolsObserved']===true;
}
interface WaitingControlEvidence {inputId:string;operationId:string;accepted:boolean;appliedBeforeTaskReturn:boolean;changedOutput:boolean}
export function waitingControlsRoundtripObserved(evidence:{expectedControls:1|2;controls:WaitingControlEvidence[];
  questionHeldBeforeAnswer:boolean;integrity:boolean;conflict:boolean;truncated:boolean;question:Record<string,unknown>}):boolean {
  const controls=evidence.controls;
  return controls.length===evidence.expectedControls&&controls.every(control=>!!control.inputId&&!!control.operationId)&&
    new Set(controls.map(control=>control.inputId)).size===controls.length&&new Set(controls.map(control=>control.operationId)).size===controls.length&&
    controls.every(control=>waitingRoundtripObserved({...evidence,...control}));
}
export function prepareWaitingQuestion(value:unknown,owner:string,run:string,selected:string):{toolCallId:string;sourceCount:number}|undefined {
  const snapshot=record(value),observed=observedInteraction(value,'question','AskUserQuestion');
  if(!owner||!run||snapshot['state']!=='question'||snapshot['isProcessing']!==true||snapshot['returned']!==false||snapshot['failed']!==false||
    !observed||observed.mapping.sessionRef!==owner||observed.mapping.runRef!==run||!prepareObservedQuestion(value,selected))return undefined;
  return {toolCallId:observed.mapping.toolCallId,sourceCount:observed.sourceCount};
}
export async function waitingSteerExperiment(diagnostic:Diagnostic,cwd:string,count:1|2=1):Promise<Record<string,unknown>> {
  const owner=await diagnostic.evaluate(`(async()=>{const p=globalThis.__courierCapabilityProbe;if(typeof p?.sessionId!=='string')return;
    const s=await globalThis.__wbInvoke('session:get',{},p.sessionId);
    return !s?.__wbError&&s?.sessionId===p.sessionId&&s?.cwd===${JSON.stringify(cwd)}&&s?.isProcessing===false?p.sessionId:undefined;})()`);
  if(typeof owner!=='string')return {status:'original_owner_unverified'};
  const runtime=ownRuntimeEndpoints(cwd,'/proc',owner),identified=await identifyOwnAcpTransport(runtime.endpoints);
  if(!identified.endpoint)return {status:'endpoint_unverified'};
  const run=newRequestRef(),controls=Array.from({length:count},()=>({inputId:randomUUID(),operationId:randomUUID(),marker:`CourierWaiting-${randomUUID()}`,
    requested:false,receipt:'not_requested',receiptMs:undefined as number|undefined,applied:false,appliedAfterAnswer:false,consumedWhilePending:false,
    appliedBeforeTaskReturn:false,changedOutput:false,applicationObservation:undefined as Promise<boolean>|undefined}));
  const first=controls[0]!;
  const trace=new WorkBuddyTrace(owner,{run,input:first.inputId,operation:first.operationId},{original:'',changed:first.marker});
  const references=new WorkBuddyRunReferences(run),connection=new AcpConnection({endpoint:identified.endpoint,timeoutMs:5000}),stored=new Map<string,unknown>();
  let conflict=false,answerSubmitted=false,questionHeldBeforeAnswer=false,seen=0,observationMs=0,integrity=true;
  const visible:Record<string,unknown>[]=[];
  const steering=new WorkBuddySteering(connection,{get:key=>stored.get(key),set:(key,value)=>{stored.set(key,value);}},
    (input,_evidence,transition)=>{
      const index=controls.findIndex(control=>control.inputId===input.inputId&&control.operationId===input.operationId),control=controls[index];
      if(!control){integrity=false;return;}
      control.applied=true;control.appliedAfterAnswer=answerSubmitted;trace.mark(index===0?'control_applied':'second_control_applied');
      if(!references.advance(transition))conflict=true;
      control.applicationObservation=diagnostic.evaluate(`(async()=>{const p=globalThis.__courierCapabilityProbe;if(p?.sessionId!==${JSON.stringify(owner)})return;
        const s=await globalThis.__wbInvoke('session:get',{},p.sessionId);if(s?.__wbError||s?.sessionId!==p.sessionId)return;
        return {sessionId:s.sessionId,processing:s.isProcessing===true,returned:p.questionResult!==undefined,failed:p.questionFailed===true};})()`)
        .then(value=>{const state=record(value);if(state['sessionId']!==owner){integrity=false;return false;}
          trace.mark('application_task_observed',{processing:state['processing']===true,returned:state['returned']===true});
          return state['processing']===true&&state['returned']===false&&state['failed']===false;}).catch(()=>false);
    },()=>{conflict=true;});
  const feed=(params:Record<string,unknown>)=>{
    const update=record(params['update']),ref=requestRef(update)??requestRef(params);
    if(params['sessionId']!==owner||internalFrame(params,update))return;
    if(ref)steering.consume(owner,ref,params);
    if(references.visibleOutput(params))visible.push(params);
  };
  connection.onMessage=message=>{
    if(message.method!=='session/update')return;
    const params=record(message.params);trace.event('acp',params);feed(params);
  };
  const finish=(result:Record<string,unknown>):Record<string,unknown>=>{
    const data=trace.snapshot();return {...result,controlCount:count,steerDispatches:controls.filter(control=>control.requested).length,
      controlRequested:controls.some(control=>control.requested),receipt:first.receipt,receiptMs:first.receiptMs,appliedObserved:controls.every(control=>control.applied),
      consumedWhileOriginalQuestionPending:controls.every(control=>control.consumedWhilePending),originalQuestionHeldBeforeAnswer:questionHeldBeforeAnswer,
      answerSubmissionAttempted:answerSubmitted,injectionObservedAfterAnswerAttempt:controls.every(control=>control.appliedAfterAnswer),observationMs,protocolConflict:conflict,
      controls:controls.map(control=>({requested:control.requested,receipt:control.receipt,receiptMs:control.receiptMs,appliedObserved:control.applied,
        consumedWhileOriginalQuestionPending:control.consumedWhilePending,injectionObservedAfterAnswerAttempt:control.appliedAfterAnswer,
        appliedBeforeOriginalTaskReturnObserved:control.appliedBeforeTaskReturn,linkedChangedOutputObserved:control.changedOutput})),
      executionPermissionApprovals:0,sessionLoads:0,rawPromptCalls:0,traceSummary:{events:data.rows.length,truncated:data.truncated},trace:data};
  };
  try {
    await connection.connect();await connection.call('initialize',{protocolVersion:1,clientInfo:{name:'Agent Courier waiting-input probe',version:'1'},clientCapabilities:{}});
    trace.mark('task_submit');
    const question=await questionExperiment(diagnostic,'question',{runRef:run,beforeAnswer:()=>{answerSubmitted=true;trace.mark('answer_submit');},
      afterQuestion:async(value,selected)=>{
        const prepared=prepareWaitingQuestion(value,owner,run,selected),observed=observedInteraction(value,'question','AskUserQuestion');
        if(!prepared||!observed)return false;
        trace.mark('question_observed',{processing:true,returned:false});
        const expression=`(async()=>{const p=globalThis.__courierCapabilityProbe;if(p?.sessionId!==${JSON.stringify(owner)})return;
          const s=await globalThis.__wbInvoke('session:get',{},p.sessionId);if(s?.__wbError||s?.sessionId!==p.sessionId)return;
          const tool=${JSON.stringify(prepared.toolCallId)},expected=${JSON.stringify(observed.mapping.nativeInput['questions'])};
          const same=(id,questions)=>id===tool&&JSON.stringify(questions)===JSON.stringify(expected);
          const permissions=s.pendingPermissions??[],questions=s.pendingQuestions??[];
          const permissionOriginal=item=>{const t=item.request?.toolCall??{};return same(t.toolCallId,t.rawInput?.questions)&&
            (t._meta?.['codebuddy.ai/toolName']??t._meta?.['codebuddy.ai']?.toolName)==='AskUserQuestion';};
          const questionOriginal=item=>same(item.toolCallId??item.request?.toolCallId,item.request?.questions);
          const events=(s.eventHistory??[]).slice(p.questionStartCount);
          return {sessionId:s.sessionId,isProcessing:s.isProcessing===true,returned:p.questionResult!==undefined,failed:p.questionFailed===true,
            originalPending:permissions.some(permissionOriginal)||questions.some(questionOriginal),
            otherPending:permissions.some(item=>!permissionOriginal(item))||questions.some(item=>!questionOriginal(item)),
            otherTool:events.some(e=>{const u=e.update??{},m=u._meta??{};return u.sessionUpdate==='tool_call'&&
              (m['codebuddy.ai/toolName']??m['codebuddy.ai']?.toolName)!=='AskUserQuestion';}),events};})()`;
        const observe=async()=>{
          const state=record(await diagnostic.evaluate(expression));
          if(state['sessionId']!==owner){integrity=false;return state;}
          const events=Array.isArray(state['events'])?state['events']:[];
          if(events.length<seen){integrity=false;trace.mark('history_reset');}
          for(let index=seen;index<events.length;index++) {
            const event=record(events[index]);
            if(typeof event['sessionId']==='string'&&event['sessionId']!==owner){integrity=false;continue;}
            const params:Record<string,unknown>={...event,sessionId:owner};trace.event('desktop',params,index);
            // 可见内容只从原始 ACP 到达时记录，避免两条观察路径重复拼接。
            const update=record(params['update']),ref=requestRef(update)??requestRef(params);
            if(ref&&!internalFrame(params,update))steering.consume(owner,ref,params);
          }
          seen=events.length;return state;
        };
        let state=await observe();
        const valid=()=>integrity&&!conflict&&state['sessionId']===owner&&state['isProcessing']===true&&state['returned']===false&&
          state['failed']===false&&state['originalPending']===true&&state['otherPending']===false&&state['otherTool']===false;
        if(!valid())return false;
        const at=Date.now();
        for(const [index,control] of controls.entries()) {
          state=await observe();if(!valid())return false;
          trace.mark(index===0?'control_submit':'second_control_submit',{processing:true,returned:false});control.requested=true;
          const submittedAt=Date.now(),receipt=await steering.dispatch({operationId:control.operationId,inputId:control.inputId,sessionRef:owner,expectedRunRef:run,
            text:`Additional requirement for this same ongoing task: keep the original pending question open and wait for my answer. `+
              `Do not answer, dismiss, cancel or replace it. After I answer, include exactly ${control.marker} together with my selected option in your reply. `+
              'Keep all earlier additional requirements. Do not use any additional tools, read or write files, or contact the network.'},references.ownerRef).receipt;
          control.receiptMs=Date.now()-submittedAt;control.receipt=receipt.status;
          trace.mark(index===0?'control_receipt':'second_control_receipt',{status:receipt.status});
          if(receipt.status!=='accepted')return false;
        }
        const until=Date.now()+15000;
        do {
          state=await observe();observationMs=Date.now()-at;
          if(!valid())return false;
          for(const control of controls)if(control.applied)control.consumedWhilePending=true;
          if(controls.every(control=>control.applied))break;
          await new Promise(resolve=>setTimeout(resolve,200));
        }while(Date.now()<until);
        questionHeldBeforeAnswer=valid();trace.mark('waiting_observation_frozen',{processing:state['isProcessing']===true,returned:state['returned']===true});
        // 冻结答题前结果；后续注入另行核对原正常提交是否仍未返回。
        return questionHeldBeforeAnswer;
      }});
    const messages=new Map<string,string>();
    for(const params of visible) {
      const update=record(params['update']),content=record(update['content']),id=metaField(update['_meta'],'messageId')??update['messageId'];
      if(typeof id==='string'&&content['type']==='text'&&typeof content['text']==='string')messages.set(id,(messages.get(id)??'')+content['text']);
    }
    await Promise.all(controls.map(async control=>{
      control.changedOutput=[...messages.values()].some(text=>text.includes(control.marker));
      control.appliedBeforeTaskReturn=(await(control.applicationObservation??Promise.resolve(false)))||control.consumedWhilePending;
    }));
    const waitingSteerRoundtrip=waitingControlsRoundtripObserved({expectedControls:count,
      controls:controls.map(control=>({...control,accepted:control.receipt==='accepted'})),questionHeldBeforeAnswer,
      integrity,conflict,truncated:trace.snapshot().truncated,question});
    return finish({status:'observed',questionObservation:question,linkedChangedOutputObserved:controls.every(control=>control.changedOutput),
      distinctInputIds:new Set(controls.map(control=>control.inputId)).size===count,
      distinctOperationIds:new Set(controls.map(control=>control.operationId)).size===count,
      appliedBeforeOriginalTaskReturnObserved:controls.every(control=>control.appliedBeforeTaskReturn),waitingSteerRoundtripObserved:waitingSteerRoundtrip});
  }catch(error){return finish({status:'unavailable',code:safeCode(error)});}
  finally{await connection.close().catch(()=>{});}
}
