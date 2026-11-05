import type { AnswerSchema,Option } from './answer.js';
export interface PendingInput {
  id:string;runId:string;bindingId:string;platformConversationId:string;vendorRequestId:string;sourceMessageId:string;
  kind:'question'|'permission';publicCode:string;promptRef?:string;answerSchema?:AnswerSchema;options?:Option[];adapterMappingRef:string;
  validity:'open'|'withdrawn'|'expired'|'closed_by_run';answerStatus:'none'|'dispatching'|'accepted'|'rejected'|'unknown';answerInputId?:string;revision:number;
}
