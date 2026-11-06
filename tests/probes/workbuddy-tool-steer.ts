import { readFileSync,readlinkSync,readdirSync } from 'node:fs';
import { basename,join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AcpConnection } from '../../src/adapters/workbuddy-experimental/connection.js';
import { WorkBuddySteering } from '../../src/adapters/workbuddy-experimental/steer.js';
import { WorkBuddyRunReferences } from '../../src/adapters/workbuddy-experimental/run-references.js';
import { record,string,requestRef,internalFrame,newRequestRef,metaField } from '../../src/adapters/workbuddy-experimental/metadata.js';
import { safeCode } from '../../src/domain/errors.js';
import { ownRuntimeEndpoints,identifyOwnAcpTransport } from './workbuddy-acp.js';
import { WorkBuddyTrace } from './workbuddy-trace.js';

interface Diagnostic {evaluate(expression:string,timeout?:number):Promise<unknown>}
export function ownSyntheticToolRunning(cwd:string,seconds:string,procRoot='/proc'):boolean {
  if(!cwd||!/^(?:[1-9]|[1-5][0-9]|60)$/.test(seconds))return false;let matches=0;
  try {
    for(const pid of readdirSync(procRoot).filter(name=>/^\d+$/.test(name)))try {
      const p=join(procRoot,pid),comm=readFileSync(join(p,'comm'),'utf8').trim();
      if(comm!=='sleep'||resolve(readlinkSync(join(p,'cwd')))!==resolve(cwd))continue;
      const args=readFileSync(join(p,'cmdline'),'utf8').split('\0');if(args.at(-1)==='')args.pop();
      if(args.length===2&&basename(args[0]!)==='sleep'&&args[1]===seconds)matches++;
    }catch{/* 已退出、其他目录或不可读取的进程不提供本次合成任务依据。 */}
  }catch{return false;}
  return matches===1;
}
interface ToolScope {matched:boolean;other:boolean;reasons:string[];toolNames:string[]}
function commandForms(command:string,cwd:string):string[] {
  const forms=[command];
  if(cwd) {
    const single="'"+cwd.replaceAll("'","'\\''")+"'";
    const double='"'+cwd.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('$','\\$').replaceAll('`','\\`')+'"';
    const directories=[single,double,...(/^[A-Za-z0-9_./-]+$/.test(cwd)?[cwd]:[])];
    for(const directory of directories)for(const prefix of ['cd ','cd -- '])forms.push(`${prefix}${directory} && ${command}`);
  }
  return forms.flatMap(value=>[value,`${value};`]);
}
function toolScope(events:unknown[],owner:string,run:string,command:string,cwd=''):ToolScope {
  const frames=events.map(record).filter(params=>params['sessionId']===owner&&!internalFrame(params,record(params['update']))),ids=new Set<string>();
  let other=false,matched=false;const reasons=new Set<string>(),toolNames=new Set<string>(),knownNames=new Set(['Bash','Read','Write','Edit','TodoWrite','AskUserQuestion','Task','Skill']);
  const commands=commandForms(command,cwd);
  const nameObserved=(value:unknown)=>{if(typeof value==='string')toolNames.add(knownNames.has(value)?value:'unknown');};
  for(const params of frames) {
    const u=record(params['update']);if(u['sessionUpdate']!=='tool_call')continue;
    const name=metaField(u['_meta'],'toolName'),ref=requestRef(u)??requestRef(params),id=string(u['toolCallId']);
    nameObserved(name);
    if(typeof name==='string'&&name!=='Bash'){other=true;reasons.add('tool_name');continue;}
    if(ref!==undefined&&ref!==run){other=true;reasons.add('run_reference');continue;}
    if(name==='Bash'&&ref===run&&id)ids.add(id);
  }
  for(const params of frames) {
    const u=record(params['update']);if(!['tool_call','tool_call_update'].includes(String(u['sessionUpdate'])))continue;
    const id=string(u['toolCallId']);if(!id||!ids.has(id))continue;
    const ref=requestRef(u)??requestRef(params),name=metaField(u['_meta'],'toolName'),input=record(u['rawInput'])['command'];
    nameObserved(name);
    if(ref!==undefined&&ref!==run){other=true;reasons.add('run_reference');continue;}
    if(typeof name==='string'&&name!=='Bash'){other=true;reasons.add('tool_name');continue;}
    if(typeof input==='string'){const body=input.trim();if(commands.includes(body))matched=true;
      else if(!commands.some(candidate=>candidate.startsWith(body))){other=true;reasons.add('command_mismatch');}}
  }
  if(ids.size>1){other=true;reasons.add('multiple_tools');}
  return {matched:matched&&ids.size===1,other,reasons:[...reasons],toolNames:[...toolNames]};
}
export function originalLongToolReady(value:unknown,owner:string,run:string,command:string,cwd=''):boolean {
  const state=record(value);if(!owner||!run||!command||state['sessionId']!==owner||state['isProcessing']!==true||state['returned']!==false||
    state['failed']!==false||state['pendingPermissions']!==0||state['pendingQuestions']!==0||!Array.isArray(state['events']))return false;
  const scope=toolScope(state['events'],owner,run,command,cwd);return scope.matched&&!scope.other;
}
interface Control {inputId:string;operationId:string;marker:string;requested:boolean;receipt:string;receiptMs?:number;code?:string;
  processBefore:boolean;processAfter:boolean;applied:boolean;pendingObserved:boolean;pendingCheck?:Promise<boolean>}
