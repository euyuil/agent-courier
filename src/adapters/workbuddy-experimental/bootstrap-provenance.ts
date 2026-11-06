import type { MappingStore } from '../../storage/adapter-mappings.js';
import { CourierError } from '../../domain/errors.js';
import { record } from './metadata.js';

export interface BootstrapRunProvenance {runRef:string;owners:string[];inputs:string[]}
export function bootstrapProvenance(store:MappingStore,host:string):BootstrapRunProvenance[] {
  const value=store.get(`bootstrap-provenance:${host}`);if(value===undefined)return [];
  if(!Array.isArray(value))throw new CourierError('state_unknown');
  let size=0;const seen=new Set<string>();
  for(const item of value) {
    const entry=record(item),run=entry['runRef'],owners=entry['owners'],inputs=entry['inputs'];
    if(typeof run!=='string'||!run||seen.has(run)||!Array.isArray(owners)||!owners.includes(run)||!Array.isArray(inputs)||
      [...owners,...inputs].some(ref=>typeof ref!=='string'||!ref))throw new CourierError('state_unknown');
    seen.add(run);size+=owners.length+inputs.length;if(size>4096)throw new CourierError('state_unknown');
  }
  return structuredClone(value) as BootstrapRunProvenance[];
}
export function rememberBootstrapRun(store:MappingStore,host:string,runRef:string,inputId:string,nextOwner?:string):void {
  const entries=bootstrapProvenance(store,host);let run=entries.find(entry=>entry.runRef===runRef);
  if(!run){run={runRef,owners:[runRef],inputs:[]};entries.push(run);}
  if(!run.inputs.includes(inputId))run.inputs.push(inputId);
  if(nextOwner) {
    if(entries.some(entry=>entry!==run&&entry.owners.includes(nextOwner)))throw new CourierError('protocol_conflict');
    if(!run.owners.includes(nextOwner))run.owners.push(nextOwner);
  }
  if(entries.reduce((size,entry)=>size+entry.owners.length+entry.inputs.length,0)>4096)throw new CourierError('state_unknown');
  store.set(`bootstrap-provenance:${host}`,entries);
}
