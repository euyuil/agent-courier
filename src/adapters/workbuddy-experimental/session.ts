import { randomUUID } from 'node:crypto';
import type { HarnessPort,ProbeReport,CommandHandle,Receipt,StartInput,SteerInput,AnswerInput,SessionInput,OperationInput,Inspection } from '../harness/port.js';
import type { HarnessEvent } from '../harness/events.js';
import { requiredCapabilities,optionalCapabilities,evidenceValid,type CapabilityEvidence,type CapabilityName } from '../../domain/capabilities.js';
import type { MappingStore } from '../../storage/adapter-mappings.js';
import { AcpConnection,type RpcMessage } from './connection.js';
import { record,string,newRequestRef,requestRef,internalFrame,metaField } from './metadata.js';
import { rejectedReceipt } from './errors.js';
import { WorkBuddySteering } from './steer.js';
import { WorkBuddyRunReferences } from './run-references.js';
import { inspect } from './inspect.js';
import { WorkBuddyOutput } from './output.js';
import { interaction,interactionSession,isInteractionRequest,mergeInteraction,type InteractionMapping } from './interaction.js';
import { answerInteraction,prepareInteractionAnswer } from './interaction-command.js';
import type { ErrorCode } from '../../domain/errors.js';
import type { DesktopStatus } from './authentication.js';

export interface WorkBuddyOptions {
  connection:AcpConnection;store:MappingStore;cwd:string;instanceId:string;contextFingerprint:string;evidence:CapabilityEvidence[];
  authentication?:()=>Promise<boolean|undefined>;receiptTimeoutMs?:number;
  identity?:()=>Promise<DesktopStatus|undefined>;expectedCliVersion?:string;
}
interface ActiveRun {ref:string;input:StartInput;resolve:(receipt:Receipt)=>void;timer:NodeJS.Timeout;accepted:boolean;output:WorkBuddyOutput;sequence:number;nextOrder:number;
  knownTools:Set<string>;unbound:Map<string,InteractionMapping[]>;unmappedTools:Set<string>;limitations:Set<string>;protocolBlocked:boolean;references:WorkBuddyRunReferences}
