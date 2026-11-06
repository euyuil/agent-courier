import { createHash } from 'node:crypto';
import type { Config } from '../../config/schema.js';
import type { Connection } from '../../storage/database.js';
import { getContent,putContent } from '../../storage/content.js';
import { newId } from '../../domain/common.js';
import { CourierError } from '../../domain/errors.js';
import { evidenceValid,type CapabilityEvidence,type EvidenceTarget } from '../../domain/capabilities.js';
import { decode,insert } from '../../storage/records.js';
import { saveEvidence } from '../../storage/capabilities.js';
import { adapterMappings } from '../../storage/adapter-mappings.js';
import { normalizeCallback } from './normalize.js';
import { sendWebhook,webhookUrl,type WebhookCapability } from './webhook.js';
import { inspectDelivery } from './inspect.js';
import { sendOto } from './oto.js';
import { DingTalkStream } from './stream.js';
import type { PlatformPort,DeliveryRoute,Recipient,NormalizedInbound,VerifiedLimits,SendResult,DeliveryInspection } from './port.js';

export interface DingTalkOptions {config:Config;db:Connection;target:EvidenceTarget;evidence:CapabilityEvidence[];limits:VerifiedLimits;
  credentials:()=>{clientId:string;clientSecret:string};request?:typeof fetch;now?:()=>number}
export class DingTalkClient implements PlatformPort {
  readonly stream=new DingTalkStream();
  constructor(private readonly options:DingTalkOptions){}
  private now():number{return this.options.now?.()??Date.now();}
  private evidence():CapabilityEvidence[] {
    return this.options.evidence.map(item=>decode<CapabilityEvidence>(this.options.db.prepare('SELECT * FROM capability_evidence WHERE id=?').get(item.id))??item);
  }
  admission():void {
    for(const capability of ['ingress','delivery'] as const)if(!this.evidence().some(evidence=>evidenceValid(evidence,this.options.target,this.now(),capability)))
      throw new CourierError('capability_unverified');
  }
  async connect(receive:(event:NormalizedInbound)=>Promise<unknown>,lost:()=>void):Promise<void> {
    this.admission();
    for(const evidence of this.options.evidence)if(!this.options.db.prepare('SELECT id FROM capability_evidence WHERE id=?').get(evidence.id))saveEvidence(this.options.db,evidence);
    await this.stream.connect(this.options.credentials(),async(id,raw)=>{
      this.admission();
      let data:unknown;try{data=JSON.parse(raw) as unknown;}catch{await this.ack(id);return;}
      const parsed=normalizeCallback(id,data,{scope:this.options.config.platform.scopeRef,robotCode:this.options.config.platform.robotRef,
        evidenceRef:this.evidence().find(evidence=>evidenceValid(evidence,this.options.target,this.now(),'ingress'))!.evidenceRef},this.now());
      if(!parsed){await this.ack(id);return;}
      if(parsed.event.conversationType==='private' && parsed.webhook && webhookUrl(parsed.webhook)) {
        parsed.event.sensitiveCapabilityRef=putContent(this.options.db,JSON.stringify({url:parsed.webhook,
          recipient:{platformScope:parsed.event.platformScope,robotId:parsed.event.robotId,platformConversationId:parsed.event.platformConversationId}}));
      }
      await receive(parsed.event);
    },lost);
  }
  persistInbound(event:NormalizedInbound,recipientId:string):void {
    if(!event.sensitiveCapabilityRef || event.expiresAt===undefined || event.expiresAt<=this.now())return;
    const capability=JSON.parse(getContent(this.options.db,event.sensitiveCapabilityRef)) as WebhookCapability;
    if(!webhookUrl(capability.url))return;
    const recipient=decode<Recipient>(this.options.db.prepare('SELECT * FROM recipients WHERE id=?').get(recipientId));
    if(!recipient || event.conversationType!=='private' || event.platformScope!==recipient.platformScope || event.robotId!==recipient.robotId
      || event.platformConversationId!==recipient.platformConversationId || capability.recipient.platformScope!==recipient.platformScope
      || capability.recipient.robotId!==recipient.robotId || capability.recipient.platformConversationId!==recipient.platformConversationId)
      throw new CourierError('protocol_conflict');
    const mappings=adapterMappings(this.options.db,'dingtalk-webhook');
    const key=createHash('sha256').update(JSON.stringify([recipientId,capability.url])).digest('hex');
    // A redelivered callback must not reset per-route attempt/rate budgets.
    if(mappings.get(key))return;
    const evidence=this.evidence().find(item=>evidenceValid(item,this.options.target,this.now(),'delivery'));
    if(!evidence)throw new CourierError('capability_unverified');
    const id=newId<'route'>();
    insert(this.options.db,'delivery_routes',{id,recipientId,kind:'sessionWebhook',sensitiveCapabilityRef:event.sensitiveCapabilityRef,
      expiresAt:event.expiresAt,verifiedLimits:this.options.limits,capabilityEvidenceId:evidence.id,status:'ready'});
    mappings.set(key,{routeId:id});
  }
  async ack(id:string):Promise<void>{await this.stream.ack(id);}
  async send(_deliveryId:string,recipient:Recipient,payload:string,route:DeliveryRoute):Promise<SendResult> {
    if(JSON.stringify(route.verifiedLimits)!==JSON.stringify(this.options.limits))return {status:'route_unavailable',code:'limit'};
    const raw=this.options.db.prepare('SELECT * FROM capability_evidence WHERE id=?').get(route.capabilityEvidenceId);
    const evidence=decode<CapabilityEvidence>(raw);
    if(!evidence || !evidenceValid(evidence,this.options.target,this.now(),route.kind==='oto'?'oto':'delivery'))return {status:'route_unavailable',code:'auth'};
    if(route.kind==='oto')return sendOto();
    if(!route.sensitiveCapabilityRef)return {status:'route_unavailable',code:'auth'};
    try {const capability=JSON.parse(getContent(this.options.db,route.sensitiveCapabilityRef)) as WebhookCapability;
      return await sendWebhook(payload,recipient,route,capability,this.options.request??fetch,this.now());}
    catch{return {status:'route_unavailable',code:'auth'};}
  }
  async inspectDelivery(_deliveryId:string):Promise<DeliveryInspection>{return inspectDelivery();}
  async close():Promise<void>{await this.stream.close();}
}
