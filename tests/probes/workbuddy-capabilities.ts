import { spawn,type ChildProcess } from 'node:child_process';
import { mkdtempSync,openSync,closeSync,readFileSync,writeFileSync,rmSync,existsSync } from 'node:fs';
import { dirname,resolve,join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { readPrivateJson,assertOutsideRepository } from '../../src/config/private.js';
import { privateDirectory } from '../../src/storage/private-state.js';
import { questionExperiment } from './workbuddy-question.js';
import { resumeExperiment } from './workbuddy-resume.js';
import { acpSurfaceExperiment } from './workbuddy-acp.js';
import { permissionDenialExperiment } from './workbuddy-permission.js';
import { steerExperiment } from './workbuddy-steer.js';
import { waitingSteerExperiment } from './workbuddy-waiting-steer.js';
import { ownedSessionExperiment } from './workbuddy-owned.js';
import { toolSteerExperiment } from './workbuddy-tool-steer.js';
import { completedSteerExperiment } from './workbuddy-completed-steer.js';
import { failureBoundariesExperiment } from './workbuddy-failures.js';
import { configureClassicHookObservation } from './workbuddy-classic-hooks.js';
import { randomUUID } from 'node:crypto';

const launchSchema=z.strictObject({executable:z.string().min(1),args:z.array(z.string()).default([]),virtualDisplay:z.boolean().default(false)});
export class Diagnostic {
  private socket:WebSocket|undefined;private next=0;
  private readonly pending=new Map<number,{resolve:(value:unknown)=>void;reject:()=>void;timer:NodeJS.Timeout}>();
  constructor(private readonly options:{request?:typeof fetch;socket?:typeof WebSocket;retryDelayMs?:number;connectionWaitMs?:number}={}){}
  async connect(endpoint:string):Promise<void> {
    const url=new URL(endpoint);url.protocol='http:';url.pathname='/json/list';
    if(!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash)throw new Error('diagnostic_unavailable');
    const deadline=Date.now()+(this.options.connectionWaitMs??10000);
    let target:string|undefined;
    // DevTools 已开始监听不表示 renderer target 已创建；这里只重试无副作用的发现请求。
    while(Date.now()<deadline) {
      try {
        const response=await (this.options.request??fetch)(url,{redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.min(3000,deadline-Date.now())))});
        const pages:unknown=await response.json();
        if(response.ok&&Array.isArray(pages))target=pages.find(page=>page?.type==='page'&&typeof page.webSocketDebuggerUrl==='string')?.webSocketDebuggerUrl as string|undefined;
      }catch{/* 冷启动期间的只读探测失败可以等待；任务创建与提交不走这条重试。 */}
      if(target)break;
      await new Promise(resolve=>setTimeout(resolve,this.options.retryDelayMs??200));
    }
    if(!target)throw new Error('diagnostic_unavailable');
    const wsUrl=new URL(target);
    if(wsUrl.hostname!==url.hostname||wsUrl.port!==url.port||wsUrl.protocol!=='ws:'||wsUrl.username||wsUrl.password||wsUrl.search||wsUrl.hash)throw new Error('diagnostic_unavailable');
    this.socket=new (this.options.socket??WebSocket)(wsUrl);
    await new Promise<void>((done,reject)=>{
      const timer=setTimeout(()=>reject(new Error('diagnostic_unavailable')),5000);
      this.socket!.onopen=()=>{clearTimeout(timer);done();};this.socket!.onerror=()=>{clearTimeout(timer);reject(new Error('diagnostic_unavailable'));};
    });
    this.socket.onmessage=event=>{
      try {const message=JSON.parse(String(event.data)) as {id?:number;result?:{result?:{value?:unknown}}};
        const pending=message.id===undefined?undefined:this.pending.get(message.id);
        if(pending){clearTimeout(pending.timer);this.pending.delete(message.id!);pending.resolve(message.result?.result?.value);}}
      catch{/* Only fixed, synthetic probe expressions are evaluated. */}
    };
  }
  async evaluate(expression:string,timeout=15000):Promise<unknown> {
    const id=++this.next;
    return new Promise((resolve,reject)=>{
      const fail=()=>reject(new Error('diagnostic_unavailable'));
      const timer=setTimeout(()=>{this.pending.delete(id);fail();},timeout);this.pending.set(id,{resolve,reject:fail,timer});
      this.socket!.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
    });
  }
  close():void {
    for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject();}this.pending.clear();
    if(this.socket){this.socket.onerror=()=>{};this.socket.close();}
  }
}
export async function workbuddyCapabilityProbe(args:string[]):Promise<number> {
  const interruption=args.includes('--question-interruption'),question=args.includes('--question')||interruption,resume=args.includes('--resume'),
    permissionDenial=args.includes('--permission-denial'),sameText=args.includes('--steer-same-text'),
    twice=args.includes('--steer-running-twice')||sameText,slash=args.includes('--steer-slash'),near=args.includes('--steer-near-completion'),
    steer=args.includes('--steer-running')||twice||slash||near,
    waitingTwice=args.includes('--steer-waiting-twice'),waiting=args.includes('--steer-waiting')||waitingTwice,
    ownedQuestion=args.includes('--acp-bootstrap-owned-question'),ownedDenial=args.includes('--acp-bootstrap-owned-denial'),
    ownedHooks=args.includes('--acp-bootstrap-owned-hooks'),bootstrapOwned=args.includes('--acp-bootstrap-owned-run')||ownedQuestion||ownedDenial||ownedHooks,
    owned=args.includes('--acp-owned-run')||bootstrapOwned,
    toolSteer=args.includes('--steer-long-tool'),completedSteer=args.includes('--steer-after-completion'),
    failures=args.includes('--steer-failure-boundaries'),
    handoff=args.includes('--acp-handoff'),processDiscovery=args.includes('--acp-process-surface')||handoff,
    acp=args.includes('--acp-surface')||processDiscovery,exercise=args.includes('--exercise')||question||resume||acp||permissionDenial||steer||waiting||owned||toolSteer||completedSteer||failures;
  const ownedModes=['--acp-owned-run','--acp-bootstrap-owned-run','--acp-bootstrap-owned-question','--acp-bootstrap-owned-denial','--acp-bootstrap-owned-hooks'];
  const flags=args.filter(arg=>!['--exercise','--question','--question-interruption','--resume','--acp-surface','--acp-process-surface','--acp-handoff',...ownedModes,'--permission-denial','--steer-running','--steer-running-twice','--steer-same-text','--steer-slash','--steer-near-completion','--steer-waiting','--steer-waiting-twice','--steer-long-tool','--steer-after-completion','--steer-failure-boundaries'].includes(arg));
  if(flags.length!==5||flags[0]!=='--enable-live'||flags[1]!=='--launch-profile'||flags[3]!=='--output'||(acp&&(question||resume))||
    (permissionDenial&&(acp||question||resume))||(steer&&(acp||question||resume||permissionDenial))||(twice&&args.includes('--steer-running'))||
    (slash&&(twice||args.includes('--steer-running')))||
    (near&&(twice||slash||args.includes('--steer-running')))||
    (waiting&&(acp||question||resume||permissionDenial||steer))||(waitingTwice&&args.includes('--steer-waiting'))||
    (owned&&(acp||question||resume||permissionDenial||steer||waiting))||args.filter(arg=>ownedModes.includes(arg)).length>1||
    (sameText&&args.includes('--steer-running-twice'))||(toolSteer&&(acp||question||resume||permissionDenial||steer||waiting||owned))||
    (completedSteer&&(acp||question||resume||permissionDenial||steer||waiting||owned||toolSteer))||
    (failures&&(acp||question||resume||permissionDenial||steer||waiting||owned||toolSteer||completedSteer))) {
    process.stderr.write('需要 --enable-live --launch-profile <私有 JSON> --output <Git 外新文件>；可选 --exercise、--question、--question-interruption、--resume、--acp-surface、--acp-process-surface、--acp-handoff、--acp-owned-run、--acp-bootstrap-owned-run、--acp-bootstrap-owned-question、--acp-bootstrap-owned-denial、--acp-bootstrap-owned-hooks、--permission-denial、--steer-running、--steer-running-twice、--steer-same-text、--steer-slash、--steer-near-completion、--steer-waiting、--steer-waiting-twice、--steer-long-tool、--steer-after-completion、--steer-failure-boundaries。\n');return 2;
  }
  let child:ChildProcess|undefined,directory:string|undefined,diagnostic:Diagnostic|undefined,reserved=false;
  const report:Record<string,unknown>={kind:'real_workbuddy_experiment',capabilityOutcome:'unverified',exerciseRequested:exercise};
  let phase='private_configuration';
  const output=resolve(flags[4]!);
  try {
    const launch=launchSchema.parse(readPrivateJson(process.cwd()+'/probe.json',flags[2]!));
    if(!launch.executable.startsWith('/')||!existsSync(launch.executable))throw new Error('private_configuration_required');
    assertOutsideRepository(output);
    privateDirectory(dirname(output));const fd=openSync(output,'wx',0o600);closeSync(fd);reserved=true;
    directory=mkdtempSync(join(dirname(output),'workbuddy-experiment-'));privateDirectory(directory);
    phase='desktop_launch';
    const log=join(directory,'desktop.log'),logFd=openSync(log,'wx',0o600);
    const command=[launch.executable,...launch.args,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0'];
    if(launch.virtualDisplay)command.unshift('xvfb-run','-a');
    child=spawn(command[0]!,command.slice(1),{stdio:['ignore',logFd,logFd],detached:true});closeSync(logFd);
    child.on('error',()=>{});
    let endpoint:string|undefined;
    for(let attempt=0;attempt<40;attempt++) {
      endpoint=/DevTools listening on (ws:\/\/[^\s]+)/.exec(readFileSync(log,'utf8'))?.[1];
      if(endpoint)break;if(child.exitCode!==null)break;
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    if(!endpoint)throw new Error('diagnostic_unavailable');
    phase='diagnostic_target';
    diagnostic=new Diagnostic();await diagnostic.connect(endpoint);
    phase='account_query';
    let account:{ready?:unknown;authenticated?:unknown;version?:unknown}|undefined;
    for(let attempt=0;attempt<10;attempt++) {
      try {account=await diagnostic.evaluate("(async()=>{try{if(typeof globalThis.__wbInvoke!=='function')return {ready:false};const a=await globalThis.__wbInvoke('auth:getAccount',{});if(a?.__wbError)return {ready:false};return {ready:true,authenticated:!!a&&typeof a.uid==='string'&&a.uid.length>0,version:globalThis.workbuddyDesktop?.appVersion};}catch{return {ready:false};}})()",5000) as typeof account;}
      catch{account=undefined;}
      if(account?.ready===true)break;
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    report['accountApiReady']=account?.ready===true;
    report['authenticationObserved']=account?.authenticated===true;
    report['productVersion']=typeof account?.version==='string'&&/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(account.version)?account.version:'unknown';
    if(exercise&&account?.authenticated===true) {
      phase='session_create';
      const workspace=join(directory,'workspace');privateDirectory(workspace);
      if(ownedHooks){configureClassicHookObservation(workspace);report['scopedClassicHooksConfigured']=true;}
      if(ownedDenial) {
        privateDirectory(join(workspace,'.codebuddy'));
        writeFileSync(join(workspace,'.codebuddy','settings.local.json'),JSON.stringify({permissions:{ask:['Bash']}}),{mode:0o600,flag:'wx'});
        report['scopedProjectAskRuleConfigured']=true;
      }
      const created=await diagnostic.evaluate(`(async()=>{try{const s=await globalThis.__wbInvoke('session:create',{}, {cwd:${JSON.stringify(workspace)}${permissionDenial||ownedDenial||toolSteer?",permissionMode:'default'":''}});if(s?.__wbError||typeof s?.sessionId!=='string'||s.cwd!==${JSON.stringify(workspace)})return false;globalThis.__courierCapabilityProbe=s;return true;}catch{return false;}})()`);
      report['isolatedSessionCreated']=created===true;
      if(created===true) {
        phase='basic_prompt';
        const marker=`CourierContext-${randomUUID()}`,basicPrompt=resume?`Remember this exact synthetic context marker for later turns: ${marker}. Do not use tools or read or write files. Reply only with that marker.`
          :'Do not use tools or read or write files. Reply only: Agent Courier independent probe complete.';
        const observation=await diagnostic.evaluate(`(async()=>{try{const id=globalThis.__courierCapabilityProbe.sessionId;const r=await globalThis.__wbInvoke('session:sendMessage',{},id,[{type:'text',text:${JSON.stringify(basicPrompt)}}]);const s=await globalThis.__wbInvoke('session:get',{},id);const h=Array.isArray(s?.eventHistory)?s.eventHistory:[];let visibleFrames=0,identifiedFrames=0,typedFrames=0;for(const e of h){const u=e.update??{};if(u.sessionUpdate!=='agent_message_chunk'&&u.sessionUpdate!=='assistant_message_chunk')continue;visibleFrames++;const metas=[e._meta,u._meta,u.content?._meta].filter(m=>m&&typeof m==='object');if(metas.some(m=>typeof m['codebuddy.ai/messageId']==='string'))identifiedFrames++;if(metas.some(m=>[m.kind,m.phase,m['codebuddy.ai/kind'],m['codebuddy.ai/phase']].some(v=>v==='progress'||v==='final')))typedFrames++;}return {promptReturned:!r?.__wbError,explicitCompletion:typeof r?.stopReason==='string',completedNormally:r?.stopReason==='end_turn',visibleFrames,identifiedFrames,typedProgressFinalFrames:typedFrames,isProcessing:s?.isProcessing===true};}catch{return {promptReturned:false};}})()`,90000);
        report['observation']=observation;
        if(acp){
          const basic=observation as {completedNormally?:unknown;isProcessing?:unknown}|undefined;
          phase='acp_surface';
          report['acpObservation']=basic?.completedNormally===true&&basic.isProcessing===false?await acpSurfaceExperiment(diagnostic,log,workspace,processDiscovery,handoff):{status:'skipped_incomplete_original_task'};
        }
        if(permissionDenial) {
          const basic=observation as {completedNormally?:unknown;isProcessing?:unknown}|undefined;
          phase='execution_permission_denial';
          report['permissionObservation']=basic?.completedNormally===true&&basic.isProcessing===false?
            await permissionDenialExperiment(diagnostic):{status:'skipped_incomplete_original_task'};
        }
        if(steer) {
          const basic=observation as {completedNormally?:unknown;isProcessing?:unknown}|undefined;
          phase=near?'steer_near_completion':slash?'steer_slash_rejection':'steer_running';
          report['steerObservation']=basic?.completedNormally===true&&basic.isProcessing===false?
            await steerExperiment(diagnostic,workspace,near?'near-completion':slash?'slash':sameText?'same-text':twice?2:1):{status:'skipped_incomplete_original_task'};
        }
        if(waiting) {
          const basic=observation as {completedNormally?:unknown;isProcessing?:unknown}|undefined;
          phase='steer_waiting_input';
          report['waitingSteerObservation']=basic?.completedNormally===true&&basic.isProcessing===false?
            await waitingSteerExperiment(diagnostic,workspace,waitingTwice?2:1):{status:'skipped_incomplete_original_task'};
        }
        if(owned) {
          const basic=observation as {completedNormally?:unknown;isProcessing?:unknown}|undefined;
          phase='acp_owned_session';
          report['ownedSessionObservation']=basic?.completedNormally===true&&basic.isProcessing===false?
            await ownedSessionExperiment(diagnostic,workspace,{initializeBootstrap:bootstrapOwned,exerciseQuestion:ownedQuestion,
              exercisePermission:ownedDenial,observeHooks:ownedHooks}):{status:'skipped_incomplete_original_task'};
        }
        if(toolSteer) {
          const basic=observation as {completedNormally?:unknown;isProcessing?:unknown}|undefined;
          phase='steer_long_tool';
          report['toolSteerObservation']=basic?.completedNormally===true&&basic.isProcessing===false?
            await toolSteerExperiment(diagnostic,workspace):{status:'skipped_incomplete_original_task'};
        }
        if(completedSteer) {
          const basic=observation as {completedNormally?:unknown;isProcessing?:unknown}|undefined;
          phase='steer_after_completion';
          report['completedSteerObservation']=basic?.completedNormally===true&&basic.isProcessing===false?
            await completedSteerExperiment(diagnostic,workspace):{status:'skipped_incomplete_original_task'};
        }
        if(failures) {
          const basic=observation as {completedNormally?:unknown;isProcessing?:unknown}|undefined;
          phase='steer_failure_boundaries';
          report['failureBoundariesObservation']=basic?.completedNormally===true&&basic.isProcessing===false?
            await failureBoundariesExperiment(diagnostic,workspace):{status:'skipped_incomplete_original_task'};
        }
        if(resume) {
          const basic=observation as {completedNormally?:unknown;isProcessing?:unknown}|undefined;
          phase='original_session_resume';
          report['resumeObservation']=basic?.completedNormally===true&&basic.isProcessing===false?await resumeExperiment(diagnostic,workspace,marker):{status:'skipped_incomplete_original_task'};
        }
        if(question){
          const basic=observation as {completedNormally?:unknown;isProcessing?:unknown}|undefined;
          const restored=report['resumeObservation'] as {status?:unknown;completedNormally?:unknown;isProcessing?:unknown}|undefined;
          const ready=basic?.completedNormally===true&&basic.isProcessing===false&&
            (!resume||(restored?.status==='observed'&&restored.completedNormally===true&&restored.isProcessing===false));
          phase='question_roundtrip';
          // 前一任务或恢复结果不明时，不再向同一 Harness 会话追加探测任务。
          report['questionObservation']=ready?await questionExperiment(diagnostic,interruption?'interruption':'question'):{status:'skipped_incomplete_original_task'};
        }
      }
    }
    report['remaining']=['courier_restart_original_mapping','writer_handoff','steer_consumed_in_running_and_waiting_input',
      'courier_question_and_execution_permission_roundtrip','typed_progress_final_and_message_boundaries','authoritative_inspection'];
    writeFileSync(output,JSON.stringify(report,null,2),{mode:0o600});
    const published={...report};
    for(const key of ['steerObservation','waitingSteerObservation','toolSteerObservation','completedSteerObservation','failureBoundariesObservation']) {
      const observed=report[key];
      if(observed&&typeof observed==='object'&&!Array.isArray(observed)) {
        const summary={...observed as Record<string,unknown>};delete summary['trace'];published[key]=summary;
      }
    }
    process.stdout.write(JSON.stringify(published)+'\n');return 0;
  }catch{report['status']='blocked';report['failedStage']=phase;if(reserved)writeFileSync(output,JSON.stringify(report,null,2),{mode:0o600});
    process.stderr.write(JSON.stringify({status:'blocked',code:'capability_unverified',failedStage:phase,capabilityOutcome:'unverified'})+'\n');return 3;}
  finally{
    diagnostic?.close();
    if(child?.pid){try{process.kill(-child.pid,'SIGTERM');}catch{/* Only this probe's process group is targeted. */}}
    if(directory)rmSync(directory,{recursive:true,force:true});
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exit(await workbuddyCapabilityProbe(process.argv.slice(2)));
