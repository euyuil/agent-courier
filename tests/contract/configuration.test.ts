import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync,chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../../src/config/schema.js';
import { loadConfig } from '../../src/config/load.js';
import { diagnostic, exportAliases, safeLog } from '../../src/application/diagnostics.js';
import { CourierError, safeCode } from '../../src/domain/errors.js';

const base = { schemaVersion: 1, storage: { databasePath: './state/db.sqlite' },
  platform: { kind: 'fake', scopeRef: 'synthetic-scope', robotRef: 'synthetic-robot' },
  harness: { instanceId: 'synthetic-instance', adapter: 'mock' } };
test('strict configuration rejects unknown fields, versions, retry budget and hidden human requests', () => {
  for (const config of [{ ...base, extra: true }, { ...base, schemaVersion: 2 },
    { ...base, delivery: { maxAutomaticRetries: 3 } }, { ...base, display: { defaults: { question: false } } },
    { ...base, display: { defaults: { permissionRequest: false } } }]) assert.equal(configSchema.safeParse(config).success, false);
  const valid = configSchema.parse(base);
  assert.equal(valid.display.defaults.progress, true); assert.equal(valid.display.defaults.message, false);
});
test('fake config does not read real references; private relative files work for real static validation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'courier-config-')); const file = join(dir, 'config.json');
  try {
    writeFileSync(file, JSON.stringify({ ...base, platform: { ...base.platform, clientIdRef: './does-not-exist' } }));
    assert.equal(loadConfig(file).storage.databasePath, join(dir, 'state/db.sqlite'));
    writeFileSync(join(dir, 'secret.json'), 'synthetic-sensitive', { mode: 0o600 });
    writeFileSync(file, JSON.stringify({ ...base,
      platform: { kind: 'dingtalk-stream', scopeRef: 'synthetic', robotRef: 'synthetic', clientIdRef: './secret.json', clientSecretRef: './secret.json', limitProfileRef: './secret.json' },
      harness: { instanceId: 'synthetic', adapter: 'workbuddy-experimental', connectionProfileRef: './secret.json', capabilityEvidenceRef: './secret.json' } }));
    chmodSync(file,0o600);assert.equal(loadConfig(file).platform.kind, 'dingtalk-stream');
    writeFileSync(file, '{invalid synthetic secret');
    assert.throws(() => loadConfig(file), { message: 'configuration_invalid' });
  } finally { rmSync(dir, { recursive: true }); }
});
test('diagnostics accept safe codes and shared exports remap local identifiers', () => {
  assert.equal(safeCode(new Error('synthetic-token-and-private-path')), 'state_unknown');
  const result = diagnostic(safeCode(new CourierError('writer_occupied')), 'not_submitted');
  assert.equal(result.fact, 'not_submitted'); assert.match(result.message, /写入权/);
  assert.deepEqual(exportAliases([safeLog('state_unknown', 'synthetic-private-local-id')]), [{ code: 'state_unknown', localId: 'local-1' }]);
});
