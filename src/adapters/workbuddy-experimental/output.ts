import type { HarnessEvent } from '../harness/events.js';
import { metaField,record,string,internalFrame } from './metadata.js';
import { FormatterOutput } from './formatter-output.js';

export class WorkBuddyOutput {
  private readonly messages=new Map<string,string[]>();
  private readonly formatter:FormatterOutput|undefined;
  constructor(options?:{emit:(type:HarnessEvent['eventType'],payload:unknown,key?:string)=>void;nextOrder:()=>number}) {
    this.formatter=options?new FormatterOutput(options.emit,options.nextOrder):undefined;
  }
  acceptsFormattedTool(params:Record<string,unknown>):boolean{return this.formatter?.accepts(params)??false;}
  accept(params:Record<string,unknown>):'ignored'|'buffered'|'unsupported' {
    if(this.formatter)return this.formatter.accept(params);
    const update=record(params['update']);
    if(internalFrame(params,update) || !['agent_message_chunk','assistant_message_chunk'].includes(String(update['sessionUpdate'])))return 'ignored';
    const content=record(update['content']);
    const messageId=string(metaField(update['_meta'],'messageId'))??string(metaField(params['_meta'],'messageId'))??string(update['messageId']);
    if(!messageId || content['type']!=='text' || typeof content['text']!=='string')return 'unsupported';
    let message=this.messages.get(messageId);
    if(!message){message=[];this.messages.set(messageId,message);}
    message.push(content['text']);
    return 'buffered';
  }
  complete(event:(type:HarnessEvent['eventType'],payload:unknown,key?:string)=>void,nextOrder:()=>number):boolean {
    if(this.formatter)return this.formatter.finish();
    // This dialect has no verified per-message end frame. Hold ordinary text until
    // the authoritative prompt result, so it cannot block a complete human request.
    for(const [messageId,fragments] of this.messages) {
      event('message.started',{messageId,kind:'message',userVisible:true,logicalOrder:nextOrder()},`message:${messageId}:start`);
      fragments.forEach((text,index)=>event('message.fragment',{messageId,fragmentKey:`${messageId}:${index}`,fragmentIndex:index,text},`message:${messageId}:${index}`));
      event('message.completed',{messageId,finalFragmentIndex:fragments.length-1},`message:${messageId}:complete`);
    }
    return true;
  }
  // Reserved for a verified vendor output dialect. Plain ACP text has no progress/final distinction.
  get limitation():string{return 'typed_progress_and_final_unverified';}
}
