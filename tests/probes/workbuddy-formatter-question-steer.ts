import { randomUUID } from 'node:crypto';
import type { HarnessPort,Receipt } from '../../src/adapters/harness/port.js';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';
import type { AcpConnection,RpcMessage } from '../../src/adapters/workbuddy-experimental/connection.js';
import { record,string,metaField,requestRef,internalFrame } from '../../src/adapters/workbuddy-experimental/metadata.js';
import { interaction,mergeInteraction,type InteractionMapping } from '../../src/adapters/workbuddy-experimental/interaction.js';
import { formatterFullToolName,formatterInputSchema,decodeFormatterResult,type FormatterPayload } from '../../src/adapters/workbuddy-experimental/formatter.js';
import { proveSteerInputs,type FormatterControl } from './workbuddy-formatter-steer.js';
import { summarizeQuestionResult } from './workbuddy-question-result.js';

type Request=Extract<HarnessEvent,{eventType:'input.requested'}>;
interface Question {text:string;labels:[string,string]}
interface Answer {mapping:InteractionMapping;request:Request;operationId:string;inputId:string;cursor:number;
  receipt?:Receipt;rawMatched?:boolean;rawAccepted?:boolean;acceptedCursor?:number}
const terminal=(event:HarnessEvent)=>['run.completed','run.failed','connection.lost'].includes(event.eventType);

function ownedTool(params:Record<string,unknown>,index:number,run:string,owners:ReadonlyMap<string,number>):boolean {
  const update=record(params['update']),ref=requestRef(update)??requestRef(params);
  const known=(value:unknown)=>typeof value==='string'&&owners.has(value)&&owners.get(value)!<index;
  return !internalFrame(params,update)&&known(ref)&&metaField(update['_meta'],'messageRequestId')===run&&
    [update['requestId'],metaField(update['_meta'],'conversationRequestId'),metaField(update['_meta'],'requestId')]
      .every(value=>typeof value!=='string'||known(value));
}
function matchQuestion(request:Request,expected:Question,messages:RpcMessage[],session:string,run:string,owners:ReadonlyMap<string,number>):InteractionMapping|undefined {
  const schema=request.payload.answerSchema,field=schema?.mode==='form'?schema.fields[0]:undefined;
  if(request.payload.kind!=='question'||schema?.mode!=='form'||schema.fields.length!==1||field?.fieldId!=='q_0'||!field.required||
    field.label!==expected.text||field.valueType!=='choice'||field.options?.length!==2||!expected.labels.every(label=>field.options!.some(option=>option.code===label)))return undefined;
  for(const message of messages) {
    const params=record(message.params),update=record(params['update']);
    if(params['sessionId']!==session||internalFrame(params,update))continue;
    const mapping=interaction(message,session,run,'independent-question-steer');
    if(mapping?.kind!=='question'||mapping.nativeToolName!=='AskUserQuestion'||mapping.vendorRequestId!==request.payload.vendorRequestId)continue;
    const questions=mapping.nativeInput['questions'],question=Array.isArray(questions)?record(questions[0]):{};
    const options=question['options'];
    if(!Array.isArray(questions)||questions.length!==1||question['question']!==expected.text||question['multiSelect']===true||!Array.isArray(options)||
      options.length!==2||!expected.labels.every(label=>options.some(option=>record(option)['label']===label)))continue;
    const bound=messages.some((candidate,index)=>{
      const params=record(candidate.params),update=record(params['update']);
      return candidate.method==='session/update'&&params['sessionId']===session&&update['sessionUpdate']==='tool_call'&&update['toolCallId']===mapping.toolCallId&&
        metaField(update['_meta'],'toolName')==='AskUserQuestion'&&ownedTool(params,index,run,owners);
    });
    if(bound) {
      let combined=mapping;
      // 同一原生工具的各请求通道必须一致，不能选取其中一个旧正文自动作答。
      for(const candidate of messages) {
        const params=record(candidate.params),update=record(params['update']),tool=record(params['toolCall']);
        const interruption=record(metaField(update['_meta'],'interruptionRequest'));
        if(params['sessionId']!==session||internalFrame(params,update)||internalFrame(params,tool)||
          interruption['isSubAgent']===true||interruption['isTeamMember']===true)continue;
        if(update['toolCallId']===mapping.toolCallId&&['completed','failed','cancelled'].includes(String(update['status'])))return undefined;
        const id=tool['toolCallId']??interruption['toolCallId']??params['toolCallId'];if(id!==mapping.toolCallId)continue;
        const next=interaction(candidate,session,run,'independent-question-steer'),merged=next?mergeInteraction(combined,next):undefined;
        if(!merged||merged.nativeToolName!=='AskUserQuestion')return undefined;combined=merged;
      }
      return combined;
    }
  }
  return undefined;
}

