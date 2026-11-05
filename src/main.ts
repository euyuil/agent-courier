#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config/load.js';
import { CourierError, safeCode } from './domain/errors.js';
import { diagnostic } from './application/diagnostics.js';
import { serve } from './cli/serve.js';
import { validateConfig } from './cli/validate-config.js';
import { openDatabase } from './storage/database.js';
import { sessionStatus } from './cli/status.js';
import { reconcileCommand } from './cli/reconcile.js';

export async function main(args: string[]): Promise<number> {
  try {
    if(Number(process.versions.node.split('.')[0])!==24)throw new CourierError('configuration_invalid');
    const [command,...rest]=args;
    if (!command || !['validate-config','serve','status','reconcile'].includes(command)) throw new CourierError('configuration_invalid');
    const flags=new Map<string,string>();
    for(let i=0;i<rest.length;i++) {
      const flag=rest[i]!;
      if(flags.has(flag) || !['--config','--session','--operation','--delivery','--json'].includes(flag))throw new CourierError('configuration_invalid');
      if(flag==='--json'){flags.set(flag,'true');continue;}
      const value=rest[++i];if(!value || value.startsWith('--'))throw new CourierError('configuration_invalid');flags.set(flag,value);
    }
    const path=flags.get('--config');if(!path)throw new CourierError('configuration_invalid');
    if (command==='validate-config' || command==='serve') {
      if(flags.size!==1)throw new CourierError('configuration_invalid');
      if(command==='validate-config')validateConfig(path);else await serve(loadConfig(path),path);
    } else if(command==='status') {
      if(flags.size!==3 || !flags.has('--session') || !flags.has('--json'))throw new CourierError('configuration_invalid');
      const db=openDatabase(loadConfig(path).storage.databasePath,{readonly:true});
      try{process.stdout.write(JSON.stringify(sessionStatus(db,flags.get('--session')!))+'\n');}finally{db.close();}
    } else {
      if(flags.size!==2 || flags.has('--operation')===flags.has('--delivery'))throw new CourierError('configuration_invalid');
      return await reconcileCommand(loadConfig(path),flags.has('--operation')?{operation:flags.get('--operation')!}:{delivery:flags.get('--delivery')!});
    }
    return 0;
  } catch (error) {
    const code=safeCode(error);process.stderr.write(JSON.stringify(diagnostic(code))+'\n');
    if (code==='configuration_invalid') return 2;
    if (code==='storage_unavailable' || code==='instance_locked') return 4;
    if (code==='state_unknown') return 5;
    return 3;
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) process.exitCode=await main(process.argv.slice(2));
