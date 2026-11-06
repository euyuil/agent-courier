import { readdirSync,mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import {tmpdir} from 'node:os';
import { spawnSync } from 'node:child_process';
import {reportCoverage} from './coverage.mjs';

const root = 'build/test/tests';
function discover(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? discover(path) : entry.name.endsWith('.test.js') && entry.name!=='live-conversation.test.js' ? [path] : [];
  });
}
let files;
try { files = discover(root).sort(); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
  files = [];
}
const filter = process.env.COURIER_TEST_FILTER;
if (filter) files = files.filter(file => file.includes(filter));
if (!files.length) {
  console.log('未发现测试。');
  process.exit(filter ? 2 : 0);
}
const args = ['--test', '--test-isolation=none', '--test-reporter=spec'];
const coverage=process.argv.includes('--coverage')?mkdtempSync(join(tmpdir(),'courier-v8-')):undefined;
let status=1;
try {
  const result = spawnSync(process.execPath, [...args, ...files], { stdio: 'inherit',env:{...process.env,...(coverage?{NODE_V8_COVERAGE:coverage}:{})} });
  status=result.status??1;
  if(coverage && status===0)reportCoverage(coverage,'build/test/src');
} finally {if(coverage)rmSync(coverage,{recursive:true,force:true});}
process.exit(status);
