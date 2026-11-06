import type { MappingStore } from '../../storage/adapter-mappings.js';
import { CourierError } from '../../domain/errors.js';
import { record } from './metadata.js';

// 只有宿主生命周期记录分区；实际 Harness 引用、归属及原生事件仍使用实例内的唯一索引。
export function managedRuntimeStore(store:MappingStore,courierSessionId?:string,required=false):MappingStore {
  if(courierSessionId===undefined)return store;
  const raw=store.get(`managed-host-scope:${courierSessionId}`);
  if(raw===undefined){if(required)throw new CourierError('state_unknown');return store;}
  if(record(raw)['mode']!=='isolated')throw new CourierError('state_unknown');
  const key=(value:string)=>value==='desktop-host'||value.startsWith('desktop-host-operation:')
    ?`managed-runtime:${JSON.stringify([courierSessionId,value])}`:value;
  return {get:value=>store.get(key(value)),set:(value,data)=>store.set(key(value),data)};
}
