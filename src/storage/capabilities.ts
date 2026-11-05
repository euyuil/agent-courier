import type { CapabilityEvidence, EvidenceTarget, HarnessInstance } from '../domain/capabilities.js';
import type { Connection } from './database.js';

export function saveEvidence(db: Connection, evidence: CapabilityEvidence): void {
  db.prepare(`INSERT INTO capability_evidence (id,kind,adapterVersion,productVersion,scope,contextFingerprint,checkedAt,expiresAt,invalidatedAt,outcome,evidenceRef)
    VALUES (@id,@kind,@adapterVersion,@productVersion,@scope,@contextFingerprint,@checkedAt,@expiresAt,@invalidatedAt,@outcome,@evidenceRef)`)
    .run({ ...evidence, scope: JSON.stringify(evidence.scope), expiresAt: evidence.expiresAt ?? null, invalidatedAt: evidence.invalidatedAt ?? null });
}
export function readEvidence(db: Connection, target: EvidenceTarget): CapabilityEvidence[] {
  const rows = db.prepare('SELECT * FROM capability_evidence WHERE kind=? AND adapterVersion=? AND productVersion=? AND contextFingerprint=?')
    .all(target.kind, target.adapterVersion, target.productVersion, target.contextFingerprint) as Record<string, unknown>[];
  return rows.map(row => {
    const result: Record<string, unknown> = { ...row, scope: JSON.parse(row['scope'] as string) as unknown };
    for (const key of ['expiresAt', 'invalidatedAt']) if (result[key] === null) delete result[key];
    return result as unknown as CapabilityEvidence;
  });
}
export function invalidateEvidence(db: Connection, id: string, now: number): void {
  db.prepare('UPDATE capability_evidence SET invalidatedAt=? WHERE id=? AND invalidatedAt IS NULL').run(now, id);
}
export function saveInstance(db: Connection, instance: HarnessInstance): void {
  db.prepare(`INSERT INTO harness_instances (id,adapterKind,productVersion,cliVersion,capabilityEvidenceId,readiness)
    VALUES (@id,@adapterKind,@productVersion,@cliVersion,@capabilityEvidenceId,@readiness)
    ON CONFLICT(id) DO UPDATE SET productVersion=excluded.productVersion,cliVersion=excluded.cliVersion,
      capabilityEvidenceId=excluded.capabilityEvidenceId,readiness=excluded.readiness`)
    .run({ ...instance, cliVersion: instance.cliVersion ?? null });
}
