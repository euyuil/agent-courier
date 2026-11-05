export interface PlatformIdentity { id: string; platformScope: string; robotId: string; senderId: string; enterpriseUserId?: string }
export interface Recipient { id: string; platformScope: string; robotId: string; platformConversationId: string; privateUserRef?: string }
export interface PlatformConversation { id: string; platformScope: string; robotId: string; platformConversationId: string; type: 'private'; recipientId: string }
