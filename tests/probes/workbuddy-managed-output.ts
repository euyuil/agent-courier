import { randomUUID } from 'node:crypto';
import { join,isAbsolute } from 'node:path';
import type { AcpConnection } from '../../src/adapters/workbuddy-experimental/connection.js';
import { ManagedWorkBuddy,workBuddyManagedOptions } from '../../src/adapters/workbuddy-experimental/managed.js';
import { record } from '../../src/adapters/workbuddy-experimental/metadata.js';
import { assertOutsideRepository } from '../../src/config/private.js';
import { privateDirectory } from '../../src/storage/private-state.js';
import { openDatabase,type Connection } from '../../src/storage/database.js';
import { acquireInstanceLock } from '../../src/storage/instance-lock.js';
import { migrate } from '../../src/storage/migrate.js';
import { adapterMappings } from '../../src/storage/adapter-mappings.js';
import { formatterExperiment } from './workbuddy-formatter.js';
import { formatterSteerExperiment } from './workbuddy-formatter-steer.js';
import { formatterQuestionSteerExperiment } from './workbuddy-formatter-question-steer.js';
import { formatterPermissionExperiment,formatterPermissionDecision } from './workbuddy-formatter-permission.js';

export type ManagedOutputScenario='contract'|'steer'|'question-steer'|'native-question-steer'|'approved-formatter';
export async function managedOutputExperiment(desktopDebugUrl:string,workspace:string,scenario:ManagedOutputScenario,operatorDecision?:typeof formatterPermissionDecision):Promise<Record<string,unknown>>{
  const report:Record<string,unknown>={status:'unverified',scenario,executionPermissionApprovals:0,dingtalkSends:0};
  if(scenario==='approved-formatter'&&operatorDecision!==formatterPermissionDecision)return {...report,authorizationRequired:true};
  let db:Connection|undefined,release:(()=>void)|undefined,managed:ManagedWorkBuddy|undefined;
  const namespace='independent-managed-output',path=join(workspace,'managed-output.sqlite'),connections=new Map<string,AcpConnection>();
  const profile={cwd:workspace,cliVersion:null,authorizationScope:[],desktopDebugUrl,bootstrapPermissionMode:'default' as const,
    ownership:{mode:'courier-exclusive' as const},output:scenario==='native-question-steer'?{mode:'acp-text' as const}:{mode:'courier-formatter' as const,contractVersion:1 as const}};
  const open=async(initial=false)=>{
    release=acquireInstanceLock(path);db=openDatabase(path);migrate(db);const store=adapterMappings(db,namespace);
    if(initial){if(store.get('output-probe')!==undefined)throw new Error('probe_already_reserved');store.set('output-probe',{status:'dispatching',scenario});}
    const options=workBuddyManagedOptions({profile,store,instanceId:namespace,evidence:[]});
    managed=new ManagedWorkBuddy({...options,connect:async(ref,owner)=>{
      const endpoint=await options.connect(ref,owner);if(ref)connections.set(ref,endpoint.connection);return endpoint;
    }});
    await managed.connect();return {adapter:managed,store};
  };
  const close=async()=>{await managed?.disconnect(namespace);managed=undefined;db?.close();db=undefined;release?.();release=undefined;};
  try{
    const debug=new URL(desktopDebugUrl);
    if(!isAbsolute(workspace)||debug.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(debug.hostname)||debug.username||debug.password||debug.search||debug.hash)return report;
    assertOutsideRepository(workspace);privateDirectory(workspace);
    const first=await open(true),probe=await first.adapter.probe(namespace);report['cliVersion']=probe.cliVersion;
    report['requiredCapabilitiesUnverified']=['typedVisibleOutput','messageAssembly','humanInteraction'].every(name=>probe.capabilities[name as keyof typeof probe.capabilities]==='unverified');
    if(probe.authenticationStatus!=='authenticated')return report;
    const created=await first.adapter.createSession({operationId:randomUUID(),courierSessionId:randomUUID()}).receipt;
    report['contextPrepared']=created.status==='accepted';if(created.status!=='accepted')return report;
    const sessionRef=created.sessionRef,connection=connections.get(sessionRef);if(!connection?.connected)return report;
    if(scenario==='approved-formatter')report['output']=await formatterPermissionExperiment(first.adapter,connection,sessionRef,operatorDecision);
    else if(scenario==='steer')report['output']=await formatterSteerExperiment(first.adapter,connection,sessionRef);
    else if(scenario==='question-steer'||scenario==='native-question-steer')report['output']=await formatterQuestionSteerExperiment(first.adapter,connection,sessionRef,180000,scenario==='native-question-steer'?'native-text':'formatter');
    else{
      let marker='';
      report['output']=await formatterExperiment(first.adapter,connection,sessionRef,90000,true,{observe:value=>{marker=value.finalText;}});
      if(record(report['output'])['status']!=='observed'||!marker)return report;
      first.store.set('output-probe',{status:'seed_complete',scenario,sessionRef,marker});
      await close();const second=await open(),saved=record(second.store.get('output-probe'));
      if(saved['status']!=='seed_complete'||saved['scenario']!==scenario||saved['sessionRef']!==sessionRef||saved['marker']!==marker)return report;
      const loaded=await second.adapter.resumeSession({operationId:randomUUID(),sessionRef}).receipt;
      report['originalContextRestored']=loaded.status==='accepted'&&loaded.sessionRef===sessionRef;
      if(report['originalContextRestored']!==true)return report;
      const restored=connections.get(sessionRef);if(!restored?.connected)return report;
      report['recall']=await formatterExperiment(second.adapter,restored,sessionRef,90000,false,{recallFinalText:marker});
      if(record(report['recall'])['status']!=='observed')return report;
    }
    report['executionPermissionApprovals']=record(report['output'])['executionPermissionApprovals']??0;
    if(record(report['output'])['status']!=='observed')return report;
    await close();report['status']='observed';return report;
  }catch{report['error']='managed_output_observation_unavailable';return report;}
  finally{await close().catch(()=>{});db?.close();release?.();}
}
