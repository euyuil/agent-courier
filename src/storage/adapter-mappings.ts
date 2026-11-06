import type { Connection } from './database.js';
import { getContent,putContent } from './content.js';
import { transaction } from './database.js';
export interface MappingStore { get(key:string):unknown;set(key:string,value:unknown):void }
export function adapterMappings(db:Connection,namespace:string):MappingStore {
  return {
    get(key){const row=db.prepare('SELECT contentRef FROM adapter_mappings WHERE namespace=? AND mappingKey=?').get(namespace,key) as {contentRef:string}|undefined;
      return row?JSON.parse(getContent(db,row.contentRef)) as unknown:undefined;},
    set(key,value){transaction(db,()=>{const ref=putContent(db,JSON.stringify(value));
      db.prepare('INSERT INTO adapter_mappings VALUES (?,?,?) ON CONFLICT(namespace,mappingKey) DO UPDATE SET contentRef=excluded.contentRef').run(namespace,key,ref);});},
  };
}
