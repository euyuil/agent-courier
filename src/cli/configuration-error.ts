import { diagnostic } from '../application/diagnostics.js';

export function reportConfigReloadFailure():void {
  const {code,message}=diagnostic('configuration_invalid');
  process.stderr.write(JSON.stringify({code,message})+'\n');
}
