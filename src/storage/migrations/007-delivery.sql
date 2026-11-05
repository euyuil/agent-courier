CREATE TABLE delivery_routes (
  id TEXT PRIMARY KEY, recipientId TEXT NOT NULL REFERENCES recipients(id), kind TEXT NOT NULL CHECK (kind IN ('sessionWebhook','oto')),
  sensitiveCapabilityRef TEXT, expiresAt INTEGER, verifiedLimits TEXT NOT NULL CHECK (json_valid(verifiedLimits)),
  capabilityEvidenceId TEXT NOT NULL REFERENCES capability_evidence(id), status TEXT NOT NULL CHECK (status IN ('ready','unavailable'))
) STRICT;
CREATE TABLE outbound_deliveries (
  id TEXT PRIMARY KEY, recipientId TEXT NOT NULL REFERENCES recipients(id), runId TEXT REFERENCES runs(id), inputId TEXT REFERENCES inputs(id), pendingInputId TEXT,
  logicalMessageIds TEXT NOT NULL CHECK (json_valid(logicalMessageIds)), deliverySequence INTEGER NOT NULL,
  payloadRef TEXT NOT NULL REFERENCES private_content(id), status TEXT NOT NULL CHECK (status IN ('pending','sending','delivered','retry_wait','failed','unknown')),
  attemptCount INTEGER NOT NULL DEFAULT 0 CHECK(attemptCount BETWEEN 0 AND 3), nextAttemptAt INTEGER, errorCode TEXT,
  CHECK(runId IS NOT NULL OR inputId IS NOT NULL), UNIQUE(recipientId,deliverySequence)
) STRICT;
CREATE TABLE delivery_attempts (
  id TEXT PRIMARY KEY, deliveryId TEXT NOT NULL REFERENCES outbound_deliveries(id), attemptNo INTEGER NOT NULL CHECK(attemptNo BETWEEN 1 AND 3),
  routeId TEXT NOT NULL REFERENCES delivery_routes(id), startedAt INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('sending','confirmed','not_sent','unknown','route_unavailable')),
  providerReceiptRef TEXT, errorCode TEXT, UNIQUE(deliveryId,attemptNo)
) STRICT;
CREATE TABLE delivery_messages (
  outputMessageId TEXT PRIMARY KEY REFERENCES output_messages(id), deliveryId TEXT NOT NULL REFERENCES outbound_deliveries(id)
) STRICT;
CREATE TABLE failure_notices (subjectId TEXT NOT NULL, code TEXT NOT NULL, deliveryId TEXT NOT NULL REFERENCES outbound_deliveries(id), PRIMARY KEY(subjectId,code)) STRICT;
CREATE TRIGGER delivery_state BEFORE UPDATE OF status ON outbound_deliveries
WHEN NOT(NEW.status=OLD.status OR (OLD.status='pending' AND NEW.status IN ('sending','failed'))
 OR (OLD.status='sending' AND NEW.status IN ('delivered','retry_wait','failed','unknown')) OR (OLD.status='retry_wait' AND NEW.status IN ('sending','failed'))
 OR (OLD.status='unknown' AND NEW.status IN ('delivered','retry_wait','failed')))
BEGIN SELECT RAISE(ABORT,'invalid_delivery_transition'); END;
CREATE TRIGGER delivery_budget BEFORE UPDATE OF attemptCount ON outbound_deliveries WHEN NEW.attemptCount<OLD.attemptCount
BEGIN SELECT RAISE(ABORT,'delivery_budget_reset'); END;
CREATE TRIGGER immutable_attempted_delivery BEFORE UPDATE ON outbound_deliveries
WHEN OLD.attemptCount>0 AND (NEW.recipientId IS NOT OLD.recipientId OR NEW.payloadRef IS NOT OLD.payloadRef
  OR NEW.logicalMessageIds IS NOT OLD.logicalMessageIds OR NEW.runId IS NOT OLD.runId OR NEW.inputId IS NOT OLD.inputId
  OR NEW.deliverySequence IS NOT OLD.deliverySequence OR NEW.pendingInputId IS NOT OLD.pendingInputId)
BEGIN SELECT RAISE(ABORT,'immutable_delivery'); END;
CREATE TRIGGER delivery_target BEFORE INSERT ON outbound_deliveries
WHEN (NEW.runId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM runs r JOIN courier_sessions c ON c.id=r.courierSessionId
  JOIN platform_conversations p ON p.id=c.platformConversationId WHERE r.id=NEW.runId AND p.recipientId=NEW.recipientId))
  OR (NEW.inputId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inputs i JOIN platform_conversations p ON p.id=i.platformConversationId WHERE i.id=NEW.inputId AND p.recipientId=NEW.recipientId))
BEGIN SELECT RAISE(ABORT,'delivery_target_mismatch'); END;
