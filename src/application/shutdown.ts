import { CourierError,safeCode,type ErrorCode } from '../domain/errors.js';

export async function closeInOrder(actions:ReadonlyArray<()=>unknown|Promise<unknown>>):Promise<void> {
  let failed:ErrorCode|undefined;
  for(const action of actions) {
    try{await action();}catch(error){failed??=safeCode(error);}
  }
  if(failed)throw new CourierError(failed);
}
