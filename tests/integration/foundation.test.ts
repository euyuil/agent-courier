import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openDatabase, sqliteAtLeast, transaction } from '../../src/storage/database.js';
import { migrate } from '../../src/storage/migrate.js';
import { acquireInstanceLock } from '../../src/storage/instance-lock.js';
import { saveEvidence, invalidateEvidence, readEvidence } from '../../src/storage/capabilities.js';
import { FakeHarness } from '../fixtures/harness/fake-harness.js';
import { FakePlatform } from '../fixtures/platform/fake-platform.js';

test('SQLite version, FULL/WAL, foreign keys, migration order and rollback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'courier-test-')); const db = openDatabase(join(dir, 'state.db'));
  try {
    migrate(db); migrate(db);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('synchronous', { simple: true }), 2);
    assert.ok(sqliteAtLeast((db.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version));
    db.exec('CREATE TABLE rollback_test (id INTEGER)');
    assert.throws(() => transaction(db, () => { db.exec('INSERT INTO rollback_test VALUES (1)'); throw new Error('synthetic'); }));
    assert.throws(() => transaction(db, () => Promise.resolve('no_async')));
    assert.equal((db.prepare('SELECT count(*) AS n FROM rollback_test').get() as { n: number }).n, 0);
  } finally { db.close(); rmSync(dir, { recursive: true }); }
});

test('corrupt database remains intact and produces a safe error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'courier-test-')); const path = join(dir, 'bad.db');
  writeFileSync(path, 'synthetic-corruption', { mode: 0o600 });
  try { assert.throws(() => openDatabase(path), { message: 'storage_unavailable' }); }
  finally { rmSync(dir, { recursive: true }); }
});

test('lifecycle lock excludes a second process and SIGKILL releases it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'courier-lock-')); const path = join(dir, 'state.db');
  const module = new URL('../../src/storage/instance-lock.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import {acquireInstanceLock} from ${JSON.stringify(module)}; acquireInstanceLock(${JSON.stringify(path)}); process.stdout.write('ready'); setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const ready = once(child.stdout, 'data');
    const exitedEarly = once(child, 'exit').then(() => { throw new Error('child_lock_start_failed'); });
    const timeout = new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('child_lock_start_timeout')), 3000); timer.unref(); });
    const [data] = await Promise.race([ready, exitedEarly, timeout]); assert.equal(String(data), 'ready');
    assert.throws(() => acquireInstanceLock(path), { message: 'instance_locked' });
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const release = acquireInstanceLock(path); release(); release();
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true }); }
});

test('evidence facts are immutable; revocation is irreversible', async () => {
  const db = openDatabase(':memory:', { allowMemory: true }); migrate(db);
  try {
    const report = await new FakeHarness().probe('synthetic'); const evidence = report.evidenceRefs[0]!;
    saveEvidence(db, evidence);
    assert.throws(() => db.prepare('UPDATE capability_evidence SET checkedAt=checkedAt+1').run());
    invalidateEvidence(db, evidence.id, Date.now());
    assert.throws(() => db.prepare('UPDATE capability_evidence SET invalidatedAt=NULL').run());
    assert.equal(readEvidence(db, report).length, 1);
  } finally { db.close(); }
});

test('fake adapters perform no fetch and expose counted operations', async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network_forbidden'); };
  try {
    const harness = new FakeHarness(), platform = new FakePlatform();
    await harness.probe('synthetic');
    const receipt = await harness.createSession({ operationId: 'synthetic-op', courierSessionId: 'synthetic-courier' }).receipt;
    assert.equal(receipt.status, 'accepted'); assert.equal(harness.count('create'), 1);
    await platform.ack('synthetic-transport'); assert.equal(platform.acknowledgements.length, 1);
  } finally { globalThis.fetch = fetch; }
});
