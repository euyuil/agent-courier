CREATE TABLE capability_evidence (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('fake','harness','platform')),
  adapterVersion TEXT NOT NULL,
  productVersion TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (json_valid(scope)),
  contextFingerprint TEXT NOT NULL,
  checkedAt INTEGER NOT NULL,
  expiresAt INTEGER CHECK (expiresAt IS NULL OR expiresAt > checkedAt),
  invalidatedAt INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('unverified','passed','failed')),
  evidenceRef TEXT NOT NULL
) STRICT;
CREATE TRIGGER immutable_evidence BEFORE UPDATE ON capability_evidence
WHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR NEW.adapterVersion IS NOT OLD.adapterVersion
  OR NEW.productVersion IS NOT OLD.productVersion OR NEW.scope IS NOT OLD.scope
  OR NEW.contextFingerprint IS NOT OLD.contextFingerprint OR NEW.checkedAt IS NOT OLD.checkedAt
  OR NEW.expiresAt IS NOT OLD.expiresAt OR NEW.outcome IS NOT OLD.outcome OR NEW.evidenceRef IS NOT OLD.evidenceRef
  OR (OLD.invalidatedAt IS NOT NULL AND NEW.invalidatedAt IS NOT OLD.invalidatedAt)
BEGIN SELECT RAISE(ABORT, 'immutable_evidence'); END;
CREATE TABLE harness_instances (
  id TEXT PRIMARY KEY,
  adapterKind TEXT NOT NULL CHECK (adapterKind IN ('mock','workbuddy-experimental')),
  productVersion TEXT NOT NULL,
  cliVersion TEXT,
  capabilityEvidenceId TEXT NOT NULL REFERENCES capability_evidence(id),
  readiness TEXT NOT NULL CHECK (readiness IN ('unverified','supported','unsupported'))
) STRICT;
