import { createHash } from 'node:crypto';
import { existsSync,lstatSync,readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { assertOutsideRepository } from '../../src/config/private.js';
import { privateDirectory } from '../../src/storage/private-state.js';

export const hookCollectorName='courier-hook-observer.py',hookRecordsName='courier-hook-observations.jsonl';
const events=['UserPromptSubmit','Stop','FinalStop','Notification'] as const;
const identities=['session_id','generation_id','message_id','hook_id','event_id','sequence','fragment_id'] as const;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const hashSchema=z.string().regex(/^[a-f0-9]{64}$/).nullable();
const recordSchema=z.strictObject({event:z.enum(events),sessionDigest:hashSchema,generationDigest:hashSchema,
  hasSessionObject:z.boolean(),hasTranscriptPath:z.boolean(),bodyDigest:hashSchema,bodyLength:z.number().int().nonnegative(),
  markerDigests:z.array(z.string().regex(/^[a-f0-9]{64}$/)),identityFields:z.array(z.enum(identities)),
  finalStopReason:z.enum(['completed','cancelled','user_cancel','error','failed']).nullable()});

// This observer reads only the normal Hook payload's whitelisted fields. It does
// not inspect the session object, process environment or transcript contents.
const collector=String.raw`import sys,json,os,hashlib,re,fcntl,stat
from pathlib import Path
try:
 root=Path(__file__).resolve().parent
 raw=sys.stdin.buffer.read(1048577)
 if len(raw)>1048576:raise ValueError('bounded input')
 data=json.loads(raw)
 if not isinstance(data,dict) or data.get('cwd')!=str(root):raise ValueError('scope mismatch')
 event=data.get('hook_event_name')
 if event not in {'UserPromptSubmit','Stop','FinalStop','Notification'}:raise ValueError('unexpected event')
 def sha(value):return hashlib.sha256(value.encode()).hexdigest() if isinstance(value,str) and value else None
 body=data.get('last_assistant_message')
 if body is not None and not isinstance(body,str):raise ValueError('invalid body')
 row={'event':event,'sessionDigest':sha(data.get('session_id')),'generationDigest':sha(data.get('generation_id')),
  'hasSessionObject':isinstance(data.get('session'),dict),'hasTranscriptPath':isinstance(data.get('transcript_path'),str),
  'bodyDigest':sha(body),'bodyLength':len(body) if isinstance(body,str) else 0,
  'markerDigests':[sha(value) for value in re.findall(r'CourierOwnedContext-[a-f0-9-]+',body or '')],
  'identityFields':[key for key in ['session_id','generation_id','message_id','hook_id','event_id','sequence','fragment_id'] if key in data],
  'finalStopReason':data.get('final_stop_reason') if data.get('final_stop_reason') in ['completed','cancelled','user_cancel','error','failed'] else None}
 encoded=(json.dumps(row,separators=(',',':'))+'\n').encode()
 if len(encoded)>1048576:raise ValueError('bounded record')
 fd=os.open(root/'courier-hook-observations.jsonl',os.O_RDWR|os.O_CREAT|os.O_APPEND|os.O_NOFOLLOW,0o600)
 try:
  fcntl.flock(fd,fcntl.LOCK_EX)
  info=os.fstat(fd)
  if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077:raise ValueError('private output required')
  if info.st_size+len(encoded)>1048576:raise ValueError('bounded output')
  prior=os.pread(fd,info.st_size,0)
  if len(prior)!=info.st_size or prior and not prior.endswith(b'\n'):raise ValueError('incomplete output')
  if prior.count(b'\n')>=4096:raise ValueError('bounded rows')
  offset=0
  while offset<len(encoded):
   written=os.write(fd,encoded[offset:])
   if written<=0:raise ValueError('incomplete write')
   offset+=written
  os.fsync(fd)
 finally:
  os.close(fd)
except Exception:
 pass
`;

export function configureClassicHookObservation(cwd:string):void {
  assertOutsideRepository(cwd);
  const directory=lstatSync(cwd);
  if(!directory.isDirectory()||directory.isSymbolicLink()||(directory.mode&0o077)!==0||process.getuid&&directory.uid!==process.getuid())
    throw new Error('private_configuration_required');
  const script=join(cwd,hookCollectorName),settings=join(cwd,'.codebuddy','settings.local.json');
  if(existsSync(script)||existsSync(join(cwd,'.codebuddy'))||existsSync(join(cwd,hookRecordsName)))throw new Error('private_configuration_required');
  privateDirectory(join(cwd,'.codebuddy'));
  const command=`python3 -I -S '${script.replaceAll("'","'\\''")}'`;
  const hooks=Object.fromEntries(events.map(event=>[event,[{hooks:[{type:'command',command,timeout:5,allowedEnvVars:['PATH']}]}]]));
  writeFileSync(script,collector,{mode:0o600,flag:'wx'});
  writeFileSync(settings,JSON.stringify({hooks}),{mode:0o600,flag:'wx'});
}

export function summarizeClassicHooks(cwd:string,sessionRef:string,runRef:string,expectedBody:string):Record<string,unknown> {
  const base={status:'unverified',executionPermissionApprovals:0};
  try {
    const path=join(cwd,hookRecordsName),file=lstatSync(path);
    if(!file.isFile()||file.isSymbolicLink()||file.size>1048576||(file.mode&0o077)!==0||process.getuid&&file.uid!==process.getuid())
      return {...base,reason:'hook_records_invalid'};
    const text=readFileSync(path,'utf8');
    if(!text.endsWith('\n'))return {...base,reason:'hook_records_incomplete'};
    const lines=text.split('\n').filter(Boolean);
    if(lines.length>4096)return {...base,reason:'hook_records_limit'};
    const rows=lines.map(line=>recordSchema.parse(JSON.parse(line))),own=rows.filter(row=>row.sessionDigest===digest(sessionRef)&&row.generationDigest===digest(runRef));
    const submits=own.filter(row=>row.event==='UserPromptSubmit'),stops=own.filter(row=>row.event==='Stop'),finals=own.filter(row=>row.event==='FinalStop');
    const stopBodyMatched=stops.length===1&&stops[0]!.bodyDigest===digest(expectedBody);
    const observed=submits.length===1&&stopBodyMatched&&finals.length===1&&finals[0]!.finalStopReason==='completed';
    return {...base,status:observed?'observed':'unverified',totalHookRows:rows.length,matchedHookRows:own.length,nativeSessionAndRunMatched:own.length>0,
      matchedEvents:own.map(row=>row.event),stopBodyMatched,stopMarkerObserved:stops.some(row=>row.markerDigests.includes(digest(expectedBody))),
      identityFields:[...new Set(own.flatMap(row=>row.identityFields))],sessionObjectProvided:own.some(row=>row.hasSessionObject),
      finalStopReasons:finals.map(row=>row.finalStopReason),perMessageIdentityObserved:own.some(row=>row.identityFields.includes('message_id')),
      fragmentIdentityObserved:own.some(row=>row.identityFields.includes('fragment_id')||row.identityFields.includes('sequence'))};
  }catch{return {...base,reason:'hook_records_unverified'};}
}
