import { dirname,isAbsolute,resolve } from 'node:path';
export function resolveReference(configPath:string,reference:string):string {
  return isAbsolute(reference)?reference:resolve(dirname(configPath),reference);
}
