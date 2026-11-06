import { parentPort,workerData } from 'node:worker_threads';
import { DWClient,TOPIC_ROBOT } from 'dingtalk-stream';

// The SDK emits raw endpoint/error details independently of debug=false.
// Keep that behavior inside an isolated worker; never silence the application console.
console.info=console.warn=console.error=console.log=console.debug=()=>{};
const port=parentPort!;
const credentials=workerData as {clientId:string;clientSecret:string};
const client=new DWClient({...credentials,debug:false,keepAlive:true});
client.config.autoReconnect=false;
client.registerCallbackListener(TOPIC_ROBOT,message=>{
  port.postMessage({type:'callback',transportMessageId:message.headers.messageId,data:message.data});
});
port.on('message',(message:{type:string;transportMessageId?:string})=>{
  if(message.type==='stop'){client.disconnect();process.exit(0);}
  if(message.type==='ack' && message.transportMessageId) {
    try {
      if(!client.connected)throw new Error('disconnected');
      client.socketCallBackResponse(message.transportMessageId,{status:'SUCCESS'});
      port.postMessage({type:'acked',transportMessageId:message.transportMessageId});
    }catch{port.postMessage({type:'ack_failed',transportMessageId:message.transportMessageId});}
  }
});
try {
  await client.connect();
  if(!client.connected)throw new Error('disconnected');
  port.postMessage({type:'ready'});
  const timer=setInterval(()=>{
    if(!client.connected){clearInterval(timer);port.postMessage({type:'lost'});client.disconnect();process.exit(3);}
  },1000);
}catch{port.postMessage({type:'failed'});process.exit(3);}
