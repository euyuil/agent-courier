export type ParsedReply={kind:'ordinary';text:string}|{kind:'ambiguous'}|{kind:'invalid'}
  |{kind:'reply';code:string;text:string}|{kind:'permission';code:string;decision:'approve'|'deny';optionCode?:string};
const ambiguous=new Set(['同意','好','好的','是','否','不同意','批准','拒绝','可以','不可以','yes','no','ok']);
export function parseReply(text:string,hasPending:boolean):ParsedReply {
  const command=text.trim();
  const supplement=/^\/补充\s+([\s\S]+)$/.exec(command);
  if(supplement)return {kind:'ordinary',text:supplement[1]!};
  const reply=/^\/答复\s+([A-Z0-9]+)\s+([\s\S]+)$/.exec(command);
  if(reply)return {kind:'reply',code:reply[1]!,text:reply[2]!};
  const permission=/^\/(批准|拒绝)\s+([A-Z0-9]+)(?:\s+(\S+))?$/.exec(command);
  if(permission)return {kind:'permission',code:permission[2]!,decision:permission[1]==='批准'?'approve':'deny',...(permission[3]?{optionCode:permission[3]}:{})};
  if(/^\/(答复|批准|拒绝|补充)(?:\s|$)/.test(command))return {kind:'invalid'};
  if(hasPending && ambiguous.has(command.toLowerCase()))return {kind:'ambiguous'};
  return {kind:'ordinary',text};
}