export async function toolSteerExperiment(diagnostic:Diagnostic,cwd:string):Promise<Record<string,unknown>> {
  const owner=await diagnostic.evaluate(`(async()=>{const p=globalThis.__courierCapabilityProbe;if(typeof p?.sessionId!=='string')return;
    const s=await globalThis.__wbInvoke('session:get',{},p.sessionId);
    return !s?.__wbError&&s?.sessionId===p.sessionId&&s?.cwd===${JSON.stringify(cwd)}&&s?.isProcessing===false&&
      s?.config?.permissionMode==='default'?p.sessionId:undefined;})()`);
  if(typeof owner!=='string')return {status:'original_owner_or_permission_mode_unverified'};
  const runtime=ownRuntimeEndpoints(cwd,'/proc',owner),identified=await identifyOwnAcpTransport(runtime.endpoints);
  if(!identified.endpoint)return {status:'endpoint_unverified'};
  const run=newRequestRef(),originalMarker=`CourierToolResult-${randomUUID()}`,seconds='12',command=`sleep ${seconds}`;
  const controls:Control[]=[0,1].map(index=>({inputId:randomUUID(),operationId:randomUUID(),marker:`CourierToolChange-${index}-${randomUUID()}`,
    requested:false,receipt:'not_requested',processBefore:false,processAfter:false,applied:false,pendingObserved:false}));
  const trace=new WorkBuddyTrace(owner,{run,input:controls[0]!.inputId,operation:controls[0]!.operationId},{original:originalMarker,changed:controls[0]!.marker});
  const references=new WorkBuddyRunReferences(run),connection=new AcpConnection({endpoint:identified.endpoint,timeoutMs:5000}),stored=new Map<string,unknown>();
  const stream:Record<string,unknown>[]=[],visible:Record<string,unknown>[]=[];
  let conflict=false,integrity=true,seen=0,taskAttempted=false,taskStarted=false,toolRunningObserved=false;
  let lastScope:ToolScope={matched:false,other:false,reasons:[],toolNames:[]};
  const expression=`(async()=>{const p=globalThis.__courierCapabilityProbe;if(p?.sessionId!==${JSON.stringify(owner)})return;
    const s=await globalThis.__wbInvoke('session:get',{},p.sessionId);if(s?.__wbError||s?.sessionId!==p.sessionId||s?.cwd!==${JSON.stringify(cwd)})return;
    return {sessionId:s.sessionId,isProcessing:s.isProcessing===true,returned:p.toolResult!==undefined,failed:p.toolFailed===true,
      stopReason:p.toolResult?.stopReason,pendingPermissions:(s.pendingPermissions??[]).length,pendingQuestions:(s.pendingQuestions??[]).length,
      events:(s.eventHistory??[]).slice(p.toolStartCount)};})()`;
  const steering=new WorkBuddySteering(connection,{get:key=>stored.get(key),set:(key,value)=>{stored.set(key,value);}},
    (input,_evidence,transition)=>{
      const index=controls.findIndex(item=>item.inputId===input.inputId),control=controls[index];if(!control)return;
      control.applied=true;trace.mark(index===0?'control_applied':'second_control_applied');if(!references.advance(transition))conflict=true;
      control.pendingCheck=diagnostic.evaluate(expression).then(value=>{const state=record(value);
        if(state['sessionId']!==owner){integrity=false;return false;}
        trace.mark('application_task_observed',{processing:state['isProcessing']===true,returned:state['returned']===true});
        control.pendingObserved=state['isProcessing']===true&&state['returned']===false&&state['failed']===false;return control.pendingObserved;
      }).catch(()=>false);
    },()=>{conflict=true;});
  const feed=(params:Record<string,unknown>)=>{
    const update=record(params['update']),ref=requestRef(update)??requestRef(params);
    if(params['sessionId']===owner&&ref&&!internalFrame(params,update))steering.consume(owner,ref,params);
  };
  connection.onMessage=message=>{
    if(message.method!=='session/update')return;const params=record(message.params);
    if(params['sessionId']!==owner)return;
    if(stream.length>=10000){integrity=false;return;}stream.push(params);trace.event('acp',params);feed(params);
    if(!internalFrame(params,record(params['update']))&&references.visibleOutput(params))visible.push(params);
  };
  const finish=(result:Record<string,unknown>)=>{
    const data=trace.snapshot();return {...result,taskSubmission:taskStarted?'submitted':taskAttempted?'unknown':'not_requested',
      toolRunningObserved,toolScopeMatched:lastScope.matched,unexpectedToolObserved:lastScope.other,
      toolScopeReasons:lastScope.reasons,observedToolKinds:lastScope.toolNames,steerDispatches:controls.filter(control=>control.requested).length,
      controls:controls.map(control=>({requested:control.requested,receipt:control.receipt,receiptMs:control.receiptMs,
        ...(control.code?{code:control.code}:{}),processRunningBefore:control.processBefore,processRunningAfterReceipt:control.processAfter,
        appliedObserved:control.applied,appliedBeforeOriginalTaskReturnObserved:control.pendingObserved})),
      protocolConflict:conflict,executionPermissionApprovals:0,sessionLoads:0,rawPromptCalls:0,
      traceSummary:{events:data.rows.length,truncated:data.truncated},trace:data};
  };
  const observe=async()=>{
    const value=record(await diagnostic.evaluate(expression));if(value['sessionId']!==owner){integrity=false;return value;}
    const raw=Array.isArray(value['events'])?value['events']:[],events:Record<string,unknown>[]=[];
    if(raw.length<seen){integrity=false;trace.mark('history_reset');}
    for(let index=0;index<raw.length;index++) {
      const event=record(raw[index]);if(typeof event['sessionId']==='string'&&event['sessionId']!==owner){integrity=false;continue;}
      const params:Record<string,unknown>={...event,sessionId:owner};events.push(params);
      if(index>=seen){trace.event('desktop',params,index);feed(params);}
    }
    seen=raw.length;const combined=[...events,...stream];lastScope=toolScope(combined,owner,run,command,cwd);
    return {...value,events:combined};
  };
  try {
    await connection.connect();await connection.call('initialize',{protocolVersion:1,clientInfo:{name:'Agent Courier long-tool probe',version:'1'},clientCapabilities:{}});
    const prompt=`Use Bash exactly once with this exact harmless command: ${command}. Do not change the command or use any other tools. `+
      `Do not read or write files or contact the network. After it finishes, reply only: ${originalMarker}.`;
    taskAttempted=true;trace.mark('task_submit');
    const submitted=await diagnostic.evaluate(`(async()=>{const p=globalThis.__courierCapabilityProbe;if(p?.sessionId!==${JSON.stringify(owner)})return false;
      const s=await globalThis.__wbInvoke('session:get',{},p.sessionId);if(s?.__wbError||s?.sessionId!==p.sessionId||s?.isProcessing!==false||s?.config?.permissionMode!=='default')return false;
      p.toolStartCount=(s.eventHistory??[]).length;p.toolResult=undefined;p.toolFailed=false;
      p.toolPromise=globalThis.__wbInvoke('session:sendMessage',{},p.sessionId,[{type:'text',text:${JSON.stringify(prompt)}}],
        {'codebuddy.ai/conversationRequestId':${JSON.stringify(run)},'codebuddy.ai/requestId':${JSON.stringify(run)},'codebuddy.ai':{requestId:${JSON.stringify(run)}}})
        .then(r=>{p.toolResult=r;}).catch(()=>{p.toolFailed=true;});return true;})()`);
    taskStarted=submitted===true;if(!taskStarted)return finish({status:'not_started'});
    let state:Record<string,unknown>={};const readyUntil=Date.now()+45000;
    while(Date.now()<readyUntil) {
      state=await observe();if(!integrity)return finish({status:'observation_unknown'});
      if(state['pendingPermissions']!==0||state['pendingQuestions']!==0)return finish({status:'human_input_blocked'});
      if(state['returned']===true||state['failed']===true)return finish({status:'finished_before_tool_observed',completedNormally:state['stopReason']==='end_turn'});
      const events=Array.isArray(state['events'])?state['events']:[];
      if(toolScope(events,owner,run,command,cwd).other)return finish({status:'unexpected_tool'});
      if(originalLongToolReady(state,owner,run,command,cwd)&&ownSyntheticToolRunning(cwd,seconds)){toolRunningObserved=true;trace.mark('tool_running',{processing:true,returned:false});break;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!toolRunningObserved)return finish({status:'tool_execution_unverified'});
    for(let index=0;index<controls.length;index++) {
      const control=controls[index]!;state=await observe();control.processBefore=ownSyntheticToolRunning(cwd,seconds);
      if(!integrity||conflict||!control.processBefore||!originalLongToolReady(state,owner,run,command,cwd))return finish({status:'control_precondition_lost'});
      control.requested=true;trace.mark(index===0?'control_submit':'second_control_submit',{processing:true,returned:false});
      const text=index===0?`In this same ongoing task, after the current command finishes include exactly ${control.marker} in your final reply, retaining the original result requirement. Do not call additional tools.`:
        `Also include exactly ${control.marker} in the reply to this same ongoing task, keeping all earlier output requirements. Do not call additional tools.`;
      const at=Date.now(),receipt=await steering.dispatch({operationId:control.operationId,inputId:control.inputId,sessionRef:owner,
        expectedRunRef:run,text},references.ownerRef).receipt;
      control.receiptMs=Date.now()-at;control.receipt=receipt.status;control.processAfter=ownSyntheticToolRunning(cwd,seconds);
      if(receipt.status!=='accepted')control.code=receipt.errorCode;
      trace.mark(index===0?'control_receipt':'second_control_receipt',{status:receipt.status});
      if(receipt.status!=='accepted')return finish({status:'control_not_accepted'});
    }
    const until=Date.now()+90000;
    do {
      state=await observe();if(!integrity)return finish({status:'observation_unknown'});
      if(state['returned']===true||state['failed']===true)break;
      if(state['pendingPermissions']!==0||state['pendingQuestions']!==0)return finish({status:'human_input_blocked'});
      if(toolScope(Array.isArray(state['events'])?state['events']:[],owner,run,command,cwd).other)return finish({status:'unexpected_tool'});
      await new Promise(resolve=>setTimeout(resolve,100));
    }while(Date.now()<until);
    await Promise.allSettled(controls.map(control=>control.pendingCheck??Promise.resolve(false)));
    const messages=new Map<string,string>();let bounded=true;
    for(const params of visible) {
      const u=record(params['update']),content=record(u['content']),id=metaField(u['_meta'],'messageId')??u['messageId'];
      if(typeof id!=='string'||content['type']!=='text'||typeof content['text']!=='string')continue;
      const text=(messages.get(id)??'')+content['text'];if(text.length>65536){bounded=false;break;}messages.set(id,text);
    }
    const changed=controls.map(control=>bounded&&[...messages.values()].some(text=>text.includes(control.marker)));
    const scope=toolScope(Array.isArray(state['events'])?state['events']:[],owner,run,command,cwd),normal=state['returned']===true&&state['stopReason']==='end_turn'&&state['isProcessing']===false;
    const observed=integrity&&!conflict&&!trace.snapshot().truncated&&scope.matched&&!scope.other&&normal&&changed.every(Boolean)&&
      controls.every(control=>control.requested&&control.receipt==='accepted'&&control.processBefore&&control.processAfter&&control.applied&&control.pendingObserved);
    return finish({status:'observed',changedOutputs:changed,completedNormally:normal,longToolSteerRoundtripObserved:observed});
  }catch(error){return finish({status:'unavailable',code:safeCode(error)});}
  finally{await connection.close().catch(()=>{});}
}
