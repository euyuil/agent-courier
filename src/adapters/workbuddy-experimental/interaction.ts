import { z } from 'zod';
import type { AnswerSchema,Option } from '../../domain/answer.js';
import { record,string,metaField,internalFrame } from './metadata.js';
import type { RpcMessage } from './connection.js';

const questionFields=z.array(z.object({id:z.string().min(1).optional(),question:z.string().min(1),multiSelect:z.boolean().optional(),
  options:z.array(z.object({label:z.string().min(1),description:z.string().optional()})).refine(options=>new Set(options.map(option=>option.label)).size===options.length).optional()})).min(1);
const questionSchema=z.object({toolCallId:z.string().min(1),questions:questionFields});
const permissionSchema=z.object({toolCall:z.object({toolCallId:z.string().min(1),title:z.string().optional(),rawInput:z.record(z.string(),z.unknown()).optional(),_meta:z.unknown().optional()}),
  options:z.array(z.object({optionId:z.string().min(1),kind:z.enum(['allow_once','allow_always','reject_once','reject_always','allow','reject']),name:z.string()})).min(1)
    .refine(options=>new Set(options.map(option=>option.optionId)).size===options.length)});
const interruptionSchema=z.object({interruptionId:z.string().min(1),toolCallId:z.string().min(1),toolName:z.string().min(1),toolTitle:z.string().optional(),
  toolInput:z.record(z.string(),z.unknown()),options:z.array(z.enum(['allow','allowAll','deny'])).min(1).refine(options=>new Set(options).size===options.length),
  isSubAgent:z.boolean().optional(),isTeamMember:z.boolean().optional()});
