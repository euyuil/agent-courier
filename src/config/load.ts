import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { configSchema, type Config } from './schema.js';
import { CourierError } from '../domain/errors.js';

export function resolveReference(configPath: string, reference: string): string {
  return isAbsolute(reference) ? reference : resolve(dirname(configPath), reference);
}
export function loadConfig(path: string): Config {
  try {
    const config = configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    config.storage.databasePath = resolveReference(path, config.storage.databasePath);
    if (config.platform.kind !== 'fake') {
      if((statSync(path).mode&0o077)!==0)throw new CourierError('configuration_invalid');
      for (const reference of [config.platform.clientIdRef, config.platform.clientSecretRef, config.platform.limitProfileRef,
        config.platform.otoRouteEvidenceRef, config.harness.connectionProfileRef, config.harness.capabilityEvidenceRef]) {
        if (!reference) continue;
        const info = statSync(resolveReference(path, reference));
        if (!info.isFile() || (info.mode & 0o077) !== 0) throw new CourierError('configuration_invalid');
      }
    }
    return config;
  } catch { throw new CourierError('configuration_invalid'); }
}
