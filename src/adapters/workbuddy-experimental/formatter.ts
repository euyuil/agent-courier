import { z } from 'zod';
import { record } from './metadata.js';

export const formatterServerName='courier_formatter';
export const formatterToolName='courier_format_message';
export const formatterFullToolName=`mcp__${formatterServerName}__${formatterToolName}`;
export const formatterContractVersion=1;
export const formatterServerInstructions='This server is a pure message formatter. It does not deliver messages or make permission decisions. '+
  'When the client selects courier-formatter/1, use courier_format_message for its explicit progress and final output contract. '+
  'Native questions and execution permissions remain with the Harness.';
export const formatterOutputInstructions=`Agent Courier output contract: courier-formatter/${formatterContractVersion}. `+
  `For this request, use ${formatterFullToolName} for every user-visible progress or final message. `+
  'Set kind to progress or final and text to the complete user-visible message. Each invocation is a separate logical message. '+
  'Keep private reasoning and internal tool logs out of these messages. Use native Harness questions and permissions for human interaction; never format or approve a permission decision. '+
  'Apply all updates received during this Run to subsequent work and the final report, preserving earlier compatible requirements. '+
  'If an update arrives after a final message, send a corrected final through another formatter call before finishing. '+
  'A formatted final message does not end the Run; the Harness reports completion separately. '+
  'These are output-format instructions, not a system-role message. The next text block is the unchanged user request.';
export const formatterInputSchema=z.strictObject({kind:z.enum(['progress','final']),text:z.string().min(1).max(65536)});
export const formatterPayloadSchema=formatterInputSchema.extend({schemaVersion:z.literal(1)});
export type FormatterPayload=z.infer<typeof formatterPayloadSchema>;

// 这里只格式化数据。工具执行和权限判断由 Harness 负责；
// Courier 仍须另行核对原始 ACP 工具身份及完成事实。
export const formatterTool={
  name:formatterToolName,
  description:'Format an explicitly user-visible progress or final message. Returns validated data without sending messages or modifying state.',
  inputSchema:z.toJSONSchema(formatterInputSchema),outputSchema:z.toJSONSchema(formatterPayloadSchema),
  annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true},
};

export function formatMessage(input:unknown):FormatterPayload|undefined {
  const parsed=formatterInputSchema.safeParse(input);
  return parsed.success?{schemaVersion:1,...parsed.data}:undefined;
}

export function formatterMcpServer(launch:{executable:string;entrypoint:string}) {
  return {name:formatterServerName,command:launch.executable,args:[launch.entrypoint],env:[],
    _meta:{_workbuddyMcpOrigin:'custom',defer_loading:false}};
}

export function decodeFormatterResult(raw:unknown):FormatterPayload|undefined {
  const value=record(raw);
  if(typeof value['text']!=='string'||Buffer.byteLength(value['text'])>1048576||value['isError']===true||
    value['is_error']===true||value['error'])return undefined;
  try {
    let decoded:unknown=JSON.parse(value['text']);
    if(Array.isArray(decoded)) {
      if(decoded.length!==1)return undefined;
      const content=z.strictObject({type:z.literal('text'),text:z.string().max(1048576)}).safeParse(decoded[0]);
      if(!content.success)return undefined;
      decoded=JSON.parse(content.data.text);
    }
    const parsed=formatterPayloadSchema.safeParse(decoded);
    return parsed.success?parsed.data:undefined;
  }catch{return undefined;}
}
