import { randomBytes } from 'node:crypto';
export function record(value:unknown):Record<string,unknown> {return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
export function string(value:unknown):string|undefined {return typeof value==='string'&&value.length>0?value:undefined;}
export function metaField(value:unknown,key:string):unknown {
  const meta=record(value);return meta[`codebuddy.ai/${key}`]??record(meta['codebuddy.ai'])[key]??meta[key];
}
export function requestRef(update:Record<string,unknown>):string|undefined {
  return string(update['requestId'])??string(metaField(update['_meta'],'conversationRequestId'))??string(metaField(update['_meta'],'requestId'));
}
export function newRequestRef():string {
  const bytes=randomBytes(16);bytes.writeUIntBE(Date.now(),0,6);bytes[6]=(bytes[6]!&15)|0x70;bytes[8]=(bytes[8]!&63)|0x80;
  return bytes.toString('hex');
}
export function internalFrame(params:Record<string,unknown>,update:Record<string,unknown>):boolean {
  const metas=[params['_meta'],update['_meta'],record(update['content'])['_meta']];
  return metas.some(meta=>metaField(meta,'mode')==='history'||['isSubAgent','isTeamMember','parentSessionId','memberEvent','parentToolCallId','teamUpdate','isCompactInternal',
    'compactType','isSessionSeparator','rendererHistoryReplay','ownerSnapshotHistoryReplay','historyReplay']
    .some(key=>{const value=metaField(meta,key);return value!==undefined&&value!==false;}));
}
