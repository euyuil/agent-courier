CREATE TABLE inputs (
  id TEXT PRIMARY KEY, dedupNamespace TEXT NOT NULL, originalMessageId TEXT NOT NULL,
  platformConversationId TEXT NOT NULL REFERENCES platform_conversations(id), identityId TEXT NOT NULL REFERENCES platform_identities(id),
  receivedSequence INTEGER NOT NULL, textRef TEXT NOT NULL REFERENCES private_content(id),
  mode TEXT NOT NULL CHECK (mode IN ('start','steer','answer','invalid')), runId TEXT REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED,
  pendingInputId TEXT, status TEXT NOT NULL CHECK (status IN ('received','dispatching','accepted','rejected','unknown')),
  acceptedAt INTEGER, appliedEvidenceRef TEXT, errorCode TEXT,
  UNIQUE(dedupNamespace,originalMessageId), UNIQUE(platformConversationId,receivedSequence)
) STRICT;
CREATE TABLE inbound_receipts (
  id TEXT PRIMARY KEY, inputId TEXT REFERENCES inputs(id), transportMessageId TEXT NOT NULL, receivedAt INTEGER NOT NULL,
  ackStatus TEXT NOT NULL CHECK (ackStatus IN ('pending','confirmed','unknown'))
) STRICT;
CREATE TRIGGER input_identity BEFORE INSERT ON inputs
WHEN NOT EXISTS(SELECT 1 FROM platform_conversations c JOIN platform_identities i ON c.platformScope=i.platformScope AND c.robotId=i.robotId
 WHERE c.id=NEW.platformConversationId AND i.id=NEW.identityId)
BEGIN SELECT RAISE(ABORT,'input_identity_mismatch'); END;
CREATE TRIGGER input_state BEFORE UPDATE OF status ON inputs
WHEN NOT (NEW.status=OLD.status OR (OLD.status='received' AND NEW.status IN ('dispatching','rejected'))
  OR (OLD.status='dispatching' AND NEW.status IN ('accepted','rejected','unknown')) OR (OLD.status='unknown' AND NEW.status IN ('accepted','rejected')))
BEGIN SELECT RAISE(ABORT,'invalid_input_transition'); END;
