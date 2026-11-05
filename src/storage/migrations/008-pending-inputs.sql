CREATE TABLE pending_inputs (
 id TEXT PRIMARY KEY,runId TEXT NOT NULL REFERENCES runs(id),bindingId TEXT NOT NULL REFERENCES harness_bindings(id),
 platformConversationId TEXT NOT NULL REFERENCES platform_conversations(id),vendorRequestId TEXT NOT NULL,sourceMessageId TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('question','permission')),publicCode TEXT NOT NULL,promptRef TEXT REFERENCES private_content(id),
 answerSchema TEXT CHECK(answerSchema IS NULL OR json_valid(answerSchema)),options TEXT CHECK(options IS NULL OR json_valid(options)),adapterMappingRef TEXT NOT NULL,
 validity TEXT NOT NULL CHECK(validity IN ('open','withdrawn','expired','closed_by_run')),
 answerStatus TEXT NOT NULL CHECK(answerStatus IN ('none','dispatching','accepted','rejected','unknown')),
 answerInputId TEXT REFERENCES inputs(id),revision INTEGER NOT NULL,
 UNIQUE(bindingId,runId,vendorRequestId),UNIQUE(runId,sourceMessageId),UNIQUE(platformConversationId,publicCode),
 CHECK(kind!='question' OR answerSchema IS NOT NULL)
) STRICT;
CREATE TRIGGER request_association BEFORE INSERT ON pending_inputs
WHEN NOT EXISTS(SELECT 1 FROM runs r JOIN courier_sessions c ON c.id=r.courierSessionId
 WHERE r.id=NEW.runId AND r.bindingId=NEW.bindingId AND c.platformConversationId=NEW.platformConversationId)
BEGIN SELECT RAISE(ABORT,'request_association'); END;
CREATE TRIGGER immutable_request BEFORE UPDATE ON pending_inputs
WHEN NEW.runId IS NOT OLD.runId OR NEW.bindingId IS NOT OLD.bindingId OR NEW.platformConversationId IS NOT OLD.platformConversationId
 OR NEW.vendorRequestId IS NOT OLD.vendorRequestId OR NEW.sourceMessageId IS NOT OLD.sourceMessageId OR NEW.kind IS NOT OLD.kind
 OR NEW.publicCode IS NOT OLD.publicCode OR NEW.answerSchema IS NOT OLD.answerSchema OR NEW.options IS NOT OLD.options OR NEW.adapterMappingRef IS NOT OLD.adapterMappingRef
 OR (OLD.promptRef IS NOT NULL AND NEW.promptRef IS NOT OLD.promptRef) OR (OLD.validity!='open' AND NEW.validity!=OLD.validity)
BEGIN SELECT RAISE(ABORT,'immutable_request'); END;
CREATE TRIGGER pending_answer_owner BEFORE UPDATE OF answerInputId ON pending_inputs
WHEN NEW.answerInputId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inputs WHERE id=NEW.answerInputId AND platformConversationId=NEW.platformConversationId)
BEGIN SELECT RAISE(ABORT,'answer_owner_mismatch'); END;
CREATE TRIGGER pending_delivery_owner BEFORE INSERT ON outbound_deliveries
WHEN NEW.pendingInputId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pending_inputs p JOIN platform_conversations c ON c.id=p.platformConversationId
 WHERE p.id=NEW.pendingInputId AND p.runId=NEW.runId AND c.recipientId=NEW.recipientId)
BEGIN SELECT RAISE(ABORT,'pending_delivery_mismatch'); END;
