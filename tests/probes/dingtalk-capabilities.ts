import { readFileSync,statSync,openSync,closeSync,writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { DWClient,TOPIC_ROBOT } from 'dingtalk-stream';
import { privateDirectory } from '../../src/storage/private-state.js';

const credentialsSchema=z.strictObject({clientId:z.string().min(1),clientSecret:z.string().min(1)});
export async function dingtalkIngressProbe(args:string[]):Promise<number> {
  const environmentCredentials=args.length===4&&args[0]==='--enable-live'&&args[1]==='--credentials-env'&&args[2]==='--output';
  const fileCredentials=args.length===5&&args[0]==='--enable-live'&&args[1]==='--credentials'&&args[3]==='--output';
  if(!environmentCredentials&&!fileCredentials) {
    process.stderr.write('需要显式 --enable-live、--credentials-env 或私有凭据引用，以及 Git 外输出文件。\n');return 2;
  }
  let client:DWClient|undefined;
  const consoleMethods={info:console.info,warn:console.warn,error:console.error,log:console.log};
  const marker=`Agent Courier probe ${randomUUID()}`;
  try {
    const output=resolve(args[environmentCredentials?3:4]!);
    if(output.startsWith(process.cwd()+'/'))throw new Error('private_configuration_required');
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
            conversationId:data['conversationId'],scope:data['chatbotCorpId'],robotCode:data['robotCode'],chatbotUserId:data['chatbotUserId'],
            hasWebhook:typeof data['sessionWebhook']==='string',webhookExpiresAt:data['sessionWebhookExpiredTime']});
        }
        writeFileSync(output,JSON.stringify({sdkVersion:'2.1.5',observations:privateObservations},null,2),{mode:0o600});
        client!.socketCallBackResponse(message.headers.messageId,{status:'SUCCESS'});
      }catch{/* No raw callback, credential or SDK exception leaves this standalone probe. */}
    });
    const connectionTimeout=new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('connection_timeout')),10000);timer.unref();});
    await Promise.race([client.connect(),connectionTimeout]);
    if(!client.connected)throw new Error('connection_unavailable');
    process.stdout.write(JSON.stringify({status:'listening',environmentKind:'real_dingtalk',marker,windowSeconds:60,chatMessagesSent:0})+'\n');
    await new Promise(resolve=>setTimeout(resolve,60000));
    process.stdout.write(JSON.stringify({status:'observed',callbacks,matchingCallbacks,distinctOriginalIds:originalIds.size,
      distinctTransportIds:transportIds.size,missingOriginalId,chatMessagesSent:0,
      capabilityOutcome:'unverified',remaining:['reliable_redelivery_scope','official_limits','three_outputs','expiry_and_same_private_route','delivery_inspection']})+'\n');
    return matchingCallbacks?0:5;
  }catch{process.stderr.write(JSON.stringify({status:'blocked',code:'capability_unverified',chatMessagesSent:0})+'\n');return 3;}
  finally{client?.disconnect();Object.assign(console,consoleMethods);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exit(await dingtalkIngressProbe(process.argv.slice(2)));
