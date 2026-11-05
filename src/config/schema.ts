import { z } from 'zod';

export const displaySchema = z.strictObject({
  revision: z.number().int().nonnegative().default(1),
  progress: z.boolean().default(true), final: z.boolean().default(true),
  question: z.literal(true).default(true), permissionRequest: z.literal(true).default(true), error: z.boolean().default(true),
  message: z.boolean().default(false), toolStatus: z.boolean().default(false), artifact: z.boolean().default(false),
  mergeAdjacentProgress: z.boolean().default(false),
});
const ref = z.string().min(1);
export const configSchema = z.strictObject({
  schemaVersion: z.literal(1), storage: z.strictObject({ databasePath: ref }),
  platform: z.strictObject({
    kind: z.enum(['dingtalk-stream', 'fake']), scopeRef: ref, robotRef: ref,
    clientIdRef: ref.optional(), clientSecretRef: ref.optional(), limitProfileRef: ref.optional(), otoRouteEvidenceRef: ref.optional(),
  }),
  harness: z.strictObject({ instanceId: ref, adapter: z.enum(['workbuddy-experimental', 'mock']),
    connectionProfileRef: ref.optional(), capabilityEvidenceRef: ref.optional() }),
  display: z.strictObject({ defaults: displaySchema.default(() => displaySchema.parse({})),
    overrides: z.array(z.strictObject({ platformScope: ref, robotId: ref, platformConversationId: ref,
      policy: displaySchema })).default([]) }).default(() => ({ defaults: displaySchema.parse({}), overrides: [] })),
  delivery: z.strictObject({ maxAutomaticRetries: z.number().int().min(0).max(2).default(2) }).default({ maxAutomaticRetries: 2 }),
}).superRefine((value, ctx) => {
  const fake = value.platform.kind === 'fake';
  if (fake !== (value.harness.adapter === 'mock')) ctx.addIssue({ code: 'custom', message: 'mixed_mode' });
  if (!fake && (!value.platform.clientIdRef || !value.platform.clientSecretRef || !value.platform.limitProfileRef
    || !value.harness.connectionProfileRef || !value.harness.capabilityEvidenceRef)) {
    ctx.addIssue({ code: 'custom', message: 'missing_reference' });
  }
  const keys = value.display.overrides.map(item => JSON.stringify([item.platformScope, item.robotId, item.platformConversationId]));
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'duplicate_override' });
});
export type Config = z.infer<typeof configSchema>;
export type DisplayPolicy = z.infer<typeof displaySchema>;
