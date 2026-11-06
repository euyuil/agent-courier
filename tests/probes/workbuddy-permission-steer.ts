import { randomUUID } from 'node:crypto';
import type { HarnessPort,Receipt } from '../../src/adapters/harness/port.js';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';
import type { AcpConnection,RpcMessage } from '../../src/adapters/workbuddy-experimental/connection.js';
import { record,string,requestRef,metaField,internalFrame } from '../../src/adapters/workbuddy-experimental/metadata.js';
import { formatterFullToolName,formatterInputSchema,decodeFormatterResult } from '../../src/adapters/workbuddy-experimental/formatter.js';
import { proveSteerInputs,type FormatterControl } from './workbuddy-formatter-steer.js';
import { prepareOwnedDenial } from './workbuddy-acp-permission.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectWorkBuddy } from '../../src/adapters/workbuddy-experimental/factory.js';
import { assertOutsideRepository } from '../../src/config/private.js';
import { privateDirectory } from '../../src/storage/private-state.js';
import { acquireInstanceLock } from '../../src/storage/instance-lock.js';
import { openDatabase,type Connection } from '../../src/storage/database.js';
import { migrate } from '../../src/storage/migrate.js';
import { adapterMappings } from '../../src/storage/adapter-mappings.js';

type Request=Extract<HarnessEvent,{eventType:'input.requested'}>;
const terminal=(event:HarnessEvent)=>['run.completed','run.failed','connection.lost'].includes(event.eventType);
function progressEffects(messages:RpcMessage[],events:HarnessEvent[],sessionRef:string,runRef:string,controls:FormatterControl[],markers:string[]) {
  const proof=proveSteerInputs({messages,sessionRef,runRef,controls});
  const tools=new Map<string,{text?:string;done?:number}>();let conflict=false;
  for(const [index,message] of messages.entries()){
    const params=record(message.params),update=record(params['update']),id=string(update['toolCallId']);
    if(message.method!=='session/update'||params['sessionId']!==sessionRef||!id||internalFrame(params,update))continue;
    const ref=requestRef(update)??requestRef(params),known=(value:unknown)=>typeof value==='string'&&proof.owners.has(value)&&proof.owners.get(value)!<index;
    const references=[update['requestId'],metaField(update['_meta'],'conversationRequestId'),metaField(update['_meta'],'requestId')].filter(value=>value!==undefined);
    const owned=known(ref)&&references.every(known)&&metaField(update['_meta'],'messageRequestId')===runRef;
    if(update['sessionUpdate']==='tool_call'&&metaField(update['_meta'],'toolName')===formatterFullToolName&&owned&&!tools.has(id))tools.set(id,{});
    const tool=tools.get(id);if(!tool)continue;
    if(ref&&!owned){conflict=true;continue;}
    const name=metaField(update['_meta'],'toolName');if(name!==undefined&&name!==formatterFullToolName){conflict=true;continue;}
    const input=formatterInputSchema.safeParse(update['rawInput']);if(input.success){if(input.data.kind!=='progress')conflict=true;tool.text=input.data.text;}
    if(['failed','cancelled'].includes(String(update['status'])))conflict=true;
    if(update['status']!=='completed'||tool.done!==undefined&&update['rawOutput']===undefined&&update['rawInput']===undefined)continue;
    const result=decodeFormatterResult(update['rawOutput']);
    if(!result||result.kind!=='progress'||result.text!==tool.text)conflict=true;else tool.done??=index;
  }
  const effects=markers.map((marker,index)=>{
    const matches=[...tools].filter(([,tool])=>tool.text===marker&&tool.done!==undefined);
    if(matches.length!==1)return false;
    const [toolId,tool]=matches[0]!,id=`formatter:${toolId}`,control=controls[index],injection=control?proof.injections.get(control.inputId):undefined;
    const own=events.filter(event=>event.sessionRef===sessionRef&&event.runRef===runRef);
    const start=own.filter(event=>event.eventType==='message.started'&&event.payload.messageId===id&&event.payload.kind==='progress'&&event.payload.userVisible);
    const body=own.filter(event=>event.eventType==='message.fragment'&&event.payload.messageId===id);
    const end=own.filter(event=>event.eventType==='message.completed'&&event.payload.messageId===id);
    return !!control&&injection!==undefined&&injection<tool.done!&&start.length===1&&body.length===1&&end.length===1&&
      body[0]!.eventType==='message.fragment'&&body[0]!.payload.text===marker&&body[0]!.payload.fragmentIndex===0&&
      body[0]!.payload.fragmentKey===`${id}:snapshot`&&end[0]!.eventType==='message.completed'&&end[0]!.payload.finalFragmentIndex===0&&
      own.indexOf(start[0]!)<own.indexOf(body[0]!)&&own.indexOf(body[0]!)<own.indexOf(end[0]!);
  });
  return {effects,proof,conflict};
}
export async function permissionSteerExperiment(adapter:Pick<HarnessPort,'start'|'steer'|'answer'|'subscribe'>,
  connection:Pick<AcpConnection,'call'|'onMessage'>,sessionRef:string,timeoutMs=120000):Promise<Record<string,unknown>> {
  const command=`python3 -I -S -c "print('CourierPermission-${randomUUID()}')"`,operationId=randomUUID();
  const markers=[`CourierPermissionSteerA-${randomUUID()}`,`CourierPermissionSteerB-${randomUUID()}`],events:HarnessEvent[]=[],messages:RpcMessage[]=[],controls:FormatterControl[]=[];
  const deadline=Date.now()+timeoutMs,previous=connection.onMessage,previousCall=connection.call;
  let runRef='',bytes=0,overflow=false,promptSettled=false,rawStop:string|undefined,wake:(()=>void)|undefined;
  let original:Request|undefined,prepared:ReturnType<typeof prepareOwnedDenial>,denial:Receipt|undefined,denialCursor=-1,denialId='',denialInput='';
  let rawDenialMatched=false,rawDenialAccepted=false,effectsBeforeDenial:boolean[]=[];
  const report:Record<string,unknown>={status:'unverified',executionPermissionApprovals:0};
  const own=(event:HarnessEvent)=>event.sessionRef===sessionRef&&event.runRef===runRef;
  const ended=()=>promptSettled||events.some(event=>own(event)&&terminal(event));
  const pending=(request:Request)=>!ended()&&!events.some(event=>own(event)&&event.eventType==='input.invalidated'&&event.payload.vendorRequestId===request.payload.vendorRequestId);
  const unsafe=()=>overflow||events.some(event=>own(event)&&event.eventType==='input.requested'&&event!==original)||messages.some(message=>{
    const params=record(message.params),update=record(params['update']);if(params['sessionId']!==sessionRef||internalFrame(params,update))return false;
    const name=metaField(update['_meta'],'toolName'),tool=string(update['toolCallId']);
    if(update['sessionUpdate']==='tool_call'&&typeof name==='string'&&!['Bash','ToolSearch',formatterFullToolName].includes(name))return true;
    if(prepared&&update['sessionUpdate']==='tool_call'&&name==='Bash'&&tool!==prepared.toolCallId)return true;
    const requestTool=record(params['toolCall']),broadcast=record(metaField(update['_meta'],'interruptionRequest'));
    if(prepared&&(message.method==='session/request_permission'&&requestTool['toolCallId']!==prepared.toolCallId||
      Object.keys(broadcast).length>0&&broadcast['toolCallId']!==prepared.toolCallId))return true;
    return !!prepared&&tool===prepared.toolCallId&&update['status']==='completed';
  });
  const capture=(message:RpcMessage)=>{
    try{bytes+=Buffer.byteLength(JSON.stringify(message));}catch{overflow=true;}
    if(messages.length<4096&&bytes<=8388608)messages.push(message);else overflow=true;previous(message);wake?.();
  };
  const captureCall:AcpConnection['call']=(method,params,id,timeout)=>{
    const result=previousCall.call(connection,method,params,id,timeout);
    if(method==='session/prompt'&&id===operationId)void result.then(value=>{promptSettled=true;rawStop=string(record(value)['stopReason']);wake?.();}).catch(()=>{promptSettled=true;wake?.();});
    const control=method==='session/steer'?controls.find(item=>item.operationId===id):undefined;
    if(control){control.rawParams=params;void result.then(value=>{control.rawResult=value;wake?.();}).catch(()=>{wake?.();});}
    if(method==='_codebuddy.ai/resolveInterruption'&&id===denialId){
      const raw=record(params);rawDenialMatched=raw['sessionId']===sessionRef&&raw['toolCallId']===prepared?.toolCallId&&raw['decision']==='deny';
      void result.then(value=>{rawDenialAccepted=record(value)['resolved']===true&&record(value)['queued']===false;wake?.();}).catch(()=>{wake?.();});
    }return result;
  };
  connection.onMessage=capture;connection.call=captureCall;
  const unsubscribe=adapter.subscribe(sessionRef,event=>{if(events.length<4096)events.push(event);else overflow=true;wake?.();});
  const wait=async<T>(read:()=>T|undefined,until=deadline):Promise<T|undefined>=>{
    while(!overflow&&Date.now()<until){const value=read();if(value!==undefined)return value;let timer:NodeJS.Timeout|undefined;
      try{await new Promise<void>(resolve=>{wake=resolve;timer=setTimeout(resolve,Math.max(1,until-Date.now()));});}
      finally{if(timer)clearTimeout(timer);wake=undefined;}}
    return undefined;
  };
  try {
    const mode=record(await connection.call('session/set_config_option',{sessionId:sessionRef,configId:'mode',value:'default'},randomUUID()));
    report['defaultModeConfirmed']=Array.isArray(mode['configOptions'])&&mode['configOptions'].some(raw=>record(raw)['id']==='mode'&&record(raw)['currentValue']==='default');
    if(!report['defaultModeConfirmed'])return report;
    const start=await adapter.start({operationId,inputId:randomUUID(),clientRunId:randomUUID(),sessionRef,
      text:`Call Bash exactly once with this harmless command: ${command}. Wait for the Harness execution-permission decision. `+
        'Do not ask for permission in ordinary text or AskUserQuestion. If denied, stop without retries or substitute commands. '+
        'Do not read or write files, contact the network, change permission settings or use any other tool unless a later update asks for the configured pure output formatter.'}).receipt;
    if(start.status!=='accepted'||start.sessionRef!==sessionRef||!start.runRef)return report;runRef=start.runRef;
    const request=await wait(()=>events.find((event):event is Request=>own(event)&&event.eventType==='input.requested'&&event.payload.kind==='permission')??(ended()?false:undefined));
    if(!request)return report;original=request;prepared=prepareOwnedDenial(messages,original,sessionRef,runRef,command);
    report['permissionMatched']=!!prepared;if(!prepared||unsafe()||!pending(original))return report;
    for(const marker of markers){
      if(unsafe()||!pending(original))return report;
      const text=`Supplement this same current Run while its original Bash execution permission remains unanswered: publish one progress message with exactly this text using ${formatterFullToolName}: ${marker}. `+
        'Keep the original Bash command and permission request unchanged and unanswered. Do not execute another command or ask another question. Preserve compatible earlier updates. You may use ToolSearch only to locate the configured pure formatter.';
      const control:FormatterControl={operationId:randomUUID(),inputId:randomUUID(),text,pendingAtDispatch:true,eventCursor:events.length,rawCursor:messages.length};controls.push(control);
      control.receipt=await adapter.steer({operationId:control.operationId,inputId:control.inputId,text,sessionRef,expectedRunRef:runRef}).receipt;
      if(control.receipt.status!=='accepted'||control.receipt.sessionRef!==sessionRef||control.receipt.runRef!==runRef)return report;
    }
    await wait(()=>unsafe()||!pending(original!)||progressEffects(messages,events,sessionRef,runRef,controls,markers).effects.every(Boolean)?true:undefined,
      Math.min(deadline,Date.now()+30000));
    if(unsafe()||!pending(original))return report;
    // 即使效果缺证，也只拒绝这一份已核对且仍有效的原权限，结束自有实验；不批准或重试。
    if(!prepareOwnedDenial(messages,original,sessionRef,runRef,command))return report;
    effectsBeforeDenial=progressEffects(messages,events,sessionRef,runRef,controls,markers).effects;denialCursor=messages.length;
    denialId=randomUUID();denialInput=randomUUID();
    denial=await adapter.answer({operationId:denialId,inputId:denialInput,sessionRef,runRef,vendorRequestId:original.payload.vendorRequestId,
      answer:{kind:'permission',decision:'deny',optionCode:prepared.optionCode}}).receipt;
    if(denial.status!=='accepted'||denial.sessionRef!==sessionRef||denial.runRef!==runRef||denial.vendorRequestId!==original.payload.vendorRequestId)return report;
    await wait(()=>events.some(event=>own(event)&&terminal(event))&&rawStop!==undefined?true:undefined);
  }catch{report['error']='permission_steer_observation_unavailable';}
  finally {
    const result=progressEffects(messages.slice(0,denialCursor<0?messages.length:denialCursor),events,sessionRef,runRef,controls,markers);
    const controlsMatched=result.proof.receiptsMatched&&!result.proof.conflict&&!result.conflict&&controls.length===2&&controls.every(control=>{
      const prior=events.slice(0,control.eventCursor);
      return control.pendingAtDispatch&&!!original&&prior.includes(original)&&!prior.some(event=>own(event)&&(terminal(event)||
        event.eventType==='input.invalidated'&&event.payload.vendorRequestId===original!.payload.vendorRequestId))&&
        result.proof.applied.has(control.inputId)&&events.some(event=>own(event)&&event.eventType==='input.applied'&&event.payload.inputId===control.inputId);
    });
    const denialMatched=denial?.status==='accepted'&&rawDenialMatched&&rawDenialAccepted&&events.some(event=>own(event)&&event.eventType==='input.accepted'&&event.payload.operationId===denialId&&event.payload.inputId===denialInput);
    const cancellation=rawStop==='cancelled'&&events.some(event=>own(event)&&event.eventType==='run.failed');
    Object.assign(report,{traceComplete:!overflow&&Date.now()<=deadline,rawFrames:messages.length,controlCalls:controls.length,denialCalls:denialId?1:0,
      controlProofsMatched:controlsMatched,effectsBeforeDenial,effectsMatched:effectsBeforeDenial.length===2&&effectsBeforeDenial.every(Boolean),
      denialMatched,originalRunCancelled:cancellation,rawPromptStop:rawStop&&['end_turn','cancelled','failed','refusal'].includes(rawStop)?rawStop:'not_observed'});
    if(!report['error']&&report['traceComplete']&&controlsMatched&&report['effectsMatched']&&denialMatched&&cancellation)report['status']='observed';
    unsubscribe();if(connection.onMessage===capture)connection.onMessage=previous;if(connection.call===captureCall)connection.call=previousCall;
  }return report;
}
export async function automaticPermissionSteerExperiment(desktopDebugUrl:string,workspace:string):Promise<Record<string,unknown>> {
  const report:Record<string,unknown>={status:'unverified',executionPermissionApprovals:0,dingtalkSends:0};
  let db:Connection|undefined,release:(()=>void)|undefined,connected:Awaited<ReturnType<typeof connectWorkBuddy>>|undefined;
  const namespace='independent-permission-steer';
  try {
    assertOutsideRepository(workspace);privateDirectory(workspace);privateDirectory(join(workspace,'.codebuddy'));
    writeFileSync(join(workspace,'.codebuddy','settings.local.json'),JSON.stringify({permissions:{ask:['Bash']}}),{mode:0o600,flag:'wx'});
    const databasePath=join(workspace,'permission-steer.sqlite');release=acquireInstanceLock(databasePath);db=openDatabase(databasePath);migrate(db);
    const store=adapterMappings(db,namespace);
    const profile={cwd:workspace,cliVersion:null,bootstrapPermissionMode:'default' as const,authorizationScope:['execution-permission-mode:default','project:Bash:ask'],
      desktopDebugUrl,ownership:{mode:'courier-exclusive' as const},output:{mode:'courier-formatter' as const,contractVersion:1 as const}};
    connected=await connectWorkBuddy({profile,store,instanceId:namespace,evidence:[]});
    const probe=await connected.adapter.probe(namespace);if(probe.cliVersion)report['cliVersion']=probe.cliVersion;
    report['requiredCapabilitiesUnverified']=['typedVisibleOutput','messageAssembly','humanInteraction'].every(name=>probe.capabilities[name as keyof typeof probe.capabilities]==='unverified');
    store.set('probe-context',{status:'dispatching'});
    const receipt=await connected.adapter.createSession({operationId:randomUUID(),courierSessionId:randomUUID()}).receipt;
    const bootstrap=record(store.get('desktop-host'))['sessionRef'];
    if(receipt.status!=='accepted'||!receipt.receiptEvidence||receipt.sessionRef===bootstrap)return report;
    store.set('probe-context',{status:'created',sessionRef:receipt.sessionRef});report['distinctOwnedHarnessSession']=true;
    await connected.adapter.disconnect(namespace);
    connected=await connectWorkBuddy({profile,store,instanceId:namespace,evidence:[],contextSessionRef:receipt.sessionRef});
    store.set('probe-context-load',{status:'dispatching',sessionRef:receipt.sessionRef});
    const loaded=await connected.adapter.resumeSession({operationId:randomUUID(),sessionRef:receipt.sessionRef}).receipt;
    report['dedicatedOriginalContextLoaded']=loaded.status==='accepted'&&loaded.sessionRef===receipt.sessionRef;
    if(report['dedicatedOriginalContextLoaded']!==true)return report;
    store.set('probe-context-load',{status:'accepted',sessionRef:receipt.sessionRef});
    const observed=await permissionSteerExperiment(connected.adapter,connected.connection,receipt.sessionRef);
    return {...report,...observed};
  }catch{return {...report,error:'automatic_permission_steer_unavailable'};}
  finally{await connected?.adapter.disconnect(namespace).catch(()=>{});db?.close();release?.();}
}
