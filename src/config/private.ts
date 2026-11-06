import { readFileSync,lstatSync,realpathSync,existsSync } from 'node:fs';
import { dirname,resolve,sep,relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CourierError } from '../domain/errors.js';
import { resolveReference } from './reference.js';
function repositoryRoot():string {
  let root=dirname(fileURLToPath(import.meta.url));
  while(!existsSync(resolve(root,'package.json'))&&root!==dirname(root))root=dirname(root);
  return realpathSync(root);
}
export function assertOutsideRepository(path:string):void {
  let ancestor=resolve(path);while(!existsSync(ancestor))ancestor=dirname(ancestor);
  const target=resolve(realpathSync(ancestor),relative(ancestor,resolve(path))),root=repositoryRoot();
  if(target===root||target.startsWith(root+sep))throw new CourierError('configuration_invalid');
}

export function privateFile(configPath:string,reference:string):string {
  try {
    const path=resolveReference(configPath,reference),info=lstatSync(path);
    const target=realpathSync(path),parent=lstatSync(dirname(target));assertOutsideRepository(target);
    if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||(process.getuid&&info.uid!==process.getuid())
      ||!parent.isDirectory()||(parent.mode&0o077)!==0||(process.getuid&&parent.uid!==process.getuid()))throw new Error('private_file_required');
    return target;
  }catch{throw new CourierError('configuration_invalid');}
}
export function readPrivateJson(configPath:string,reference:string):unknown {
  try{return JSON.parse(readFileSync(privateFile(configPath,reference),'utf8')) as unknown;}
  catch{throw new CourierError('configuration_invalid');}
}
export function credential(configPath:string,reference:string):string {
  try {
    const name=/^env:([A-Z][A-Z0-9_]*)$/.exec(reference)?.[1];
    const value=name?process.env[name]:readFileSync(privateFile(configPath,reference),'utf8').trim();
    if(!value)throw new Error('credential_required');return value;
  }catch{throw new CourierError('auth_required');}
}
