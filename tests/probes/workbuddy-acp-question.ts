import { randomUUID } from 'node:crypto';
import type { HarnessPort,Receipt } from '../../src/adapters/harness/port.js';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';

const receiptSummary=(receipt:Receipt)=>receipt.status==='accepted'?{status:receipt.status}:{status:receipt.status,code:receipt.errorCode};
const terminal=(event:HarnessEvent)=>['run.completed','run.failed','connection.lost'].includes(event.eventType);

export async function acpQuestionExperiment(adapter:Pick<HarnessPort,'start'|'answer'|'subscribe'>,sessionRef:string,timeoutMs=90000):Promise<Record<string,unknown>> {
  const suffix=randomUUID(),labels=[`CourierA-${suffix}`,`CourierB-${suffix}`],questionText=`CourierQuestion-${suffix}`;
  const events:HarnessEvent[]=[];let overflow=false,wake:(()=>void)|undefined;
  const deadline=Date.now()+timeoutMs;
  const unsubscribe=adapter.subscribe(sessionRef,event=>{if(events.length<2048)events.push(event);else overflow=true;wake?.();});
  const waitFor=async(predicate:(event:HarnessEvent)=>boolean)=>{
    while(!overflow&&Date.now()<deadline) {
      const event=events.find(predicate);if(event)return event;
      let timer:NodeJS.Timeout|undefined;
      try {await new Promise<void>(resolve=>{wake=resolve;timer=setTimeout(resolve,Math.max(1,deadline-Date.now()));});}
      finally{if(timer)clearTimeout(timer);wake=undefined;}
    }
    return undefined;
  };
  const report:Record<string,unknown>={status:'unverified',executionPermissionApprovals:0,answerCalls:0};
  try {
    const started=await adapter.start({sessionRef,operationId:randomUUID(),inputId:randomUUID(),clientRunId:randomUUID(),
      text:`Use only the built-in AskUserQuestion tool to ask exactly this one question: ${questionText}. `+
        `Give exactly two single-select options labelled ${labels[0]} and ${labels[1]}. `+
        'Do not call any other tools, read or write files, execute commands or contact the network. '+
        'Wait for my answer, then reply only with the selected label.'}).receipt;
    report['start']=receiptSummary(started);
    if(started.status!=='accepted'||started.sessionRef!==sessionRef||!started.runRef)return report;
    const own=(event:HarnessEvent)=>event.sessionRef===sessionRef&&event.runRef===started.runRef;
    const first=await waitFor(event=>own(event)&&(event.eventType==='input.requested'||terminal(event)));
    const schema=first?.eventType==='input.requested'?first.payload.answerSchema:undefined;
    const field=schema?.mode==='form'?schema.fields[0]:undefined;
    const valid=first?.eventType==='input.requested'&&first.payload.kind==='question'&&schema?.mode==='form'&&schema.fields.length===1&&
      field?.fieldId==='q_0'&&field.required&&field.valueType==='choice'&&field.label===questionText&&field.options?.length===2&&
      labels.every(label=>field.options!.some(option=>option.code===label));
    report['questionObserved']=valid===true;
    if(!valid||!first||first.eventType!=='input.requested')return report;
    if(overflow||events.some(event=>own(event)&&(terminal(event)||event.eventType==='input.invalidated'&&
      event.payload.vendorRequestId===first.payload.vendorRequestId||event.eventType==='input.requested'&&event.payload.kind==='permission')))return report;
    const cursor=events.length,operationId=randomUUID(),inputId=randomUUID();report['answerCalls']=1;
    const answered=await adapter.answer({sessionRef,runRef:started.runRef,vendorRequestId:first.payload.vendorRequestId,operationId,inputId,
      answer:{kind:'form',values:{q_0:labels[1]!}}}).receipt;
    report['answer']=receiptSummary(answered);
    if(answered.status!=='accepted'||answered.sessionRef!==sessionRef||answered.runRef!==started.runRef||
      answered.vendorRequestId!==first.payload.vendorRequestId)return report;
    const end=await waitFor(event=>own(event)&&terminal(event));
    report['completion']=end?.eventType??'not_observed';
    report['stopReason']=end?.eventType==='run.completed'?end.payload.stopReason:'not_observed';
    report['answerAcceptedEvent']=events.some(event=>own(event)&&event.eventType==='input.accepted'&&
      event.payload.operationId===operationId&&event.payload.inputId===inputId);
    report['permissionRequests']=events.filter(event=>own(event)&&event.eventType==='input.requested'&&event.payload.kind==='permission').length;
    const messages=new Map<string,string>();
    for(const event of events.slice(cursor))if(own(event)&&event.eventType==='message.fragment'&&event.payload.messageId!==first.payload.messageId) {
      const text=(messages.get(event.payload.messageId)??'')+event.payload.text;
      if(text.length>65536){overflow=true;break;}messages.set(event.payload.messageId,text);
    }
    report['selectedChoiceObserved']=[...messages.values()].some(text=>text.trim()===labels[1]);
    if(!overflow&&report['completion']==='run.completed'&&report['stopReason']==='end_turn'&&report['answerAcceptedEvent']===true&&
      report['selectedChoiceObserved']===true&&report['permissionRequests']===0)report['status']='observed';
    return report;
  }catch{return {...report,status:'unknown'};}
  finally{unsubscribe();}
}
