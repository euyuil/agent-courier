import { z } from 'zod';
import type { NormalizedInbound } from './port.js';

const callbackSchema=z.object({msgId:z.string().min(1),chatbotCorpId:z.string().min(1),robotCode:z.string().min(1),
  chatbotUserId:z.string().optional(),conversationId:z.string().min(1),conversationType:z.string(),senderId:z.string().min(1),
  senderStaffId:z.string().optional(),msgtype:z.string(),text:z.object({content:z.string()}).optional(),
  sessionWebhook:z.string().optional(),sessionWebhookExpiredTime:z.number().finite().optional()});
export interface IngressContext { scope:string; robotCode:string; evidenceRef:string }
export function normalizeCallback(transportMessageId:string,raw:unknown,context:IngressContext,now:number):
  {event:NormalizedInbound;webhook?:string}|undefined {
  const parsed=callbackSchema.safeParse(raw);
  if(!parsed.success || !transportMessageId)return undefined;
  const data=parsed.data;
  if(data.chatbotCorpId!==context.scope || data.robotCode!==context.robotCode)return undefined;
  const event:NormalizedInbound={transportMessageId,originalMessageId:data.msgId,platformScope:data.chatbotCorpId,
    robotId:data.robotCode,robotCode:data.robotCode,platformConversationId:data.conversationId,
    conversationType:data.conversationType==='1'?'private':data.conversationType==='2'?'group':'unknown',
    senderId:data.senderId,contentType:data.msgtype,receivedAt:now,
    dedupNamespace:JSON.stringify(['dingtalk',data.chatbotCorpId,data.robotCode,data.conversationId,data.senderId]),
    evidenceRef:context.evidenceRef};
  if(data.chatbotUserId)event.chatbotUserId=data.chatbotUserId;
  if(data.senderStaffId)event.enterpriseUserId=data.senderStaffId;
  if(data.text)event.text=data.text.content;
  if(data.sessionWebhookExpiredTime!==undefined)event.expiresAt=data.sessionWebhookExpiredTime;
  return {event,...(data.sessionWebhook?{webhook:data.sessionWebhook}:{})};
}
