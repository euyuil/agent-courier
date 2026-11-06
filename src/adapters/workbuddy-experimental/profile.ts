import { createHash } from 'node:crypto';
import { readFileSync,lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ConnectionProfile } from '../../config/real-profiles.js';
import { contextFingerprint } from '../../domain/capabilities.js';
import { CourierError } from '../../domain/errors.js';
import { formatterContractVersion } from './formatter.js';

type Artifacts=Readonly<Record<string,string|Uint8Array>>;
export function outputArtifactDigest(artifacts:Artifacts):string {
  const digest=createHash('sha256');
  for(const name of Object.keys(artifacts).sort())digest.update(name).update('\0').update(artifacts[name]!).update('\0');
  return digest.digest('hex');
}
function packagedArtifacts():Artifacts {
  // 仅客户端读取固定的应用代码；纯 MCP 生产者不导入此模块或读取文件。
  const names=['formatter.js','formatter-server.js','formatter-output.js','output.js','session.js','run-references.js','metadata.js',
    'interaction.js','interaction-command.js','steer.js','connection.js','profile.js','authentication.js','runtime.js','runtime-discovery.js','factory.js','bootstrap-provenance.js','context-mode.js','managed.js','managed-operations.js','managed-runtime.js'];
  return Object.fromEntries(names.map(name=>{
    const path=new URL(name,import.meta.url),info=lstatSync(path);
    if(!info.isFile()||info.isSymbolicLink()||info.size>2097152)throw new CourierError('configuration_invalid');
    return [name,readFileSync(path)];
  }));
}
type OutputContext=Pick<ConnectionProfile,'endpoint'|'cwd'|'authorizationScope'|'output'|'ownership'|'bootstrapPermissionMode'|'desktopDebugUrl'>&{cliVersion:string|null;connectionRole?:'context'|'managed'};
export function workbuddyConfiguration(instanceId:string,profile:OutputContext,readArtifacts:()=>Artifacts=packagedArtifacts) {
  if(!profile.endpoint)throw new CourierError('configuration_invalid');
  const initial=outputArtifactDigest(readArtifacts()),mode=profile.output.mode;
  const ownership=profile.ownership?{bootstrapSelection:profile.ownership.bootstrapSessionRef?'fixed':'automatic',
    runtimeIsolation:profile.connectionRole==='managed'&&!profile.ownership.bootstrapSessionRef?'per-courier':'single'}:undefined;
  const automaticManaged=profile.connectionRole==='managed'&&profile.ownership&&!profile.ownership.bootstrapSessionRef;
  if(automaticManaged&&!profile.desktopDebugUrl)throw new CourierError('configuration_invalid');
  // 自动管理目标是配置的桌面实例；每个自有后端的临时端点仍在连接时逐一核实归属与版本。
  const target=automaticManaged?{desktopDebugUrl:profile.desktopDebugUrl}:profile.endpoint;
  return {contextFingerprint:contextFingerprint({targetRef:JSON.stringify([instanceId,target,profile.cwd,...(ownership?[{ownership}]:[]),...(profile.bootstrapPermissionMode?[{bootstrapPermissionMode:profile.bootstrapPermissionMode}]:[])]),cliVersion:profile.cliVersion,
    transportKind:profile.connectionRole==='managed'?'workbuddy-acp-courier-managed':profile.connectionRole==='context'?'workbuddy-acp-courier-context':profile.ownership?'workbuddy-acp-courier-exclusive':'workbuddy-acp',authorizationScope:profile.authorizationScope,limitProfile:null,
    outputProfile:{mode,contractVersion:mode==='courier-formatter'?formatterContractVersion:null,artifactDigest:initial,runtime:`node@${process.versions.node}`}}),
    verifyOutputProfile:()=>{try{return outputArtifactDigest(readArtifacts())===initial;}catch{return false;}},
    ...(mode==='courier-formatter'?{formatterLaunch:{executable:process.execPath,
      entrypoint:fileURLToPath(new URL('formatter-server.js',import.meta.url))},typedFormatterOutput:true}:{})};
}
