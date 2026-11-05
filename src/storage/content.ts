import type { Connection } from './database.js';
import { newId } from '../domain/common.js';
import { CourierError } from '../domain/errors.js';
export function putContent(db: Connection, content: string): string {
  const id = newId<'content'>(); db.prepare('INSERT INTO private_content VALUES (?,?)').run(id, content); return id;
}
export function getContent(db: Connection, id: string): string {
  const row = db.prepare('SELECT content FROM private_content WHERE id=?').get(id) as { content: string } | undefined;
  if (!row) throw new CourierError('storage_unavailable'); return row.content;
}
