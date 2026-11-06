import { randomUUID } from 'node:crypto';
import { prepareInteractionAnswer } from '../../src/adapters/workbuddy-experimental/interaction-command.js';
import { observedInteraction } from './workbuddy-interaction.js';

interface Diagnostic {evaluate(expression:string,timeout?:number):Promise<unknown>}
export function prepareObservedDenial(snapshot:unknown,command:string):{decision:'deny';sourceCount:number}|undefined {
  const observed=observedInteraction(snapshot,'permission','Bash');if(!observed)return undefined;
  const {mapping,sourceCount}=observed;
  if(mapping.nativeInput['command']!==command||mapping.wireMethod!=='interruption')return undefined;
  const option=mapping.options?.find(item=>item.decision==='deny'&&mapping.wireOptions[item.code]==='deny');
  if(!option)return undefined;
  const prepared=prepareInteractionAnswer(mapping,{operationId:'independent-denial',inputId:'independent-denial-input',
    sessionRef:mapping.sessionRef,runRef:mapping.runRef,vendorRequestId:mapping.vendorRequestId,
    answer:{kind:'permission',decision:'deny',optionCode:option.code}});
  return prepared?.decision==='deny'?{decision:'deny',sourceCount}:undefined;
}
export async function permissionDenialExperiment(diagnostic:Diagnostic):Promise<Record<string,unknown>> {
  const marker=`CourierPermission-${randomUUID()}`,command=`python3 -I -S -c "print('${marker}')"`;
  const prompt=`Call the Bash tool exactly once with this harmless command: ${command}. `+
    'The Harness manages execution permissions; use the tool instead of asking for permission in plain text or with AskUserQuestion. '+
    'Do not use any other tool, read or write files, contact the network, or change the command. '+
    'If it is denied, do not retry or run a substitute; reply only: Agent Courier permission denied.';
  const started=await diagnostic.evaluate(`(async()=>{try{const p=globalThis.__courierCapabilityProbe;
    if(typeof p?.sessionId!=='string')return false;
    const s=await globalThis.__wbInvoke('session:get',{},p.sessionId);
    if(s?.__wbError||s?.sessionId!==p.sessionId||s?.isProcessing!==false||s?.config?.permissionMode!=='default')return false;
    p.permissionStartCount=(s.eventHistory??[]).length;p.permissionResult=undefined;p.permissionFailed=false;
    p.permissionPromise=globalThis.__wbInvoke('session:sendMessage',{},p.sessionId,[{type:'text',text:${JSON.stringify(prompt)}}])
      .then(r=>{p.permissionResult=r;}).catch(()=>{p.permissionFailed=true;});return true;
  }catch{return false;}})()`);
  if(started!==true)return {status:'permission_mode_unverified',executionPermissionApprovals:0};
  let snapshot:unknown;
  const until=Date.now()+60000;
  while(Date.now()<until) {
    const state=await diagnostic.evaluate(`(async()=>{const p=globalThis.__courierCapabilityProbe,s=await globalThis.__wbInvoke('session:get',{},p.sessionId);
      if(s?.__wbError||s?.sessionId!==p.sessionId)return {state:'unknown'};
      const events=(s.eventHistory??[]).slice(p.permissionStartCount),command=${JSON.stringify(command)};
      for(const e of events){const u=e.update??{},m=u._meta??{},name=m['codebuddy.ai/toolName']??m['codebuddy.ai']?.toolName;
        if(u.sessionUpdate!=='tool_call')continue;
        // 工具开始帧可以尚无完整输入；不据此猜测命令，完整权限请求仍须逐字匹配。
        if((typeof name==='string'&&name!=='Bash')||(typeof u.rawInput?.command==='string'&&u.rawInput.command!==command))
          return {state:'other_tool_observed',knownToolName:['Bash','Read','Write','Edit','TodoWrite','AskUserQuestion','Task','Skill'].includes(name)?name:'unknown',
            commandPresent:typeof u.rawInput?.command==='string',originalCommandMatched:u.rawInput?.command===command};}
      const requests=s.pendingPermissions??[];
      for(const item of requests){const r=item.request??{},tool=r.toolCall??{},m=tool._meta??{};
        if((m['codebuddy.ai/toolName']??m['codebuddy.ai']?.toolName)!=='Bash'||tool.rawInput?.command!==command)return {state:'other_permission'};
        if(typeof tool.toolCallId!=='string')return {state:'request_shape_unverified'};
        const messages=[{jsonrpc:'2.0',id:item.requestId,method:'session/request_permission',params:r}];
        for(const e of events){const u=e.update??{},i=u._meta?.['codebuddy.ai/interruptionRequest'];
          if(u.sessionUpdate==='session_info_update'&&i?.toolCallId===tool.toolCallId)
            messages.push({jsonrpc:'2.0',method:'session/update',params:{sessionId:p.sessionId,update:u}});}
        p.permissionToolCallId=tool.toolCallId;
        return {state:'permission',sessionRef:p.sessionId,toolCallId:tool.toolCallId,messages,
          toolUpdates:events.map(e=>e.update).filter(u=>u?.sessionUpdate==='tool_call'&&u.toolCallId===tool.toolCallId)};}
      if(p.permissionFailed||p.permissionResult)return {state:'finished_without_matching_permission',
        completedNormally:p.permissionResult?.stopReason==='end_turn',
        toolCallFrames:events.filter(e=>e.update?.sessionUpdate==='tool_call').length,
        matchingCommandFrames:events.filter(e=>e.update?.sessionUpdate==='tool_call'&&e.update.rawInput?.command===command).length};
      return {state:'running'};})()`) as {state?:string;knownToolName?:string;commandPresent?:boolean;originalCommandMatched?:boolean;
        completedNormally?:boolean;toolCallFrames?:number;matchingCommandFrames?:number}|undefined;
    if(state?.state==='permission'){snapshot=state;break;}
    if(state?.state!=='running')return {status:state?.state??'observation_unknown',permissionObserved:false,executionPermissionApprovals:0,
      ...(state?.knownToolName?{knownToolName:state.knownToolName,commandPresent:state.commandPresent,originalCommandMatched:state.originalCommandMatched}:{}),
      ...(state?.toolCallFrames!==undefined?{completedNormally:state.completedNormally,toolCallFrames:state.toolCallFrames,matchingCommandFrames:state.matchingCommandFrames}:{})};
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  if(!snapshot)return {status:'permission_not_observed',permissionObserved:false,executionPermissionApprovals:0};
  const prepared=prepareObservedDenial(snapshot,command);
  if(!prepared)return {status:'production_mapping_unverified',permissionObserved:true,executionPermissionApprovals:0};
  const denied=await diagnostic.evaluate(`(async()=>{const p=globalThis.__courierCapabilityProbe;
    if(typeof p?.permissionToolCallId!=='string')return false;
    const s=await globalThis.__wbInvoke('session:get',{},p.sessionId);p.permissionBeforeDenialCount=(s?.eventHistory??[]).length;
    return await globalThis.__wbInvoke('session:resolveInterruption',{},p.sessionId,p.permissionToolCallId,'deny');})()`,10000);
  if(denied!==true)return {status:'denial_not_acknowledged',permissionObserved:true,productionMappingObserved:true,executionPermissionApprovals:0};
  const finished=await diagnostic.evaluate(`(async()=>{const p=globalThis.__courierCapabilityProbe;await p.permissionPromise;
    const s=await globalThis.__wbInvoke('session:get',{},p.sessionId),events=(s?.eventHistory??[]).slice(p.permissionBeforeDenialCount);
    const text=events.map(e=>e.update).filter(u=>u?.sessionUpdate==='agent_message_chunk').map(u=>u.content?.text??'').join('');
    return {completedNormally:p.permissionResult?.stopReason==='end_turn',isProcessing:s?.isProcessing===true,
      denialReplyObserved:text.includes('Agent Courier permission denied'),additionalToolCallFrames:events.filter(e=>e.update?.sessionUpdate==='tool_call').length,
      pendingPermissions:(s?.pendingPermissions??[]).length};})()`,90000);
  return {status:'observed',permissionObserved:true,productionMappingObserved:true,denialAcknowledged:true,mappedSourceCount:prepared.sourceCount,
    executionPermissionApprovals:0,...(finished&&typeof finished==='object'?finished:{})};
}
