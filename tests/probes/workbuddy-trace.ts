import { record,metaField,internalFrame } from '../../src/adapters/workbuddy-experimental/metadata.js';

type Source='acp'|'desktop'|'probe';
type Step='task_submit'|'run_activity'|'late_output_anchor'|'tool_running'|'question_observed'|'control_submit'|'control_receipt'|'control_applied'|'second_control_submit'|'second_control_receipt'|'second_control_applied'|'control_transport_closed'|'store_reopened'|'duplicate_suppressed'|'waiting_observation_frozen'|'answer_submit'|'application_task_observed'|'task_return_observed'|'post_result_observation'|'history_reset'|'foreign_history_event';
const phases=new Set(['preparing','model_requesting','model_streaming','model_done','tool_executing','waiting_for_permission','waiting_for_user','retrying','idle']);
const stops=new Set(['end_turn','max_tokens','max_turn_requests','refusal','cancelled','failed']);
const updates=new Set(['session_info_update','session_end','user_message_chunk','agent_message_chunk','assistant_message_chunk','agent_thought_chunk',
  'tool_call','tool_call_update','tool_call_pending','plan','available_commands_update','current_mode_update','config_option_update','usage_update']);
interface TraceRow {
  sequence:number;observedAtMs:number;source:Source;kind:string;references:Record<string,string>;
  historyIndex?:number;internal?:boolean;phase?:string;stopReason?:string;progressPresent?:boolean;
  unsolicitedReason?:string;steerOrigin?:boolean;originalMarker?:boolean;changedMarker?:boolean;
  status?:string;processing?:boolean;returned?:boolean;resultElapsedMs?:number;
}
export class WorkBuddyTrace {
  #owner:string;#aliases=new Map<string,string>();#rows:TraceRow[]=[];#buffers=new Map<string,string>();
  #start:number;#clock:()=>number;#original:string;#changed:string;#truncated=false;#nextAlias=1;#maxRows:number;
  constructor(owner:string,known:{run:string;input:string;operation:string},markers:{original:string;changed:string},clock:()=>number=Date.now,maxRows=2000) {
    if(!Number.isInteger(maxRows)||maxRows<1||maxRows>10000)throw new Error('invalid_trace_limit');
    this.#owner=owner;this.#clock=clock;this.#start=clock();this.#original=markers.original;this.#changed=markers.changed;this.#maxRows=maxRows;
    for(const [value,label] of [[known.run,'original-run'],[known.input,'control-input'],[known.operation,'control-operation']])
      if(value&&!this.#aliases.has(value!))this.#aliases.set(value!,label!);
  }
  #alias(value:unknown):string|undefined {
    if(typeof value!=='string'||!value)return undefined;
    if(value.length>200){this.#truncated=true;return 'oversized-reference';}
    let label=this.#aliases.get(value);if(!label){label=`reference-${this.#nextAlias++}`;this.#aliases.set(value,label);}return label;
  }
  #row(source:Source,kind:string):TraceRow|undefined {
    if(this.#rows.length>=this.#maxRows){this.#truncated=true;return undefined;}
    const row:TraceRow={sequence:this.#rows.length,observedAtMs:Math.max(0,this.#clock()-this.#start),source,kind,references:{}};
    this.#rows.push(row);return row;
  }
  event(source:'acp'|'desktop',value:unknown,historyIndex?:number):void {
    const params=record(value);if(params['sessionId']!==this.#owner)return;
    const update=record(params['update']),kind=update['sessionUpdate'];
    const row=this.#row(source,typeof kind==='string'&&updates.has(kind)?kind:'unknown');if(!row)return;
    if(historyIndex!==undefined&&Number.isInteger(historyIndex)&&historyIndex>=0)row.historyIndex=historyIndex;
    row.internal=internalFrame(params,update);
    const reference=(key:string,value:unknown)=>{const alias=this.#alias(value);if(alias)row.references[key]=alias;};
    reference('eventRequest',params['requestId']);reference('topRequest',update['requestId']);reference('topMessage',update['messageId']);
    reference('toolCall',update['toolCallId']);
    const metas=[update['_meta'],params['_meta']];
    for(const key of ['conversationRequestId','requestId','messageRequestId','promptRequestId','messageId','modelRequestId','llmMessageId',
      'userEntryId','clientUserMessageId','parentSessionId','parentToolCallId'])
      reference(key,metaField(metas[0],key)??metaField(metas[1],key));
    const control=record(metaField(metas[0],'steerClientMeta')??metaField(metas[1],'steerClientMeta')),
      courier=record(control['agent-courier']);
    reference('steerOperation',courier['operationId']);reference('steerInput',courier['inputId']);reference('steerRun',courier['runRef']);
    if(record(control['codebuddy.ai'])['queueOrigin']==='steer')row.steerOrigin=true;
    const phase=record(metaField(metas[0],'agentPhase')??metaField(metas[1],'agentPhase'))['phase'];
    if(typeof phase==='string')row.phase=phases.has(phase)?phase:'unknown';
    const stop=update['stopReason']??metaField(metas[0],'stopReason')??metaField(metas[1],'stopReason');
    if(typeof stop==='string')row.stopReason=stops.has(stop)?stop:'unknown';
    if(metaField(metas[0],'progress')!==undefined||metaField(metas[1],'progress')!==undefined)row.progressPresent=true;
    const turn=record(metaField(metas[0],'unsolicitedTurn')??metaField(metas[1],'unsolicitedTurn'));
    if(typeof turn['requestId']==='string') {
      reference('unsolicitedRequest',turn['requestId']);row.unsolicitedReason=turn['reason']==='background_drain'?'background_drain':'other';
    }
    // 只保留受控标记的存在性；思考、工具输入、正文、路径和未知元数据均不进入轨迹。
    if(!row.internal&&['agent_message_chunk','assistant_message_chunk','user_message_chunk'].includes(String(kind))) {
      const content=record(update['content']);
      if(content['type']==='text'&&typeof content['text']==='string') {
        const message=row.references['messageId']??row.references['topMessage'];
        const request=row.references['conversationRequestId']??row.references['requestId']??'unknown';
        const key=message?`${source}:${kind}:${request}:${message}`:undefined;
        let text=content['text'];
        if(key){text=(this.#buffers.get(key)??'')+text;if(text.length>65536){text=text.slice(-65536);this.#truncated=true;}this.#buffers.set(key,text);}
        row.originalMarker=!!this.#original&&text.includes(this.#original);row.changedMarker=!!this.#changed&&text.includes(this.#changed);
      }
    }
  }
  mark(step:Step,state:{status?:string;processing?:boolean;returned?:boolean;resultElapsedMs?:unknown;stopReason?:unknown}={}):void {
    const row=this.#row('probe',step);if(!row)return;
    if(state.status)row.status=['accepted','rejected','unknown'].includes(state.status)?state.status:'unknown';
    if(typeof state.processing==='boolean')row.processing=state.processing;
    if(typeof state.returned==='boolean')row.returned=state.returned;
    if(typeof state.resultElapsedMs==='number'&&Number.isFinite(state.resultElapsedMs)&&state.resultElapsedMs>=0)row.resultElapsedMs=state.resultElapsedMs;
    if(typeof state.stopReason==='string')row.stopReason=stops.has(state.stopReason)?state.stopReason:'unknown';
  }
  snapshot():{truncated:boolean;rows:TraceRow[]} {return {truncated:this.#truncated,rows:structuredClone(this.#rows)};}
}
