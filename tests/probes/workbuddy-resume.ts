interface Diagnostic { evaluate(expression:string,timeout?:number):Promise<unknown> }
export async function resumeExperiment(diagnostic:Diagnostic,workspace:string,marker:string):Promise<Record<string,unknown>> {
  const restored=await diagnostic.evaluate(`(async()=>{try{const p=globalThis.__courierCapabilityProbe,original=p?.sessionId;
    if(typeof original!=='string')return {status:'missing_original'};
    const before=await globalThis.__wbInvoke('session:get',{},original);
    if(before?.__wbError||before?.isProcessing!==false)return {status:'original_not_idle'};
    const disposed=await globalThis.__wbInvoke('session:destroy',{},original);
    if(disposed?.__wbError)return {status:'release_rejected'};
    const loaded=await globalThis.__wbInvoke('session:load',{},original,{cwd:${JSON.stringify(workspace)}});
    if(loaded?.__wbError)return {status:'load_rejected'};
    if(loaded?.sessionId!==original||loaded?.cwd!==${JSON.stringify(workspace)})return {status:'original_mapping_unverified'};
    const snapshot=await globalThis.__wbInvoke('session:get',{},original);
    p.resumeBeforePromptCount=(snapshot?.eventHistory??[]).length;
    return {status:'restored',sameHarnessSession:true,ownerHistoryReplayComplete:loaded.rendererHistoryReplayComplete===true};
  }catch{return {status:'resume_unknown'};}})()`,60000) as {status?:string}|undefined;
  if(restored?.status!=='restored')return restored??{status:'resume_unknown'};
  const observation=await diagnostic.evaluate(`(async()=>{try{const p=globalThis.__courierCapabilityProbe;
    const result=await globalThis.__wbInvoke('session:sendMessage',{},p.sessionId,[{type:'text',text:'Without using tools or reading files, repeat only the exact synthetic context marker I asked you to remember in the previous turn. The marker is not repeated in this input.'}]);
    const s=await globalThis.__wbInvoke('session:get',{},p.sessionId),h=s?.eventHistory??[],cursor=p.resumeBeforePromptCount;
    const tail=h.slice(cursor),text=tail.filter(e=>e.update?.sessionUpdate==='agent_message_chunk').map(e=>e.update.content?.text??'').join('');
    return {status:'observed',sameHarnessSession:s?.sessionId===p.sessionId,completedNormally:result?.stopReason==='end_turn',isProcessing:s?.isProcessing===true,
      contextRecalled:typeof cursor==='number'&&h.length>=cursor&&text.includes(${JSON.stringify(marker)}),noToolsObserved:!tail.some(e=>e.update?.sessionUpdate==='tool_call')};
  }catch{return {status:'continuation_unknown'};}})()`,90000);
  return observation&&typeof observation==='object'?observation as Record<string,unknown>:{status:'continuation_unknown'};
}
