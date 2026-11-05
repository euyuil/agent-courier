import type { Connection } from '../storage/database.js';
import type { NormalizedInbound } from '../adapters/dingtalk/port.js';
import { inputByMessage } from '../storage/inputs.js';
import { getContent } from '../storage/content.js';
export function previousInput(db:Connection,event:NormalizedInbound) {
  if (!event.dedupNamespace || !event.originalMessageId) return undefined;
  const input=inputByMessage(db,event.dedupNamespace,event.originalMessageId);
  if (!input) return undefined;
  const conversation=db.prepare('SELECT platformScope,robotId,platformConversationId FROM platform_conversations WHERE id=?').get(input.platformConversationId) as {platformScope:string;robotId:string;platformConversationId:string};
  return {input,conflict:getContent(db,input.textRef)!==(event.text??'') || conversation.platformScope!==event.platformScope
    || conversation.robotId!==event.robotId || conversation.platformConversationId!==event.platformConversationId};
}
