import Database from 'better-sqlite3';
import { chmodSync, existsSync, lstatSync, mkdirSync, statfsSync,realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { CourierError } from '../domain/errors.js';

export type Connection = Database.Database;
const networkTypes = new Set([0x6969, 0x517b, 0xff534d42, 0x01021997]);
export function checkLocalPath(path: string): void {
  let ancestor = existsSync(path) ? path : dirname(path);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (networkTypes.has(Number(statfsSync(ancestor).type))) throw new CourierError('storage_unavailable');
  let component = resolve(path);
  while (component !== dirname(component)) {
    if (existsSync(component) && lstatSync(component).isSymbolicLink()) throw new CourierError('storage_unavailable');
    component = dirname(component);
  }
}
export function sqliteAtLeast(actual: string, minimum = '3.51.3'): boolean {
  const a = actual.split('.').map(Number), b = minimum.split('.').map(Number);
  if (a.length !== 3 || a.some(n => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return true;
}
export function openDatabase(path: string, options: { readonly?: boolean; allowMemory?: boolean } = {}): Connection {
  let db: Connection | undefined;
  try {
    if (path === ':memory:') {
      if (!options.allowMemory) throw new CourierError('storage_unavailable');
    } else {
      const resolved = resolve(path);
      let repository=dirname(new URL(import.meta.url).pathname);
      while(!existsSync(resolve(repository,'package.json')) && repository!==dirname(repository))repository=dirname(repository);
      repository=realpathSync(repository);
      if (resolved === repository || resolved.startsWith(repository + sep)) throw new CourierError('storage_unavailable');
      checkLocalPath(path);
      if (!options.readonly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const parent = lstatSync(dirname(path));
      if ((parent.mode & 0o077) !== 0 || (process.getuid && parent.uid !== process.getuid())) throw new CourierError('storage_unavailable');
      if (existsSync(path) && (lstatSync(path).mode & 0o077) !== 0) throw new CourierError('storage_unavailable');
    }
    db = new Database(path, { readonly: options.readonly ?? false, fileMustExist: options.readonly ?? false, timeout: 0 });
    const version = db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
    if (!sqliteAtLeast(version.version)) throw new CourierError('storage_unavailable');
    db.pragma('foreign_keys = ON');
    if (!options.readonly) {
      db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
      if (path !== ':memory:') chmodSync(path, 0o600);
    }
    const check = db.pragma('quick_check', { simple: true });
    if (check !== 'ok') throw new CourierError('storage_unavailable');
    return db;
  } catch { db?.close(); throw new CourierError('storage_unavailable'); }
}

export function transaction<T>(db: Connection, work: () => T): T {
  return db.transaction(() => {
    const value = work();
    if (value !== null && typeof value === 'object' && 'then' in value) throw new CourierError('storage_unavailable');
    return value;
  }).immediate();
}
