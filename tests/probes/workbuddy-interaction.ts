import { interaction,mergeInteraction,type InteractionMapping } from '../../src/adapters/workbuddy-experimental/interaction.js';
import { record,string,requestRef,internalFrame } from '../../src/adapters/workbuddy-experimental/metadata.js';
import type { RpcMessage } from '../../src/adapters/workbuddy-experimental/connection.js';

export function observedInteraction(value:unknown,kind:'question'|'permission',nativeToolName:string):
  {mapping:InteractionMapping;sourceCount:number}|undefined {
  const snapshot=record(value),session=string(snapshot['sessionRef']),tool=string(snapshot['toolCallId']);
  if(!session||!tool||!Array.isArray(snapshot['toolUpdates'])||!Array.isArray(snapshot['messages']))return undefined;
  const owners=new Set<string>();
  for(const raw of snapshot['toolUpdates']) {
    const update=record(raw);
    if(update['sessionUpdate']!=='tool_call'||update['toolCallId']!==tool||internalFrame({},update))continue;
    const owner=requestRef(update);if(owner)owners.add(owner);
  }
  if(owners.size!==1)return undefined;const run=[...owners][0]!;
  let mapping:InteractionMapping|undefined,sourceCount=0;
  for(const raw of snapshot['messages']) {
    const message=record(raw) as unknown as RpcMessage,next=interaction(message,session,run,'independent-interaction-probe');
    if(!next||next.toolCallId!==tool||next.kind!==kind||next.nativeToolName!==nativeToolName)continue;
    if(mapping){const combined=mergeInteraction(mapping,next);if(!combined)return undefined;mapping=combined;}
    else mapping=next;
    sourceCount++;
  }
  return mapping?{mapping,sourceCount}:undefined;
}
