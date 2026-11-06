import type { HarnessEvent } from '../harness/events.js';
import { formatterFullToolName,formatterInputSchema,decodeFormatterResult,type FormatterPayload } from './formatter.js';
import { internalFrame,metaField,record,string } from './metadata.js';

type Emit=(type:HarnessEvent['eventType'],payload:unknown,key?:string)=>void;
interface Output {id:string;kind?:'progress'|'final';input?:{kind:'progress'|'final';text:string};result?:FormatterPayload;closed:boolean}

// 调用方先核对 Harness 会话和 Run 归属。原生工具身份、显式参数、
// 结果回显与工具完成须分别成立；部分参数和普通文本不能作为正文转发。
export class FormatterOutput {
  private readonly tools=new Map<string,Output>();
  private blocked=false;
  private finalObserved=false;
  constructor(private readonly emit:Emit,private readonly nextOrder:()=>number){}
  accepts(params:Record<string,unknown>):boolean {
    const update=record(params['update']),id=string(update['toolCallId']);
    return !!id&&(this.tools.has(id)||metaField(update['_meta'],'toolName')===formatterFullToolName);
  }
  accept(params:Record<string,unknown>):'ignored'|'buffered'|'unsupported' {
    const update=record(params['update']);
    if(internalFrame(params,update)||!['tool_call','tool_call_update'].includes(String(update['sessionUpdate']))||!this.accepts(params))return 'ignored';
    if(this.blocked)return 'unsupported';
    const id=string(update['toolCallId'])!,name=string(metaField(update['_meta'],'toolName'));
    let output=this.tools.get(id);
    if(name&&name!==formatterFullToolName)return this.fail();
    if(!output) {
      if(update['sessionUpdate']!=='tool_call')return this.fail();
      output={id:`formatter:${id}`,closed:false};this.tools.set(id,output);
    }
    if(['failed','cancelled'].includes(String(update['status'])))return this.fail();
    if(output.closed&&update['status']!=='completed')return 'buffered';
    const parsed=formatterInputSchema.safeParse(update['rawInput']);
    if(parsed.success) {
      if(output.kind&&output.kind!==parsed.data.kind)return this.fail();
      output.input=parsed.data;
      if(!output.kind) {
        output.kind=parsed.data.kind;
        this.emit('message.started',{messageId:output.id,kind:output.kind,userVisible:true,logicalOrder:this.nextOrder()},`${output.id}:start`);
      }
    }
    if(update['status']!=='completed')return 'buffered';
    if(output.closed&&update['rawOutput']===undefined&&update['rawInput']===undefined)return 'buffered';
    const payload=decodeFormatterResult(update['rawOutput']);
    if(!payload||!output.input||payload.kind!==output.input.kind||payload.text!==output.input.text)return this.fail();
    if(output.result) {
      if(payload.kind!==output.result.kind||payload.text!==output.result.text)return this.fail();
      return 'buffered';
    }
    output.result=payload;output.closed=true;
    if(payload.kind==='final')this.finalObserved=true;
    this.emit('message.fragment',{messageId:output.id,fragmentKey:`${output.id}:snapshot`,fragmentIndex:0,text:payload.text},`${output.id}:snapshot`);
    this.emit('message.completed',{messageId:output.id,finalFragmentIndex:0},`${output.id}:complete`);
    return 'buffered';
  }
  finish():boolean {
    const incomplete=[...this.tools.values()].some(output=>!output.closed);
    if(incomplete)this.fail();
    return !this.blocked&&this.finalObserved;
  }
  private fail():'unsupported' {
    this.blocked=true;
    for(const output of this.tools.values())if(output.kind&&!output.closed) {
      output.closed=true;this.emit('message.completed',{messageId:output.id,finalFragmentIndex:-1},`${output.id}:empty`);
    }
    return 'unsupported';
  }
}
