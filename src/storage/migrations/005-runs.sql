CREATE TABLE harness_operations (
  id TEXT PRIMARY KEY, bindingId TEXT NOT NULL REFERENCES harness_bindings(id), inputId TEXT REFERENCES inputs(id),
  runId TEXT REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED, pendingInputId TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('create','load','start','steer','answer')), expectedRunRef TEXT,
  status TEXT NOT NULL CHECK (status IN ('prepared','dispatching','accepted','rejected','unknown')),
  startedAt INTEGER, resultCode TEXT, evidenceRef TEXT
) STRICT;
CREATE TABLE runs (
  id TEXT PRIMARY KEY, courierSessionId TEXT NOT NULL REFERENCES courier_sessions(id), bindingId TEXT NOT NULL REFERENCES harness_bindings(id),
  initialInputId TEXT NOT NULL REFERENCES inputs(id), harnessRunRef TEXT,
  status TEXT NOT NULL CHECK (status IN ('submitting','running','waiting_input','completed','failed','unknown','not_started')),
  revision INTEGER NOT NULL, policySnapshot TEXT NOT NULL CHECK (json_valid(policySnapshot)), completionEvidenceRef TEXT,
  startedAt INTEGER, finishedAt INTEGER,
  UNIQUE(bindingId,harnessRunRef), CHECK(status NOT IN ('completed','failed') OR completionEvidenceRef IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX active_run_slot ON runs(courierSessionId) WHERE status IN ('submitting','running','waiting_input','unknown');
CREATE TRIGGER immutable_run BEFORE UPDATE ON runs
WHEN NEW.courierSessionId IS NOT OLD.courierSessionId OR NEW.bindingId IS NOT OLD.bindingId OR NEW.initialInputId IS NOT OLD.initialInputId
 OR NEW.policySnapshot IS NOT OLD.policySnapshot OR (OLD.harnessRunRef IS NOT NULL AND NEW.harnessRunRef IS NOT OLD.harnessRunRef)
BEGIN SELECT RAISE(ABORT,'immutable_run'); END;
CREATE TRIGGER operation_association BEFORE INSERT ON harness_operations
WHEN (NEW.runId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runs WHERE id=NEW.runId AND bindingId=NEW.bindingId))
 OR (NEW.inputId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inputs i JOIN courier_sessions c ON c.platformConversationId=i.platformConversationId
 JOIN harness_bindings b ON b.courierSessionId=c.id WHERE i.id=NEW.inputId AND b.id=NEW.bindingId))
BEGIN SELECT RAISE(ABORT,'operation_association'); END;
CREATE TRIGGER operation_state BEFORE UPDATE OF status ON harness_operations
WHEN NOT (NEW.status=OLD.status OR (OLD.status='prepared' AND NEW.status='dispatching')
  OR (OLD.status='dispatching' AND NEW.status IN ('accepted','rejected','unknown')) OR (OLD.status='unknown' AND NEW.status IN ('accepted','rejected')))
BEGIN SELECT RAISE(ABORT,'invalid_operation_transition'); END;
CREATE TRIGGER terminal_run BEFORE UPDATE OF status ON runs WHEN OLD.status IN ('completed','failed','not_started') AND NEW.status!=OLD.status
BEGIN SELECT RAISE(ABORT,'terminal_run'); END;
CREATE TRIGGER run_binding BEFORE INSERT ON runs
WHEN NOT EXISTS (SELECT 1 FROM harness_bindings WHERE id=NEW.bindingId AND courierSessionId=NEW.courierSessionId)
  OR NOT EXISTS (SELECT 1 FROM inputs i JOIN courier_sessions c ON c.platformConversationId=i.platformConversationId WHERE i.id=NEW.initialInputId AND c.id=NEW.courierSessionId)
BEGIN SELECT RAISE(ABORT,'run_binding_mismatch'); END;
