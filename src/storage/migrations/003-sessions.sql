CREATE TABLE courier_sessions (
  id TEXT PRIMARY KEY, platformConversationId TEXT NOT NULL UNIQUE REFERENCES platform_conversations(id),
  harnessInstanceId TEXT NOT NULL REFERENCES harness_instances(id), policyRevision INTEGER NOT NULL,
  nextInputSequence INTEGER NOT NULL DEFAULT 1, nextDeliverySequence INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE harness_bindings (
  id TEXT PRIMARY KEY, courierSessionId TEXT NOT NULL UNIQUE REFERENCES courier_sessions(id),
  harnessInstanceId TEXT NOT NULL REFERENCES harness_instances(id), harnessSessionId TEXT,
  status TEXT NOT NULL CHECK (status IN ('reserved','creating','ready','blocked','unavailable','writer_conflict','unknown')),
  createOperationId TEXT NOT NULL REFERENCES harness_operations(id) DEFERRABLE INITIALLY DEFERRED,
  revision INTEGER NOT NULL DEFAULT 0,
  UNIQUE(harnessInstanceId,harnessSessionId), CHECK(status!='ready' OR harnessSessionId IS NOT NULL)
) STRICT;
CREATE TRIGGER immutable_binding BEFORE UPDATE ON harness_bindings
WHEN NEW.courierSessionId IS NOT OLD.courierSessionId OR NEW.harnessInstanceId IS NOT OLD.harnessInstanceId
  OR (OLD.harnessSessionId IS NOT NULL AND NEW.harnessSessionId IS NOT OLD.harnessSessionId)
BEGIN SELECT RAISE(ABORT,'immutable_binding'); END;
CREATE TRIGGER binding_instance BEFORE INSERT ON harness_bindings
WHEN NOT EXISTS (SELECT 1 FROM courier_sessions WHERE id=NEW.courierSessionId AND harnessInstanceId=NEW.harnessInstanceId)
BEGIN SELECT RAISE(ABORT,'binding_mismatch'); END;
