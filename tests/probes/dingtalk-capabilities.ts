import { readFileSync,statSync,openSync,closeSync,writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { DWClient,TOPIC_ROBOT } from 'dingtalk-stream';
import { privateDirectory } from '../../src/storage/private-state.js';
import { normalizeCallback } from '../../src/adapters/dingtalk/normalize.js';
import { sendWebhook } from '../../src/adapters/dingtalk/webhook.js';
import type { DeliveryRoute,Recipient } from '../../src/adapters/dingtalk/port.js';
import { assertOutsideRepository } from '../../src/config/private.js';

const credentialsSchema=z.strictObject({clientId:z.string().min(1),clientSecret:z.string().min(1)});
export async function dingtalkIngressProbe(args:string[]):Promise<number> {
  const sendThree=args.includes('--send-three');args=args.filter(arg=>arg!=='--send-three');
  const environmentCredentials=args.length===4&&args[0]==='--enable-live'&&args[1]==='--credentials-env'&&args[2]==='--output';
  const fileCredentials=args.length===5&&args[0]==='--enable-live'&&args[1]==='--credentials'&&args[3]==='--output';
  if(!environmentCredentials&&!fileCredentials) {
    process.stderr.write('需要显式 --enable-live、--credentials-env 或私有凭据引用，以及 Git 外输出文件；可选 --send-three。\n');return 2;
  }
  let client:DWClient|undefined;
  let chatSendAttempts=0,confirmedSends=0;
  const consoleMethods={info:console.info,warn:console.warn,error:console.error,log:console.log};
  const marker=`Agent Courier probe ${randomUUID()}`;
  try {
    const output=resolve(args[environmentCredentials?3:4]!);
    assertOutsideRepository(output);
    let rawCredentials:unknown;
    if(environmentCredentials) {
      rawCredentials={clientId:process.env['DINGTALK_CLIENT_ID'],clientSecret:process.env['DINGTALK_CLIENT_SECRET']};
    } else {
      const file=resolve(args[2]!),info=statSync(file);
      if((info.mode&0o077)!==0 || (process.getuid&&info.uid!==process.getuid()) || file.startsWith(process.cwd()+'/'))throw new Error('private_configuration_required');
      rawCredentials=JSON.parse(readFileSync(file,'utf8')) as unknown;
    }
    const credentials=credentialsSchema.parse(rawCredentials);
    privateDirectory(dirname(output));const fd=openSync(output,'wx',0o600);closeSync(fd);
    // The upstream SDK logs transport errors containing endpoint details even with debug=false.
    console.info=console.warn=console.error=console.log=()=>{};
    client=new DWClient({...credentials,debug:false,keepAlive:false});client.config.autoReconnect=false;
    let callbacks=0,matchingCallbacks=0,missingOriginalId=0;
    let sendsStarted=false;
    const sendOutcomes:object[]=[],pendingSends=new Set<Promise<void>>();
    const originalIds=new Set<string>(),transportIds=new Set<string>();
    const privateObservations:object[]=[];
    client.registerCallbackListener(TOPIC_ROBOT,message=>{
      try {
        const data=JSON.parse(message.data) as Record<string,unknown>;callbacks++;
        if(data['conversationType']==='1' && data['msgtype']==='text' && typeof data['text']==='object'
          && data['text']!==null && 'content' in data['text'] && String(data['text'].content).trim()===marker) {
          matchingCallbacks++;transportIds.add(message.headers.messageId);
          if(typeof data['msgId']==='string')originalIds.add(data['msgId']);else missingOriginalId++;
          privateObservations.push({transportMessageId:message.headers.messageId,originalMessageId:data['msgId'],
            conversationId:data['conversationId'],senderId:data['senderId'],scope:data['chatbotCorpId'],robotCode:data['robotCode'],chatbotUserId:data['chatbotUserId'],
            hasWebhook:typeof data['sessionWebhook']==='string',webhookExpiresAt:data['sessionWebhookExpiredTime']});
        }
        const persist=()=>writeFileSync(output,JSON.stringify({sdkVersion:'2.1.5',observations:privateObservations,sendOutcomes},null,2),{mode:0o600});
        persist();
        client!.socketCallBackResponse(message.headers.messageId,{status:'SUCCESS'});
        if(sendThree && matchingCallbacks>0 && !sendsStarted && data['conversationType']==='1' && typeof data['text']==='object'
          && data['text']!==null && 'content' in data['text'] && String(data['text'].content).trim()===marker
          && typeof data['chatbotCorpId']==='string' && typeof data['robotCode']==='string') {
          const parsed=normalizeCallback(message.headers.messageId,data,{scope:data['chatbotCorpId'],robotCode:data['robotCode'],evidenceRef:'standalone-probe'},Date.now());
          if(parsed?.webhook && parsed.event.expiresAt!==undefined) {
            sendsStarted=true;
            const recipient:Recipient={id:'probe-recipient',platformScope:parsed.event.platformScope,robotId:parsed.event.robotId,platformConversationId:parsed.event.platformConversationId};
            const route:DeliveryRoute={id:'probe-route',recipientId:recipient.id,kind:'sessionWebhook',expiresAt:parsed.event.expiresAt,
              capabilityEvidenceId:'unadmitted-probe-only',status:'ready',verifiedLimits:{maxTextLength:1000,lengthUnit:'codepoints',routeTotal:3,
                rates:[{scope:'route',count:3,windowMs:60000}],evidenceRef:'bounded-experiment-not-production-limits'}};
            const task=(async()=>{
              for(let index=1;index<=3;index++) {
                sendOutcomes.push({index,status:'dispatching'});persist();chatSendAttempts++;
                const result=await sendWebhook(`${marker}\noutput ${index}/3`,recipient,route,{url:parsed.webhook!,recipient});
                sendOutcomes[sendOutcomes.length-1]={index,status:result.status};persist();
                if(result.status!=='confirmed')break;confirmedSends++;
                if(index<3)await new Promise(resolve=>setTimeout(resolve,1000));
              }
            })();
            pendingSends.add(task);void task.finally(()=>pendingSends.delete(task)).catch(()=>{});
          }
        }
      }catch{/* No raw callback, credential or SDK exception leaves this standalone probe. */}
    });
    const connectionTimeout=new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('connection_timeout')),10000);timer.unref();});
    await Promise.race([client.connect(),connectionTimeout]);
    if(!client.connected)throw new Error('connection_unavailable');
    process.stdout.write(JSON.stringify({status:'listening',environmentKind:'real_dingtalk',marker,windowSeconds:60,
      chatSendLimit:sendThree?3:0,chatSendAttempts:0})+'\n');
    await new Promise(resolve=>setTimeout(resolve,60000));
    await Promise.allSettled(pendingSends);
    process.stdout.write(JSON.stringify({status:'observed',callbacks,matchingCallbacks,distinctOriginalIds:originalIds.size,
      distinctTransportIds:transportIds.size,missingOriginalId,chatSendAttempts,confirmedSends,
      capabilityOutcome:'unverified',remaining:['reliable_redelivery_scope','official_limits','three_outputs','expiry_and_same_private_route','delivery_inspection']})+'\n');
    return matchingCallbacks?0:5;
  }catch{process.stderr.write(JSON.stringify({status:'blocked',code:'capability_unverified',chatSendAttempts,confirmedSends})+'\n');return 3;}
  finally{client?.disconnect();Object.assign(console,consoleMethods);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exit(await dingtalkIngressProbe(process.argv.slice(2)));