export class WorkBuddyAdapter implements HarnessPort {
  private readonly listeners=new Map<string,Set<(event:HarnessEvent)=>void>>();
  private readonly active=new Map<string,ActiveRun>();
  private readonly pending=new Map<string,InteractionMapping>();
  private readonly answers=new Map<string,{input:AnswerInput;receipt:Promise<Receipt>}>();
  private readonly epoch=randomUUID();
  private readonly steering:WorkBuddySteering;
  private initialize:Record<string,unknown>={};
  constructor(private readonly options:WorkBuddyOptions) {
    this.steering=new WorkBuddySteering(options.connection,options.store,(input,appliedEvidence,transition)=>{
      const run=this.active.get(input.sessionRef);
      if(run?.ref===input.expectedRunRef&&!run.references.advance(transition)) {
        run.protocolBlocked=true;this.limitation(input.sessionRef,run,'protocol_conflict');
      }
      // 晚回执归属原 Run；原 Run 已结束或另一 Run 已开始，都不能借用当前任务。
      this.publish({schemaVersion:1,eventKey:`${input.expectedRunRef}:steer:${input.operationId}:applied`,sessionRef:input.sessionRef,
        runRef:input.expectedRunRef,eventType:'input.applied',payload:{inputId:input.inputId,appliedEvidence}});
    },input=>{
      const run=this.active.get(input.sessionRef);
      if(run&&run.ref===input.expectedRunRef){run.protocolBlocked=true;this.limitation(input.sessionRef,run,'protocol_conflict');}
    });
    options.connection.onMessage=message=>this.consume(message);
    options.connection.onLost=()=>{
      for(const [session,run] of this.active){clearTimeout(run.timer);run.resolve({status:'unknown',errorCode:'state_unknown'});
        this.event(session,run,'connection.lost',{unresolvedOperationIds:[run.input.operationId]});}
    };
  }
  async connect():Promise<void> {
    await this.options.connection.connect();
    try {this.initialize=record(await this.options.connection.call('initialize',{protocolVersion:1,
      clientInfo:{name:'Agent Courier experimental adapter',version:'1'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},_meta:{'codebuddy.ai':{question:true}}}}));}
    catch(error){await this.options.connection.close();throw error;}
  }
  async probe(instanceId:string):Promise<ProbeReport> {
    const cliVersion=string(record(this.initialize['agentInfo'])['version']);
    const identity=await this.options.identity?.().catch(()=>undefined),version=identity?.productVersion??'unknown';
    const authentication=identity?.authenticated??await this.options.authentication?.().catch(()=>undefined);
    const target={kind:'harness' as const,productVersion:version,adapterVersion:'1',contextFingerprint:this.options.contextFingerprint};
    const capabilities=Object.fromEntries([...requiredCapabilities,...optionalCapabilities].map(capability=>[
      capability,this.options.evidence.some(evidence=>evidenceValid(evidence,target,Date.now(),capability))?'supported':'unverified',
    ])) as Record<CapabilityName,'supported'|'unverified'|'unsupported'>;
    capabilities.inspectOperation='unsupported';capabilities.replayEvents='unsupported';capabilities.serverIdempotency='unsupported';
    if(this.options.expectedCliVersion!==undefined&&cliVersion!==this.options.expectedCliVersion)
      for(const capability of requiredCapabilities)capabilities[capability]='unverified';
    // This implemented ACP dialect cannot certify progress/final classification.
    capabilities.typedVisibleOutput='unverified';
    capabilities.messageAssembly='unverified';
    capabilities.humanInteraction='unverified';
    if(!record(this.initialize['agentCapabilities'])['loadSession'])capabilities.createAndResume='unsupported';
    return {...target,...(cliVersion?{cliVersion}:{}),product:'WorkBuddy',authenticationStatus:instanceId!==this.options.instanceId||!this.options.connection.connected?'unknown'
      :authentication===true?'authenticated':authentication===false?'required':'unknown',
      capabilities,evidenceRefs:this.options.evidence,limitations:['experimental_configured_loopback_endpoint_only',
        'normal_authentication_probe_required','typed_progress_and_final_unverified','no_event_replay','no_authoritative_operation_query',
        'answer_acceptance_unverified','message_fragment_identity_unverified','no_server_idempotency']};
  }
  private handle(operationId:string,work:()=>Promise<Receipt>):CommandHandle {return {operationId,receipt:work().catch(rejectedReceipt)};}
  createSession(input:OperationInput&{courierSessionId:string}):CommandHandle {
    return this.handle(input.operationId,async()=>{
      const result=record(await this.options.connection.call('session/new',{cwd:this.options.cwd,mcpServers:[]},input.operationId));
      const sessionRef=string(result['sessionId']);
      if(!sessionRef)return {status:'unknown',errorCode:'state_unknown'};
      if(this.options.store.get(`session:${sessionRef}`)!==undefined)return {status:'unknown',errorCode:'protocol_conflict'};
      this.options.store.set(`session:${sessionRef}`,{courierSessionId:input.courierSessionId});
      return {status:'accepted',sessionRef,receiptEvidence:'workbuddy:session/new:response'};
    });
  }
  resumeSession(input:SessionInput):CommandHandle {
    return this.handle(input.operationId,async()=>{
      if(!record(this.initialize['agentCapabilities'])['loadSession'])return {status:'rejected',errorCode:'resume_unsupported',definitelyNotAccepted:true};
      const result=record(await this.options.connection.call('session/load',{sessionId:input.sessionRef,cwd:this.options.cwd,mcpServers:[]},input.operationId));
      if(result['sessionId']!==undefined && result['sessionId']!==input.sessionRef)return {status:'unknown',errorCode:'protocol_conflict'};
      if(this.options.store.get(`session:${input.sessionRef}`)===undefined)this.options.store.set(`session:${input.sessionRef}`,{kind:'resumed'});
      return {status:'accepted',sessionRef:input.sessionRef,receiptEvidence:'workbuddy:session/load:response'};
    });
  }
  start(input:StartInput):CommandHandle {
    if(this.active.has(input.sessionRef))return {operationId:input.operationId,receipt:Promise.resolve({status:'rejected',errorCode:'writer_occupied',definitelyNotAccepted:true})};
    const ref=newRequestRef();
    this.options.store.set(`operation:${input.operationId}`,{kind:'start',sessionRef:input.sessionRef,runRef:ref,inputId:input.inputId});
    let resolve!:(receipt:Receipt)=>void;
    const receipt=new Promise<Receipt>(done=>{resolve=done;});
    const timer=setTimeout(()=>resolve({status:'unknown',errorCode:'state_unknown'}),this.options.receiptTimeoutMs??10000);
    const run:ActiveRun={ref,input,resolve,timer,accepted:false,output:new WorkBuddyOutput(),sequence:0,nextOrder:0,
      knownTools:new Set(),unbound:new Map(),unmappedTools:new Set(),limitations:new Set(),protocolBlocked:false,references:new WorkBuddyRunReferences(ref)};this.active.set(input.sessionRef,run);
    void this.options.connection.call('session/prompt',{sessionId:input.sessionRef,prompt:[{type:'text',text:input.text}],
      _meta:{'codebuddy.ai/conversationRequestId':ref}},input.operationId,3600000).then(result=>{
        const stop=string(record(result)['stopReason']);
        if(!run.accepted || !stop || !['end_turn','max_tokens','max_turn_requests','refusal','cancelled','failed'].includes(stop)) {
          clearTimeout(timer);resolve({status:'unknown',errorCode:'state_unknown'});return;
        }
        run.output.complete((type,payload,key)=>this.event(input.sessionRef,run,type,payload,key),()=>run.nextOrder++);
        for(const [id,mapping] of this.pending)if(mapping.sessionRef===input.sessionRef&&mapping.runRef===run.ref&&mapping.status!=='accepted') {
          this.event(input.sessionRef,run,'input.invalidated',{vendorRequestId:id,reason:'withdrawn'});this.pending.delete(id);
        }
        if(stop==='failed'||stop==='cancelled')this.event(input.sessionRef,run,'run.failed',{
          errorCode:'run_failed',safeReason:'Agent 任务已终止。',completionEvidence:'workbuddy:session/prompt:stopReason'});
        else this.event(input.sessionRef,run,'run.completed',{completionEvidence:'workbuddy:session/prompt:stopReason',stopReason:stop});
        this.active.delete(input.sessionRef);
      }).catch(error=>{
        clearTimeout(timer);
        if(!run.accepted){resolve(rejectedReceipt(error));this.active.delete(input.sessionRef);}
        else this.event(input.sessionRef,run,'connection.lost',{unresolvedOperationIds:[input.operationId]});
      });
    return {operationId:input.operationId,receipt};
  }
  steer(input:SteerInput):CommandHandle {
    const run=this.active.get(input.sessionRef);
    if(run?.protocolBlocked)return {operationId:input.operationId,receipt:Promise.resolve({status:'unknown',errorCode:'protocol_conflict'})};
    if(!run?.accepted||run.ref!==input.expectedRunRef)return {operationId:input.operationId,receipt:Promise.resolve({status:'rejected',errorCode:'stale_run',definitelyNotAccepted:true})};
    try{return this.steering.dispatch(input,run.references.ownerRef);}catch(error){return {operationId:input.operationId,receipt:Promise.resolve(rejectedReceipt(error))};}
  }
  answer(input:AnswerInput):CommandHandle {
    const prior=this.answers.get(input.operationId);
    if(prior)return {operationId:input.operationId,receipt:JSON.stringify(prior.input)===JSON.stringify(input)?prior.receipt:Promise.resolve({status:'unknown',errorCode:'protocol_conflict'})};
    const handle=this.handle(input.operationId,async()=>{
      const mapping=this.pending.get(input.vendorRequestId);
      if(!mapping || mapping.connectionEpoch!==this.epoch)return {status:'unknown',errorCode:'request_invalid'};
      if(mapping.status)return {status:'unknown',errorCode:'request_invalid'};
      if(mapping.sessionRef!==input.sessionRef || mapping.runRef!==input.runRef)return {status:'rejected',errorCode:'request_invalid',definitelyNotAccepted:true};
      const run=this.active.get(input.sessionRef);
      if(!run?.accepted||run.ref!==input.runRef||run.protocolBlocked)return {status:'unknown',errorCode:'request_invalid'};
      if(!prepareInteractionAnswer(mapping,input))return {status:'rejected',errorCode:'request_invalid',definitelyNotAccepted:true};
      mapping.status='dispatching';
      this.options.store.set(`answer:${input.operationId}`,{...mapping,status:'dispatching'});
      let result:Receipt;
      try{result=await answerInteraction(this.options.connection,mapping,input);}catch(error){result=rejectedReceipt(error);}
      const observedStatus=this.pending.get(mapping.vendorRequestId)?.status;
      if(result.status==='accepted')mapping.status='accepted';
      else if(observedStatus!=='invalid')mapping.status=result.status==='unknown'?'unknown':'invalid';
      this.options.store.set(`answer:${input.operationId}`,{...mapping,status:mapping.status});
      if(result.status==='accepted')this.event(input.sessionRef,run,'input.accepted',{operationId:input.operationId,inputId:input.inputId,receiptEvidence:result.receiptEvidence});
      else if(mapping.closedByHarness)this.event(input.sessionRef,run,'input.invalidated',{vendorRequestId:input.vendorRequestId,reason:'withdrawn'},`request:${input.vendorRequestId}:closed`);
      if(result.status==='rejected') {
        if(result.errorCode==='request_invalid')this.event(input.sessionRef,run,'input.invalidated',{vendorRequestId:input.vendorRequestId,reason:'withdrawn'});
        else delete mapping.status;
      }
      return result;
    });
    this.answers.set(input.operationId,{input,receipt:handle.receipt});return handle;
  }
  subscribe(sessionRef:string,listener:(event:HarnessEvent)=>void,verifiedCursor?:string):()=>void {
    if(verifiedCursor!==undefined)throw new Error('replay_unsupported');
    let listeners=this.listeners.get(sessionRef);if(!listeners){listeners=new Set();this.listeners.set(sessionRef,listeners);}
    listeners.add(listener);return ()=>{listeners.delete(listener);if(!listeners.size)this.listeners.delete(sessionRef);};
  }
  async inspect(_input:{sessionRef?:string;operationId?:string;runRef?:string;vendorRequestId?:string}):Promise<Inspection> {return inspect();}
  async disconnect(_instanceId:string):Promise<void>{await this.options.connection.close();}
  private event(session:string,run:ActiveRun,type:HarnessEvent['eventType'],payload:unknown,key?:string):void {
    const sequence=run.sequence++;
    const event={schemaVersion:1,eventKey:`${run.ref}:${key??sequence}`,sessionRef:session,runRef:run.ref,eventType:type,payload} as HarnessEvent;
    this.publish(event);
  }
  private publish(event:HarnessEvent):void {
    for(const listener of this.listeners.get(event.sessionRef)??[])listener(event);
  }
  private consume(message:RpcMessage):void {
    const params=record(message.params),session=string(params['sessionId'])??interactionSession(message);
    if(!session)return;
    if(message.method==='session/update') {
      const update=record(params['update']),ref=requestRef(update)??requestRef(params);
      if(ref&&!internalFrame(params,update))this.steering.consume(session,ref,params);
    }
    const run=this.active.get(session);if(!run)return;
    if(message.method==='session/update') {
      const update=record(params['update']);
      if(internalFrame(params,update))return;
      const ref=requestRef(update)??requestRef(params);
      if(ref!==run.ref) {
        if(run.accepted&&!run.protocolBlocked&&run.references.visibleOutput(params)) {
          if(run.output.accept(params)==='unsupported')this.limitation(session,run,'output_unsupported');
          return;
        }
        const mapping=interaction(message,session,run.ref,this.epoch);
        if(mapping&&ref===undefined)this.request(session,run,mapping);
        else if(!mapping&&ref===undefined&&isInteractionRequest(message))this.unsupportedInteraction(session,run,message);
        if(ref===undefined)this.resolveControl(session,run,update);
        return;
      }
      if(!run.accepted && ['user_message_chunk','agent_message_chunk','agent_thought_chunk','tool_call'].includes(String(update['sessionUpdate']))) {
        run.accepted=true;clearTimeout(run.timer);
        this.event(session,run,'run.started',{clientRunId:run.input.clientRunId,runRef:run.ref},'started');
        run.resolve({status:'accepted',sessionRef:session,runRef:run.ref,receiptEvidence:'workbuddy:correlated-user-echo'});
      }
      if(run.accepted) {
        if(update['sessionUpdate']==='tool_call') {
          const tool=string(update['toolCallId']);
          if(tool){run.knownTools.add(tool);const pending=run.unbound.get(tool)??[];run.unbound.delete(tool);for(const mapping of pending)this.request(session,run,mapping);
            if(run.unmappedTools.delete(tool))this.limitation(session,run,'interaction_blocked');}
        }
        const mapping=interaction(message,session,run.ref,this.epoch);if(mapping)this.request(session,run,mapping);
        else if(isInteractionRequest(message))this.unsupportedInteraction(session,run,message);
        this.resolveControl(session,run,update);
        const visible=['agent_message_chunk','assistant_message_chunk'].includes(String(update['sessionUpdate']));
        if((!visible||(!run.protocolBlocked&&run.references.visibleOutput(params)))&&run.output.accept(params)==='unsupported')this.limitation(session,run,'output_unsupported');
      }
      return;
    }
    const mapping=interaction(message,session,run.ref,this.epoch);
    if(!mapping){if(isInteractionRequest(message))this.unsupportedInteraction(session,run,message);return;}
    this.request(session,run,mapping);
  }
  private request(session:string,run:ActiveRun,mapping:InteractionMapping):void {
    if(!run.knownTools.has(mapping.toolCallId)) {
      const unbound=run.unbound.get(mapping.toolCallId)??[];
      unbound.push(mapping);run.unbound.set(mapping.toolCallId,unbound);
      if(mapping.rpcId!==undefined&&run.accepted)this.limitation(session,run,'interaction_blocked');return;
    }
    const prior=this.pending.get(mapping.vendorRequestId);
    if(prior) {
      const merged=mergeInteraction(prior,mapping);
      if(merged){this.pending.set(mapping.vendorRequestId,merged);this.options.store.set(`interaction:${mapping.vendorRequestId}`,merged);return;}
      prior.status='invalid';run.protocolBlocked=true;
      this.event(session,run,'input.invalidated',{vendorRequestId:prior.vendorRequestId,reason:'withdrawn'});
      this.limitation(session,run,'protocol_conflict');return;
    }
    this.options.store.set(`interaction:${mapping.vendorRequestId}`,mapping);this.pending.set(mapping.vendorRequestId,mapping);
    const messageId=`interaction:${mapping.vendorRequestId}`;
    this.event(session,run,'input.requested',{vendorRequestId:mapping.vendorRequestId,kind:mapping.kind,messageId,
      ...(mapping.options?{options:mapping.options}:{}),...(mapping.answerSchema?{answerSchema:mapping.answerSchema}:{}),adapterMappingRef:`interaction:${mapping.vendorRequestId}`});
    this.event(session,run,'message.started',{messageId,kind:mapping.kind==='permission'?'permission_request':'question',userVisible:true,logicalOrder:run.nextOrder++});
    this.event(session,run,'message.fragment',{messageId,fragmentKey:messageId,fragmentIndex:0,text:mapping.text});
    this.event(session,run,'message.completed',{messageId,finalFragmentIndex:0});
    this.event(session,run,'run.waiting_input',{requestIds:[mapping.vendorRequestId]});
  }
  private limitation(session:string,run:ActiveRun,code:ErrorCode):void {
    if(run.limitations.has(code))return;run.limitations.add(code);
    const messageId=`adapter-limitation:${code}`;
    this.event(session,run,'message.started',{messageId,kind:'error',userVisible:true,logicalOrder:run.nextOrder++});
    this.event(session,run,'message.fragment',{messageId,fragmentKey:messageId,fragmentIndex:0,
      text:code==='protocol_conflict'?'Harness 原请求发生关联冲突，已停止转交新决定。':code==='output_unsupported'
        ?'Harness 输出缺少可靠的消息标识或内容结构，无法安全转发。':'Harness 人工请求缺少可靠的原任务关联，请在原 Harness 界面处理。'});
    this.event(session,run,'message.completed',{messageId,finalFragmentIndex:0});
  }
  private unsupportedInteraction(session:string,run:ActiveRun,message:RpcMessage):void {
    if(run.accepted){this.limitation(session,run,'interaction_blocked');return;}
    const params=record(message.params),update=record(params['update']);
    const tool=string(record(params['toolCall'])['toolCallId'])??string(params['toolCallId'])??
      string(record(metaField(update['_meta'],'interruptionRequest'))['toolCallId']);
    // 尚无原 Run 的关联事实时只保留工具标识；不展示正文、不自动处理请求。
    if(tool)run.unmappedTools.add(tool);
  }
  private resolveControl(session:string,run:ActiveRun,update:Record<string,unknown>):void {
    const resolved=update['sessionUpdate']==='session_info_update'&&metaField(update['_meta'],'permissionResolved')===true;
    const completed=update['sessionUpdate']==='tool_call_update'&&['completed','failed'].includes(String(update['status']));
    if(!resolved&&!completed)return;
    const tool=string(update['toolCallId'])??string(metaField(update['_meta'],'toolCallId'));
    if(!tool||!run.knownTools.has(tool))return;
    const decision=metaField(update['_meta'],'decision');
    if(resolved&&!['allow','allowAll','deny','rejectAndExitPlan'].includes(String(decision)))return;
    for(const mapping of this.pending.values()) {
      if(mapping.sessionRef!==session||mapping.runRef!==run.ref||mapping.toolCallId!==tool||mapping.status==='accepted'||mapping.status==='invalid')continue;
      if(resolved&&mapping.kind==='question')continue;
      // 广播只证明原请求已解决；另一客户端可能做了相同决定，不能据此确认本操作已接收。
      mapping.closedByHarness=true;
      if(mapping.status!=='dispatching') {
        mapping.status='invalid';
        this.event(session,run,'input.invalidated',{vendorRequestId:mapping.vendorRequestId,reason:'withdrawn'},`request:${mapping.vendorRequestId}:closed`);
      }
      this.options.store.set(`interaction:${mapping.vendorRequestId}`,mapping);
    }
  }
}
