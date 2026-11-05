import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type Config } from '../../src/config/schema.js';
import { openDatabase } from '../../src/storage/database.js';
import { migrate } from '../../src/storage/migrate.js';
import { Courier } from '../../src/application/courier.js';
import { FakeHarness } from './harness/fake-harness.js';
import { FakePlatform } from './platform/fake-platform.js';
import { VirtualClock } from './clock.js';
import type { CourierDependencies } from '../../src/application/runtime.js';
import type { DeliveryRoute,VerifiedLimits } from '../../src/adapters/dingtalk/port.js';
import { syntheticPlatformEvidence } from '../../src/adapters/testing/evidence.js';
import { saveEvidence } from '../../src/storage/capabilities.js';
import { update } from '../../src/storage/records.js';

export function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'courier-rig-')), path = join(dir, 'state.sqlite');
  const clock = new VirtualClock(), harness = new FakeHarness({ clock }), platform = new FakePlatform(clock);
  let config: Config = configSchema.parse({ schemaVersion: 1, storage: { databasePath: path },
    platform: { kind: 'fake', scopeRef: 'synthetic-scope', robotRef: 'synthetic-robot' },
    harness: { instanceId: 'synthetic-harness', adapter: 'mock' } });
  let db = openDatabase(path); migrate(db);
  let boundary: CourierDependencies['effectBoundary'];
  let eventBoundary: CourierDependencies['eventBoundary'];
  let courier = new Courier({ config, db, harness, platform, clock });
  return {
    get db() { return db; }, get courier() { return courier; }, config, clock, harness, platform,
    async restart(nextConfig = config) {
      await courier.close(); db.close(); db = openDatabase(path); migrate(db); config = nextConfig;
      courier = new Courier({ config, db, harness, platform, clock,
        ...(boundary ? {effectBoundary:boundary} : {}),...(eventBoundary ? {eventBoundary} : {}) });
    },
    async dispose() { await courier.close(); db.close(); rmSync(dir, { recursive: true }); },
    count(table: string) { return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n; },
    boundary(callback: CourierDependencies['effectBoundary']) {boundary=callback;if(callback)courier.runtime.effectBoundary=callback;else delete courier.runtime.effectBoundary;},
    eventBoundary(callback: CourierDependencies['eventBoundary']) {eventBoundary=callback;if(callback)courier.runtime.eventBoundary=callback;else delete courier.runtime.eventBoundary;},
    setLimits(route:DeliveryRoute,limits:VerifiedLimits){
      const evidence=syntheticPlatformEvidence(courier.runtime.config,clock.now(),limits);saveEvidence(db,evidence);
      update(db,'delivery_routes',route.id,{verifiedLimits:limits,capabilityEvidenceId:evidence.id});
    },
  };
}
