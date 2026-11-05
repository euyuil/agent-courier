import type { NormalizedInbound } from '../adapters/dingtalk/port.js';
import type { PlatformConversation, PlatformIdentity } from '../domain/platform.js';
import { newId } from '../domain/common.js';
import type { Connection } from './database.js';
import { decode, insert } from './records.js';

export function platformRecords(db: Connection, event: NormalizedInbound): { conversation: PlatformConversation; identity: PlatformIdentity } {
  const key = [event.platformScope, event.robotId, event.platformConversationId];
  let conversation = decode<PlatformConversation>(db.prepare('SELECT * FROM platform_conversations WHERE platformScope=? AND robotId=? AND platformConversationId=?').get(...key));
  if (!conversation) {
    const recipientId = newId<'recipient'>();
    insert(db, 'recipients', { id: recipientId, platformScope: event.platformScope, robotId: event.robotId, platformConversationId: event.platformConversationId });
    conversation = { id: newId<'platform-conversation'>(), platformScope: event.platformScope, robotId: event.robotId,
      platformConversationId: event.platformConversationId, type: 'private', recipientId };
    insert(db, 'platform_conversations', conversation);
  }
  let identity = decode<PlatformIdentity>(db.prepare('SELECT * FROM platform_identities WHERE platformScope=? AND robotId=? AND senderId=?').get(event.platformScope,event.robotId,event.senderId));
  if (!identity) {
    identity = { id: newId<'identity'>(), platformScope: event.platformScope, robotId: event.robotId, senderId: event.senderId };
    if (event.enterpriseUserId) identity.enterpriseUserId = event.enterpriseUserId;
    insert(db, 'platform_identities', identity);
  }
  return { conversation, identity };
}
