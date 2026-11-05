CREATE TABLE private_content (id TEXT PRIMARY KEY, content TEXT NOT NULL) STRICT;
CREATE TRIGGER immutable_content BEFORE UPDATE ON private_content BEGIN SELECT RAISE(ABORT,'immutable_content'); END;
CREATE TABLE platform_identities (
  id TEXT PRIMARY KEY, platformScope TEXT NOT NULL, robotId TEXT NOT NULL, senderId TEXT NOT NULL, enterpriseUserId TEXT,
  UNIQUE(platformScope,robotId,senderId)
) STRICT;
CREATE TABLE recipients (
  id TEXT PRIMARY KEY, platformScope TEXT NOT NULL, robotId TEXT NOT NULL, platformConversationId TEXT NOT NULL, privateUserRef TEXT,
  UNIQUE(platformScope,robotId,platformConversationId)
) STRICT;
CREATE TABLE platform_conversations (
  id TEXT PRIMARY KEY, platformScope TEXT NOT NULL, robotId TEXT NOT NULL, platformConversationId TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type='private'), recipientId TEXT NOT NULL UNIQUE REFERENCES recipients(id),
  UNIQUE(platformScope,robotId,platformConversationId)
) STRICT;
CREATE TRIGGER immutable_recipient BEFORE UPDATE ON recipients BEGIN SELECT RAISE(ABORT,'immutable_recipient'); END;
CREATE TRIGGER conversation_target BEFORE INSERT ON platform_conversations
WHEN NOT EXISTS (SELECT 1 FROM recipients WHERE id=NEW.recipientId AND platformScope=NEW.platformScope
  AND robotId=NEW.robotId AND platformConversationId=NEW.platformConversationId)
BEGIN SELECT RAISE(ABORT,'recipient_mismatch'); END;
