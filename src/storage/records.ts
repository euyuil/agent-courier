import type { Connection } from './database.js';

export type Table = 'platform_identities' | 'recipients' | 'platform_conversations' | 'courier_sessions' | 'harness_bindings'
  | 'inputs' | 'inbound_receipts' | 'runs' | 'harness_operations' | 'harness_events' | 'output_messages' | 'output_fragments'
  | 'outbound_deliveries' | 'delivery_attempts' | 'delivery_routes' | 'pending_inputs';
const jsonColumns = new Set(['scope', 'policySnapshot', 'logicalMessageIds', 'verifiedLimits', 'answerSchema', 'options']);
function encode(key: string, value: unknown): unknown {
  if (value === undefined) return null;
  if (jsonColumns.has(key)) return JSON.stringify(value);
  return typeof value === 'boolean' ? Number(value) : value;
}
export function decode<T>(row: unknown): T | undefined {
  if (!row) return undefined;
  return Object.fromEntries(Object.entries(row).filter(([,value]) => value !== null).map(([key, value]) =>
    [key, jsonColumns.has(key) ? JSON.parse(value as string) as unknown : ['userVisible','selected'].includes(key) ? !!value : value])) as T;
}
export function insert(db: Connection, table: Table, record: object): void {
  const entries = Object.entries(record);
  db.prepare(`INSERT INTO ${table} (${entries.map(([key]) => key).join(',')}) VALUES (${entries.map(() => '?').join(',')})`)
    .run(...entries.map(([key, value]) => encode(key, value)));
}
export function byId<T>(db: Connection, table: Table, id: string): T | undefined { return decode<T>(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)); }
export function update(db: Connection, table: Table, id: string, change: object): void {
  const entries = Object.entries(change);
  if (!entries.length) return;
  db.prepare(`UPDATE ${table} SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`).run(...entries.map(([key,value]) => encode(key,value)),id);
}
