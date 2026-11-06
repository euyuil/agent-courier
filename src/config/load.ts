import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { configSchema, type Config } from './schema.js';
import { CourierError } from '../domain/errors.js';
import { resolveReference } from './reference.js';
import { privateFile } from './private.js';
import { readPrivateJson } from './private.js';
import { connectionProfileSchema,platformProfileSchema,evidenceSchema } from './real-profiles.js';
import { z } from 'zod';
export { resolveReference } from './reference.js';
export function loadConfig(path: string): Config {
  try {
    const config = configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    config.storage.databasePath = resolveReference(path, config.storage.databasePath);
    if (config.platform.kind !== 'fake') {
      privateFile(path,resolve(path));
      for (const reference of [config.platform.clientIdRef, config.platform.clientSecretRef, config.platform.limitProfileRef,
        config.platform.otoRouteEvidenceRef, config.harness.connectionProfileRef, config.harness.capabilityEvidenceRef]) {
        if (!reference) continue;
        if((reference===config.platform.clientIdRef||reference===config.platform.clientSecretRef)&&/^env:[A-Z][A-Z0-9_]*$/.test(reference))continue;
        privateFile(path,reference);
      }
      connectionProfileSchema.parse(readPrivateJson(path,config.harness.connectionProfileRef!));
      platformProfileSchema.parse(readPrivateJson(path,config.platform.limitProfileRef!));
      z.array(evidenceSchema).parse(readPrivateJson(path,config.harness.capabilityEvidenceRef!));
    }
    return config;
  } catch { throw new CourierError('configuration_invalid'); }
}
