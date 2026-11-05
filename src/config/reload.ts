import { configSchema,type Config } from './schema.js';
import { CourierError } from '../domain/errors.js';
export function reloadConfig(current:Config,raw:unknown):Config {
  const result=configSchema.safeParse(raw);if(!result.success)throw new CourierError('configuration_invalid');
  const next=result.data;
  if(current.storage.databasePath!==next.storage.databasePath || JSON.stringify(current.platform)!==JSON.stringify(next.platform)
    || JSON.stringify(current.harness)!==JSON.stringify(next.harness))throw new CourierError('configuration_invalid');
  return next;
}
