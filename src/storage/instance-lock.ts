import Database from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import { openDatabase } from './database.js';
import { CourierError } from '../domain/errors.js';

export function acquireInstanceLock(databasePath: string): () => void {
  let db: Database.Database | undefined;
  try {
    const path = `${databasePath}.lock.db`;
    const initial = openDatabase(path);
    initial.close();
    db = new Database(path, { timeout: 0 });
    db.pragma('journal_mode = DELETE');
    db.exec('BEGIN EXCLUSIVE');
    chmodSync(path, 0o600);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      db!.exec('ROLLBACK'); db!.close();
    };
  } catch { db?.close(); throw new CourierError('instance_locked'); }
}
