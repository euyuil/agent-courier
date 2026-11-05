import type { Runtime } from '../application/runtime.js';
import type { OutputMessage } from '../domain/output.js';
import { newId } from '../domain/common.js';
import { byId,insert,update } from '../storage/records.js';
import { getContent,putContent } from '../storage/content.js';

export function invalidateMessage(ctx:Runtime,message:OutputMessage):void {
  update(ctx.db,'output_messages',message.id,{completeness:'invalid'});ctx.diagnostics.push({code:'protocol_conflict',localId:message.id});
  ctx.db.prepare("UPDATE outbound_deliveries SET status='failed',errorCode='protocol_conflict' WHERE attemptCount=0 AND status='pending' AND id IN (SELECT deliveryId FROM delivery_messages WHERE outputMessageId=?)").run(message.id);
}
export function addFragment(ctx:Runtime,message:OutputMessage,fragment:{fragmentKey:string;fragmentIndex:number;text:string}):void {
  if(message.completeness==='invalid')return;
  if(!fragment.fragmentKey || !Number.isInteger(fragment.fragmentIndex) || fragment.fragmentIndex<0){invalidateMessage(ctx,message);return;}
  const byKey=ctx.db.prepare('SELECT sourceFragmentKey,fragmentIndex,textRef FROM output_fragments WHERE outputMessageId=? AND sourceFragmentKey=?').get(message.id,fragment.fragmentKey) as {sourceFragmentKey:string;fragmentIndex:number;textRef:string}|undefined;
  const byIndex=ctx.db.prepare('SELECT sourceFragmentKey FROM output_fragments WHERE outputMessageId=? AND fragmentIndex=?').get(message.id,fragment.fragmentIndex) as {sourceFragmentKey:string}|undefined;
  const boundary=ctx.db.prepare('SELECT finalFragmentIndex FROM output_messages WHERE id=?').get(message.id) as {finalFragmentIndex:number|null};
  if((byKey && (byKey.fragmentIndex!==fragment.fragmentIndex || getContent(ctx.db,byKey.textRef)!==fragment.text))
    || (byIndex && byIndex.sourceFragmentKey!==fragment.fragmentKey) || (boundary.finalFragmentIndex!==null && fragment.fragmentIndex>boundary.finalFragmentIndex)) {
    invalidateMessage(ctx,message);return;
  }
  if(!byKey)insert(ctx.db,'output_fragments',{id:newId<'fragment'>(),outputMessageId:message.id,sourceFragmentKey:fragment.fragmentKey,fragmentIndex:fragment.fragmentIndex,textRef:putContent(ctx.db,fragment.text)});
  finishIfComplete(ctx,message.id);
}
export function completeMessage(ctx:Runtime,message:OutputMessage,finalFragmentIndex:number):void {
  if(message.completeness==='invalid')return;
  const current=ctx.db.prepare('SELECT finalFragmentIndex FROM output_messages WHERE id=?').get(message.id) as {finalFragmentIndex:number|null};
  const extra=ctx.db.prepare('SELECT 1 FROM output_fragments WHERE outputMessageId=? AND fragmentIndex>?').get(message.id,finalFragmentIndex);
  if(!Number.isInteger(finalFragmentIndex) || finalFragmentIndex< -1 || extra || (current.finalFragmentIndex!==null&&current.finalFragmentIndex!==finalFragmentIndex)) {
    invalidateMessage(ctx,message);return;
  }
  update(ctx.db,'output_messages',message.id,{finalFragmentIndex});finishIfComplete(ctx,message.id);
}
function finishIfComplete(ctx:Runtime,id:string):void {
  const message=byId<OutputMessage>(ctx.db,'output_messages',id)!;
  if(message.completeness!=='assembling')return;
  const boundary=ctx.db.prepare('SELECT finalFragmentIndex FROM output_messages WHERE id=?').get(id) as {finalFragmentIndex:number|null};
  if(boundary.finalFragmentIndex===null)return;
  const fragments=ctx.db.prepare('SELECT fragmentIndex,textRef FROM output_fragments WHERE outputMessageId=? ORDER BY fragmentIndex').all(id) as {fragmentIndex:number;textRef:string}[];
  if(fragments.length!==boundary.finalFragmentIndex+1 || fragments.some((f,index)=>f.fragmentIndex!==index))return;
  update(ctx.db,'output_messages',id,{completeness:'complete',contentRef:putContent(ctx.db,fragments.map(f=>getContent(ctx.db,f.textRef)).join(''))});
}
