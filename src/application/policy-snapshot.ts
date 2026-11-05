import type { Config,DisplayPolicy } from '../config/schema.js';
export function snapshotPolicy(config:Config,key:{platformScope:string;robotId:string;platformConversationId:string}):DisplayPolicy {
  return structuredClone(config.display.overrides.find(item=>item.platformScope===key.platformScope && item.robotId===key.robotId
    && item.platformConversationId===key.platformConversationId)?.policy??config.display.defaults);
}