export async function formatterQuestionSteerExperiment(
  adapter:Pick<HarnessPort,'start'|'steer'|'answer'|'subscribe'>,
  connection:Pick<AcpConnection,'call'|'onMessage'>,sessionRef:string,timeoutMs=180000,outputMode:'formatter'|'native-text'='formatter',
):Promise<Record<string,unknown>> {
  const first=randomUUID(),second=randomUUID(),final=`CourierQuestionFinal-${randomUUID()}`,extra=`CourierQuestionExtra-${randomUUID()}`;
  const questions:Question[]=[{text:`CourierFirstQuestion-${first}`,labels:[`CourierFirstA-${first}`,`CourierFirstB-${first}`]},
    {text:`CourierSecondQuestion-${second}`,labels:[`CourierSecondA-${second}`,`CourierSecondB-${second}`]}];
  const messages:RpcMessage[]=[],events:HarnessEvent[]=[],controls:FormatterControl[]=[],answers:Answer[]=[];
  const deadline=Date.now()+timeoutMs,operationId=randomUUID(),previous=connection.onMessage,previousCall=connection.call;
  let runRef='',rawStop:string|undefined,overflow=false,bytes=0,wake:(()=>void)|undefined;
  const report:Record<string,unknown>={status:'unverified',outputMode,executionPermissionApprovals:0};
  const own=(event:HarnessEvent)=>event.sessionRef===sessionRef&&event.runRef===runRef;
  const proof=()=>proveSteerInputs({sessionRef,runRef,controls,messages});
  const ended=()=>events.some(event=>own(event)&&terminal(event));
  const rawPermission=()=>messages.some(message=>{
    const params=record(message.params),update=record(params['update']),tool=record(params['toolCall']);
    if(params['sessionId']!==sessionRef||internalFrame(params,update)||internalFrame(params,tool))return false;
    if(message.method==='session/request_permission')return metaField(tool['_meta'],'toolName')!=='AskUserQuestion';
    const interruption=record(metaField(update['_meta'],'interruptionRequest'));
    return message.method==='session/update'&&update['sessionUpdate']==='session_info_update'&&Object.keys(interruption).length>0&&
      interruption['isSubAgent']!==true&&interruption['isTeamMember']!==true&&interruption['toolName']!=='AskUserQuestion';
  });
  const forbidden=()=>rawPermission()||events.some(event=>own(event)&&event.eventType==='input.requested'&&event.payload.kind==='permission');
  const withdrawn=(request:Request)=>events.some(event=>own(event)&&event.eventType==='input.invalidated'&&event.payload.vendorRequestId===request.payload.vendorRequestId);
  const capture=(message:RpcMessage)=>{
    try{bytes+=Buffer.byteLength(JSON.stringify(message));}catch{overflow=true;}
    if(messages.length<4096&&bytes<=8388608)messages.push(message);else overflow=true;
    previous(message);wake?.();
  };
  const captureCall:AcpConnection['call']=(method,params,id,timeout)=>{
    const result=previousCall.call(connection,method,params,id,timeout);
    if(method==='session/prompt'&&id===operationId)void result.then(value=>{rawStop=string(record(value)['stopReason']);wake?.();}).catch(()=>{wake?.();});
    const control=method==='session/steer'?controls.find(item=>item.operationId===id):undefined;
    if(control){control.rawParams=params;void result.then(value=>{control.rawResult=value;wake?.();}).catch(()=>{});}
    const answer=method==='_codebuddy.ai/resolveInterruption'?answers.find(item=>item.operationId===id):undefined;
    if(answer) {
      const raw=record(params);
      answer.rawMatched=raw['sessionId']===sessionRef&&raw['toolCallId']===answer.mapping.toolCallId&&raw['decision']==='allow'&&
        Object.keys(record(raw['answers'])).length===1&&record(raw['answers'])['q_0']===questions[answers.indexOf(answer)]!.labels[1];
      void result.then(value=>{answer.rawAccepted=record(value)['resolved']===true&&record(value)['queued']===false;wake?.();}).catch(()=>{});
    }
    return result;
  };
  connection.onMessage=capture;connection.call=captureCall;
  const release=adapter.subscribe(sessionRef,event=>{if(events.length<4096)events.push(event);else overflow=true;wake?.();});
  const wait=async<T>(read:()=>T|undefined):Promise<T|undefined>=>{
    while(!overflow&&Date.now()<deadline){const value=read();if(value!==undefined)return value;
      let timer:NodeJS.Timeout|undefined;
      try{await new Promise<void>(resolve=>{wake=resolve;timer=setTimeout(resolve,Math.max(1,deadline-Date.now()));});}
      finally{if(timer)clearTimeout(timer);wake=undefined;}}
    return undefined;
  };
  try {
    const q=questions[0]!;
    const started=await adapter.start({operationId,inputId:randomUUID(),clientRunId:randomUUID(),sessionRef,
      text:`Use only the built-in AskUserQuestion to ask exactly: ${q.text}. Give two single-select options labelled ${q.labels[0]} and ${q.labels[1]}. `+
        (outputMode==='formatter'?`Wait for my answer. Then use ${formatterFullToolName} with kind="final" and text containing ${final} and my selected label. `:
          `Wait for my answer. Then reply in ordinary visible text containing ${final} and my selected label. `)+
        'Updates during this same Run override this original plan. Apply all compatible updates before the final response. '+
        (outputMode==='formatter'?'You may use ToolSearch for the formatter. ':'You may use ToolSearch only to discover the built-in question tool. ')+
        'Do not use other tools, read or write files, execute commands, contact the network, or change permission settings.'}).receipt;
    report['startAccepted']=started.status==='accepted'&&started.sessionRef===sessionRef&&!!started.runRef;
    if(started.status!=='accepted'||started.sessionRef!==sessionRef||!started.runRef)return report;runRef=started.runRef;
    for(let index=0;index<2;index++) {
      const request=await wait(()=>events.find((event):event is Request=>own(event)&&event.eventType==='input.requested'&&
        !answers.some(answer=>answer.request.payload.vendorRequestId===event.payload.vendorRequestId))??(ended()?false:undefined));
      if(!request||forbidden()||ended())return report;
      const mapping=matchQuestion(request,questions[index]!,messages,sessionRef,runRef,proof().owners);
      if(!mapping||withdrawn(request))return report;
      if(index===0)for(let update=0;update<2;update++) {
        if(forbidden()||ended()||overflow||withdrawn(request))return report;
        const q2=questions[1]!,text=update===0?
          `Update this same task: after my first answer, ask another built-in AskUserQuestion exactly: ${q2.text}. Use exactly two single-select options labelled ${q2.labels[0]} and ${q2.labels[1]}. Wait for my second answer before the final ${outputMode==='formatter'?'formatter call':'response'}, and include both selected labels in it.`:
          `Also append this exact marker to the same final ${outputMode==='formatter'?'formatter text':'response'}, after both questions have been answered: ${extra}. Preserve earlier updates.`;
        const control:FormatterControl={operationId:randomUUID(),inputId:randomUUID(),text,pendingAtDispatch:true,eventCursor:events.length,rawCursor:messages.length};
        controls.push(control);control.receipt=await adapter.steer({operationId:control.operationId,inputId:control.inputId,sessionRef,expectedRunRef:runRef,text}).receipt;
        if(control.receipt.status!=='accepted'||control.receipt.sessionRef!==sessionRef||control.receipt.runRef!==runRef)return report;
      }
      if(forbidden()||ended()||overflow||withdrawn(request))return report;
      const answer:Answer={mapping,request,operationId:randomUUID(),inputId:randomUUID(),cursor:messages.length};answers.push(answer);
      answer.receipt=await adapter.answer({operationId:answer.operationId,inputId:answer.inputId,sessionRef,runRef,vendorRequestId:mapping.vendorRequestId,
        answer:{kind:'form',values:{q_0:questions[index]!.labels[1]}}}).receipt;answer.acceptedCursor=messages.length;
      if(answer.receipt.status!=='accepted'||answer.receipt.sessionRef!==sessionRef||answer.receipt.runRef!==runRef||answer.receipt.vendorRequestId!==mapping.vendorRequestId)return report;
    }
    await wait(()=>ended()||forbidden()?true:undefined);if(ended())await wait(()=>rawStop!==undefined?true:undefined);
  }catch{report['error']='observation_unavailable';}
  finally {
    const native=proof(),questionTools=new Set(answers.map(answer=>answer.mapping.toolCallId)),resultDiagnostics:Record<string,unknown>[][]=[[],[]];
    const tools=new Map<string,{name:string|undefined;input?:{kind:'progress'|'final';text:string};result?:FormatterPayload;completed?:boolean;first?:number;end?:number}>();
    let conflict=false;
    for(const [index,message] of messages.entries()) {
      const params=record(message.params),update=record(params['update']),id=string(update['toolCallId']);
      if(message.method!=='session/update'||params['sessionId']!==sessionRef||internalFrame(params,update)||!id)continue;
      const qualified=ownedTool(params,index,runRef,native.owners),ref=requestRef(update)??requestRef(params);
      const question=answers.findIndex(answer=>answer.mapping.toolCallId===id);
      if(question>=0&&ref&&!qualified){conflict=true;continue;}
      if(question>=0&&update['status']==='completed'&&index>=answers[question]!.cursor) {
        const output=record(update['rawOutput']);
        if(resultDiagnostics[question]!.length>=8)overflow=true;
        else resultDiagnostics[question]!.push({frame:index,errorObserved:output['isError']===true||output['is_error']===true||!!output['error'],
          ...summarizeQuestionResult(update,questions[question]!.labels[1],questions[question]!.labels[0])});
      }
      if(update['sessionUpdate']==='tool_call'&&qualified&&!tools.has(id))tools.set(id,{name:string(metaField(update['_meta'],'toolName'))});
      const tool=tools.get(id);if(!tool)continue;
      if(ref&&!qualified){if(tool.name===formatterFullToolName)conflict=true;continue;}
      const name=string(metaField(update['_meta'],'toolName'));if(name&&name!==tool.name){conflict=true;continue;}
      if(tool.name!==formatterFullToolName)continue;
      const input=formatterInputSchema.safeParse(update['rawInput']);if(input.success){tool.input=input.data;if(input.data.kind==='final')tool.first??=index;}
      if(['failed','cancelled'].includes(String(update['status'])))conflict=true;
      if(update['status']!=='completed')continue;
      if(tool.completed&&update['rawInput']===undefined&&update['rawOutput']===undefined)continue;
      const result=decodeFormatterResult(update['rawOutput']);
      if(!result||!tool.input||result.kind!==tool.input.kind||result.text!==tool.input.text||tool.result&&result.text!==tool.result.text)conflict=true;
      else{tool.result=result;tool.completed=true;tool.end??=index;}
    }
    const finals=[...tools].filter(([,tool])=>tool.name===formatterFullToolName),parts=[final,questions[0]!.labels[1],questions[1]!.labels[1],extra];
    const expectedIds=answers.map(answer=>answer.request.payload.messageId),starts=events.filter((event):event is Extract<HarnessEvent,{eventType:'message.started'}>=>own(event)&&event.eventType==='message.started');
    const finalStart=starts.find(event=>event.payload.kind==='final'),nativeFinal=finals.length===1?finals[0]:undefined;
    const body=finalStart?events.filter((event):event is Extract<HarnessEvent,{eventType:'message.fragment'}>=>own(event)&&event.eventType==='message.fragment'&&event.payload.messageId===finalStart.payload.messageId):[];
    const complete=finalStart?events.filter(event=>own(event)&&event.eventType==='message.completed'&&event.payload.messageId===finalStart.payload.messageId):[];
    const end=events.filter(event=>own(event)&&terminal(event));
    const finalSourceMatched=starts.length===3&&starts.slice(0,2).every((event,index)=>event.payload.messageId===expectedIds[index]&&event.payload.kind==='question'&&event.payload.logicalOrder===index)&&
      finalStart?.payload.userVisible===true&&finalStart.payload.logicalOrder===2&&nativeFinal?.[1].completed===true&&nativeFinal[1].result?.kind==='final'&&
      finalStart.payload.messageId===`formatter:${nativeFinal[0]}`&&body.length===1&&body[0]!.payload.text===nativeFinal[1].result.text&&
      body[0]!.payload.fragmentKey===`${finalStart.payload.messageId}:snapshot`&&body[0]!.payload.fragmentIndex===0&&complete.length===1&&
      complete[0]!.eventType==='message.completed'&&complete[0]!.payload.finalFragmentIndex===0&&events.indexOf(finalStart)<events.indexOf(body[0]!)&&
      events.indexOf(body[0]!)<events.indexOf(complete[0]!)&&end.length===1&&events.indexOf(complete[0]!)<events.indexOf(end[0]!);
    const finalEffectsMatched=!!nativeFinal?.[1].result&&parts.every(part=>nativeFinal[1].result!.text.includes(part));
    const finalMatched=finalSourceMatched&&finalEffectsMatched;
    const resultsMatched=answers.length===2&&resultDiagnostics.every(results=>results.some(result=>result['selectedLabelPresent']===true&&result['unselectedLabelPresent']===false)&&
      results.every(result=>result['source']==='missing'||result['errorObserved']===false&&result['bounded']===true&&result['selectedLabelPresent']===true&&result['unselectedLabelPresent']===false));
    const ordinary=new Map<string,{text:string;first:number}>();let ordinaryConflict=false,unboundOrdinary=0;
    if(outputMode==='native-text')for(const [index,message] of messages.entries()){
      const params=record(message.params),update=record(params['update']),content=record(update['content']);
      if(message.method!=='session/update'||params['sessionId']!==sessionRef||internalFrame(params,update)||
        !['agent_message_chunk','assistant_message_chunk'].includes(String(update['sessionUpdate'])))continue;
      if(!ownedTool(params,index,runRef,native.owners)){unboundOrdinary++;continue;}
      const metadataId=string(metaField(update['_meta'],'messageId')),directId=string(update['messageId']),id=metadataId??directId;
      if(metadataId&&directId&&metadataId!==directId){ordinaryConflict=true;continue;}
      if(!id||content['type']!=='text'||typeof content['text']!=='string'){ordinaryConflict=true;continue;}
      if(!ordinary.has(id)&&ordinary.size>=128){overflow=true;continue;}
      const value=ordinary.get(id)??{text:'',first:index};value.text+=content['text'];
      if(value.text.length>65536){overflow=true;continue;}ordinary.set(id,value);
    }
    const ordinaryChecks=[...ordinary].map(([id,value])=>{
      const start=starts.filter(event=>event.payload.messageId===id&&event.payload.kind==='message'&&event.payload.userVisible);
      const body=events.filter((event):event is Extract<HarnessEvent,{eventType:'message.fragment'}>=>own(event)&&event.eventType==='message.fragment'&&event.payload.messageId===id);
      const closed=events.filter((event):event is Extract<HarnessEvent,{eventType:'message.completed'}>=>own(event)&&event.eventType==='message.completed'&&event.payload.messageId===id);
      const afterResults=resultsMatched&&resultDiagnostics.every(results=>results.some(result=>typeof result['frame']==='number'&&result['frame']<value.first&&result['selectedLabelPresent']===true));
      const source=afterResults&&!ordinaryConflict&&start.length===1&&body.length>0&&body.every((event,index)=>event.payload.fragmentIndex===index)&&
        body.map(event=>event.payload.text).join('')===value.text&&closed.length===1&&closed[0]!.payload.finalFragmentIndex===body.length-1&&
        events.indexOf(start[0]!)<events.indexOf(body[0]!)&&events.indexOf(body.at(-1)!)<events.indexOf(closed[0]!)&&
        end.length===1&&events.indexOf(closed[0]!)<events.indexOf(end[0]!);
      return {source,effects:parts.every(part=>value.text.includes(part)),parts:parts.map(part=>value.text.includes(part))};
    });
    const answersMatched=answers.length===2&&answers.every(answer=>answer.rawMatched&&answer.rawAccepted&&answer.receipt?.status==='accepted'&&
      events.some(event=>own(event)&&event.eventType==='input.accepted'&&event.payload.operationId===answer.operationId&&event.payload.inputId===answer.inputId));
    const controlsMatched=native.receiptsMatched&&!native.conflict&&controls.length===2&&controls.every(control=>{
      const prior=events.slice(0,control.eventCursor),first=answers[0]?.request;
      return control.pendingAtDispatch&&Number.isInteger(control.eventCursor)&&control.eventCursor>=0&&control.eventCursor<=events.length&&!!first&&
        prior.includes(first)&&prior.some(event=>own(event)&&event.eventType==='message.completed'&&event.payload.messageId===first.payload.messageId)&&
        !prior.some(event=>own(event)&&(terminal(event)||event.eventType==='input.invalidated'&&event.payload.vendorRequestId===first.payload.vendorRequestId))&&
        native.applied.has(control.inputId)&&events.some(event=>own(event)&&event.eventType==='input.applied'&&event.payload.inputId===control.inputId);
    });
    const unexpectedTools=[...tools].filter(([id,tool])=>!(outputMode==='formatter'&&tool.name===formatterFullToolName)&&tool.name!=='ToolSearch'&&!questionTools.has(id)).length;
    Object.assign(report,{traceComplete:!overflow&&Date.now()<=deadline,rawFrames:messages.length,controlCalls:controls.length,answerCalls:answers.length,
      controlProofsMatched:controlsMatched,answerReceiptsMatched:answersMatched,nativeQuestionResults:resultDiagnostics,nativeQuestionResultsMatched:resultsMatched,
      finalPartMatches:finals.filter(([,tool])=>tool.result).map(([,tool])=>parts.map(part=>tool.result!.text.includes(part))),
      finalTiming:finals.map(([,tool])=>({firstParsableFrame:tool.first??null,completedFrame:tool.end??null,answerDispatchFrames:answers.map(answer=>answer.cursor),answerAcceptedFrames:answers.map(answer=>answer.acceptedCursor??null)})),
      originalRunCompleted:end.length===1&&end[0]?.eventType==='run.completed'&&end[0].payload.stopReason==='end_turn',
      rawPromptStop:rawStop&&['end_turn','cancelled','failed','refusal','max_tokens','max_turn_requests'].includes(rawStop)?rawStop:'not_observed',
      finalIdentitiesAndBodiesMatched:finalSourceMatched===true,finalEffectsMatched,unexpectedTools,nativeExecutionPermissionObserved:rawPermission(),
      ...(outputMode==='native-text'?{ordinaryIdentitiesAndBodiesMatched:ordinaryChecks.some(value=>value.source),ordinaryEffectsMatched:ordinaryChecks.some(value=>value.effects),
        ordinaryPartMatches:ordinaryChecks.map(value=>value.parts),unboundOrdinaryFrames:unboundOrdinary}:{}),
      permissionRequests:events.filter(event=>own(event)&&event.eventType==='input.requested'&&event.payload.kind==='permission').length});
    const outputMatched=outputMode==='formatter'?finalMatched:ordinaryChecks.some(value=>value.source&&value.effects);
    if(report['traceComplete']&&controlsMatched&&answersMatched&&resultsMatched&&outputMatched&&!conflict&&unexpectedTools===0&&
      events.filter(event=>own(event)&&event.eventType==='input.requested').length===2&&!forbidden()&&report['originalRunCompleted']&&rawStop==='end_turn')report['status']='observed';
    release();if(connection.onMessage===capture)connection.onMessage=previous;if(connection.call===captureCall)connection.call=previousCall;
  }
  return report;
}
