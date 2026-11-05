export interface CourierSession { id: string; platformConversationId: string; harnessInstanceId: string; policyRevision: number; nextInputSequence: number; nextDeliverySequence: number; revision: number }
export type BindingStatus = 'reserved' | 'creating' | 'ready' | 'blocked' | 'unavailable' | 'writer_conflict' | 'unknown';
export interface HarnessBinding { id: string; courierSessionId: string; harnessInstanceId: string; harnessSessionId?: string; status: BindingStatus; createOperationId: string; revision: number }
