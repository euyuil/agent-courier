import { z } from 'zod';
import { requiredCapabilities,optionalCapabilities } from '../domain/capabilities.js';
export const evidenceSchema=z.strictObject({id:z.string().min(1),kind:z.enum(['fake','harness','platform']),adapterVersion:z.string().min(1),
  productVersion:z.string().min(1),scope:z.partialRecord(z.enum([...requiredCapabilities,...optionalCapabilities,'ingress','delivery','oto']),
    z.strictObject({states:z.array(z.string()),limitations:z.array(z.string())})),contextFingerprint:z.string().min(1),
  checkedAt:z.number().finite().nonnegative(),expiresAt:z.number().finite().optional(),invalidatedAt:z.number().finite().optional(),
  outcome:z.enum(['unverified','passed','failed']),evidenceRef:z.string().min(1)}).transform(({expiresAt,invalidatedAt,...rest})=>({
    ...rest,...(expiresAt!==undefined?{expiresAt}:{}),...(invalidatedAt!==undefined?{invalidatedAt}:{})}));
export const limitsSchema=z.strictObject({maxTextLength:z.number().int().positive(),lengthUnit:z.enum(['utf8_bytes','codepoints','utf16']),
  routeTotal:z.number().int().positive().nullable(),rates:z.array(z.strictObject({scope:z.enum(['application','robot','recipient','route']),
    count:z.number().int().positive(),windowMs:z.number().int().positive()})),evidenceRef:z.string().min(1)});
export const platformProfileSchema=z.strictObject({productVersion:z.literal('dingtalk-stream@2.1.5'),adapterVersion:z.literal('1'),
  authorizationScope:z.array(z.string()),limits:limitsSchema,evidence:z.array(evidenceSchema)});
export const connectionProfileSchema=z.strictObject({endpoint:z.string().url().optional(),cwd:z.string().min(1),authTokenRef:z.string().optional(),
  cliVersion:z.string().min(1),authorizationScope:z.array(z.string()),desktopDebugUrl:z.string().url().optional(),
  ownership:z.strictObject({mode:z.literal('courier-exclusive'),bootstrapSessionRef:z.string().min(1).optional()}).optional(),
  bootstrapPermissionMode:z.literal('default').optional(),
  output:z.discriminatedUnion('mode',[
    z.strictObject({mode:z.literal('acp-text')}),
    z.strictObject({mode:z.literal('courier-formatter'),contractVersion:z.literal(1).default(1)}),
  ]).default({mode:'acp-text'})}).superRefine((profile,ctx)=>{
    if(profile.ownership&&!profile.desktopDebugUrl)ctx.addIssue({code:'custom',path:['desktopDebugUrl'],message:'exclusive bootstrap verification required'});
    const automatic=profile.ownership&&!profile.ownership.bootstrapSessionRef;
    if(profile.bootstrapPermissionMode&&!automatic)ctx.addIssue({code:'custom',path:['bootstrapPermissionMode'],message:'startup permission mode requires automatic bootstrap'});
    if(automatic&&profile.endpoint)ctx.addIssue({code:'custom',path:['endpoint'],message:'automatic bootstrap discovers its own endpoint'});
    if(!automatic&&!profile.endpoint)ctx.addIssue({code:'custom',path:['endpoint'],message:'configured endpoint required'});
  });
export type ConnectionProfile=z.infer<typeof connectionProfileSchema>;
