import type { Runtime } from '../application/runtime.js';
import { transaction } from '../storage/database.js';
import { mergeProgress } from './merge-progress.js';
import { flushDeliveries } from './scheduler.js';
export async function scheduleOutput(ctx:Runtime):Promise<void> {
  transaction(ctx.db,()=>mergeProgress(ctx));await flushDeliveries(ctx);
}
