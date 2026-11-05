import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Connection } from './database.js';
import { transaction } from './database.js';
import { CourierError } from '../domain/errors.js';

export function migrate(db: Connection): void {
  try {
    const directory = fileURLToPath(new URL('./migrations/', import.meta.url));
    const files = readdirSync(directory).filter(name => /^\d{3}-[\w-]+\.sql$/.test(name)).sort();
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version > files.length) throw new CourierError('storage_unavailable');
    files.forEach((name, index) => {
      if (Number(name.slice(0, 3)) !== index + 1) throw new CourierError('storage_unavailable');
      if (index < version) return;
      transaction(db, () => { db.exec(readFileSync(new URL(`./migrations/${name}`, import.meta.url), 'utf8')); db.pragma(`user_version = ${index + 1}`); });
    });
    const foreignKeyProblems=db.pragma('foreign_key_check') as unknown[];
    if(foreignKeyProblems.length)throw new CourierError('storage_unavailable');
  } catch { throw new CourierError('storage_unavailable'); }
}
