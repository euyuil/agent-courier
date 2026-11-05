import type { Runtime } from './runtime.js';
import type { ErrorCode } from '../domain/errors.js';
import { diagnostic } from './diagnostics.js';
import { enqueue } from '../storage/delivery.js';
export function reportFailure(ctx:Runtime,subject:{recipientId:string;runId?:string;inputId?:string},code:ErrorCode):void {
  const key=subject.runId??subject.inputId!;
  const exists=ctx.db.prepare('SELECT 1 FROM failure_notices WHERE subjectId=? AND code=?').get(key,code);
  if(exists)return;
  const deliveryId=enqueue(ctx.db,{recipientId:subject.recipientId,...(subject.runId?{runId:subject.runId}:{}),
    ...(subject.inputId?{inputId:subject.inputId}:{}),payload:diagnostic(code).message});
  ctx.db.prepare('INSERT INTO failure_notices VALUES (?,?,?)').run(key,code,deliveryId);
}