export type InterruptionDecision='allow'|'allowAll'|'deny';
export interface InteractionMapping {
  sessionRef:string;runRef:string;vendorRequestId:string;rpcId?:string|number;method:string;connectionEpoch:string;
  wireMethod:'rpc'|'interruption';toolCallId:string;nativeToolName:string;nativeInput:Record<string,unknown>;
  wireOptions:Record<string,InterruptionDecision>;status?:'dispatching'|'unknown'|'accepted'|'invalid';
  closedByHarness?:boolean;
  kind:'permission'|'question';text:string;options?:Option[];answerSchema?:AnswerSchema;
}
function form(questions:z.infer<typeof questionFields>,native:boolean):AnswerSchema|undefined {
  const ids=questions.map((question,index)=>native?`q_${index}`:question.id);
  if(ids.some(id=>!id)||new Set(ids).size!==ids.length)return undefined;
  return {mode:'form',fields:questions.map((question,index)=>({fieldId:ids[index]!,label:question.question,required:true,
    valueType:question.options?.length?(question.multiSelect?'choices':'choice'):'text',
    ...(question.options?.length?{options:question.options.map(option=>({code:option.label,label:option.description?`${option.label}: ${option.description}`:option.label}))}:{})}))};
}
function nativeQuestion(base:Omit<InteractionMapping,'kind'|'text'|'answerSchema'>):InteractionMapping|undefined {
  const questions=questionFields.safeParse(base.nativeInput['questions']);if(!questions.success)return undefined;
  const answerSchema=form(questions.data,true);if(!answerSchema)return undefined;
  return {...base,kind:'question',wireMethod:'interruption',vendorRequestId:JSON.stringify([base.sessionRef,base.runRef,'question',base.toolCallId]),
    text:questions.data.map(question=>question.question).join('\n'),answerSchema};
}
export function interaction(message:RpcMessage,sessionRef:string,runRef:string,connectionEpoch:string):InteractionMapping|undefined {
  if(interactionSession(message)!==sessionRef||!isInteractionRequest(message))return undefined;
  const base={sessionRef,runRef,connectionEpoch};
  if(message.method==='session/request_permission'&&message.id!==undefined) {
    const parsed=permissionSchema.safeParse(message.params);if(!parsed.success)return undefined;
    const data=parsed.data;
    if(metaField(data.toolCall._meta,'isSubAgent')===true||metaField(data.toolCall._meta,'isTeamMember')===true)return undefined;
    const nativeToolName=string(metaField(data.toolCall._meta,'toolName'))??'unknown';
    const common={...base,rpcId:message.id,method:message.method,wireMethod:'rpc' as const,toolCallId:data.toolCall.toolCallId,nativeToolName,nativeInput:data.toolCall.rawInput??{},
      vendorRequestId:JSON.stringify([sessionRef,runRef,'permission',data.toolCall.toolCallId]),wireOptions:Object.fromEntries(data.options.flatMap(option=>{
        const decision=option.kind==='allow_once'?'allow':option.kind==='allow_always'?'allowAll':option.kind==='reject_once'?'deny':undefined;
        return decision?[[option.optionId,decision as InterruptionDecision]]:[];
      }))};
    // 只识别厂商内置 AskUserQuestion；不凭任意工具输入中的 questions 字段提升为问题。
    if(nativeToolName==='AskUserQuestion')return nativeQuestion(common);
    return {...common,kind:'permission',
      text:`${data.toolCall.title??'Agent 请求执行操作，请选择权限范围。'}${data.toolCall.rawInput?'\n'+JSON.stringify(data.toolCall.rawInput):''}`,
      options:data.options.map(option=>({code:option.optionId,label:option.name,decision:option.kind.startsWith('allow')?'approve':'deny'}))};
  }
  if(message.method==='_codebuddy.ai/question'&&message.id!==undefined) {
    const parsed=questionSchema.safeParse(message.params);if(!parsed.success)return undefined;
    const data=parsed.data;
    const answerSchema=form(data.questions,false);if(!answerSchema)return undefined;
    return {...base,rpcId:message.id,method:message.method,wireMethod:'rpc',toolCallId:data.toolCallId,nativeToolName:'question',nativeInput:{questions:data.questions},wireOptions:{},
      vendorRequestId:JSON.stringify([sessionRef,runRef,'question',data.toolCallId]),kind:'question',text:data.questions.map(question=>question.question).join('\n'),answerSchema};
  }
  if(message.method==='session/update') {
    const params=record(message.params),update=record(params['update']);if(update['sessionUpdate']!=='session_info_update')return undefined;
    const parsed=interruptionSchema.safeParse(metaField(update['_meta'],'interruptionRequest'));
    if(!parsed.success||parsed.data.isSubAgent||parsed.data.isTeamMember)return undefined;
    const data=parsed.data;
    const common={...base,method:'_codebuddy.ai/resolveInterruption',wireMethod:'interruption' as const,toolCallId:data.toolCallId,nativeToolName:data.toolName,
      nativeInput:data.toolInput,wireOptions:Object.fromEntries(data.options.map(option=>[option,option])),
      vendorRequestId:JSON.stringify([sessionRef,runRef,'permission',data.toolCallId])};
    if(data.toolName==='AskUserQuestion')return nativeQuestion(common);
    const labels={allow:'批准本次（allow）',allowAll:'持续批准（allowAll，按 Harness 作用域）',deny:'拒绝（deny）'};
    return {...common,kind:'permission',text:`${data.toolTitle??data.toolName}\n${JSON.stringify(data.toolInput)}`,
      options:data.options.map(option=>({code:option,label:labels[option],decision:option==='deny'?'deny':'approve'}))};
  }
  return undefined;
}
export function interactionSession(message:RpcMessage):string|undefined {return string(record(message.params)['sessionId']);}
export function isInteractionRequest(message:RpcMessage):boolean {
  const params=record(message.params),update=record(params['update']),tool=record(params['toolCall']);
  const interruption=record(metaField(update['_meta'],'interruptionRequest'));
  if(internalFrame(params,update)||internalFrame(params,tool)||interruption['isSubAgent']===true||interruption['isTeamMember']===true)return false;
  return message.method==='session/request_permission'||message.method==='_codebuddy.ai/question'||
    (message.method==='session/update'&&update['sessionUpdate']==='session_info_update'&&metaField(update['_meta'],'interruptionRequest')!==undefined);
}
function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  return value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
}
export function mergeInteraction(prior:InteractionMapping,next:InteractionMapping):InteractionMapping|undefined {
  if(prior.vendorRequestId!==next.vendorRequestId||prior.kind!==next.kind||prior.connectionEpoch!==next.connectionEpoch
    || (prior.nativeToolName!=='unknown'&&next.nativeToolName!=='unknown'&&prior.nativeToolName!==next.nativeToolName)
    || JSON.stringify(canonical(prior.nativeInput))!==JSON.stringify(canonical(next.nativeInput))
    || JSON.stringify(prior.answerSchema)!==JSON.stringify(next.answerSchema))return undefined;
  if(prior.status||next.wireMethod!=='interruption')return prior;
  // 标准 RPC 中的某些范围没有内部 interruption 等价项；保留原路径，不扩大或替换决定。
  if(prior.kind==='permission'&&prior.options?.some(option=>!Object.hasOwn(prior.wireOptions,option.code)))return prior;
  const available=new Set(Object.values(next.wireOptions));
  if(prior.kind==='permission'&&Object.values(prior.wireOptions).some(decision=>!available.has(decision)))return undefined;
  return {...prior,wireMethod:'interruption'};
}
