import { metaField,record,requestRef,string,internalFrame } from './metadata.js';

export interface SteerTransition {ownerRef:string;nextRef:string}

export class WorkBuddyRunReferences {
  private current:string;
  private readonly owners=new Set<string>();
  private readonly transitions=new Map<string,string>();
  constructor(readonly runRef:string){this.current=runRef;this.owners.add(runRef);}
  get ownerRef():string{return this.current;}
  // 仅由已核对原操作、输入和 Run 的注入回执调用；不从最新输出猜测归属。
  advance(transition:SteerTransition):boolean {
    const {ownerRef,nextRef}=transition;
    if(!ownerRef||!nextRef||!this.owners.has(ownerRef))return false;
    if(ownerRef===nextRef)return true;
    const prior=this.transitions.get(ownerRef);if(prior!==undefined)return prior===nextRef;
    if(ownerRef!==this.current||this.owners.has(nextRef))return false;
    this.transitions.set(ownerRef,nextRef);this.owners.add(nextRef);this.current=nextRef;return true;
  }
  visibleOutput(params:Record<string,unknown>):boolean {
    const update=record(params['update']);
    if(!['agent_message_chunk','assistant_message_chunk'].includes(String(update['sessionUpdate'])))return false;
    return this.ownedOutput(params);
  }
  formattedToolOutput(params:Record<string,unknown>):boolean {
    const update=record(params['update']);
    if(!['tool_call','tool_call_update'].includes(String(update['sessionUpdate'])))return false;
    return this.ownedOutput(params);
  }
  private ownedOutput(params:Record<string,unknown>):boolean {
    const update=record(params['update']);
    if(internalFrame(params,update))return false;
    const ref=requestRef(update)??requestRef(params);if(!ref||!this.owners.has(ref))return false;
    for(const value of [update['requestId'],metaField(update['_meta'],'conversationRequestId'),metaField(update['_meta'],'requestId')])
      if(typeof value==='string'&&value!==ref)return false;
    if(ref===this.runRef)return true;
    return string(metaField(update['_meta'],'messageRequestId')??metaField(params['_meta'],'messageRequestId'))===this.runRef;
  }
}
