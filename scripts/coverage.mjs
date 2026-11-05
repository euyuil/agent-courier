import {readFileSync,readdirSync} from 'node:fs';
import {resolve,relative,join} from 'node:path';
import {fileURLToPath} from 'node:url';

export function reportCoverage(directory,sourceRoot) {
  const records=new Map();
  for(const name of readdirSync(directory)) {
    if(!name.endsWith('.json'))continue;
    const payload=JSON.parse(readFileSync(join(directory,name),'utf8'));
    for(const item of payload.result) {
      if(!item.url.startsWith('file:'))continue;
      const path=fileURLToPath(item.url);
      if(!path.startsWith(resolve(sourceRoot)+'/'))continue;
      const ranges=records.get(path)??new Map();
      for(const fn of item.functions)for(const range of fn.ranges) {
        const key=`${range.startOffset}:${range.endOffset}`;
        const prior=ranges.get(key);
        ranges.set(key,{...range,count:Math.max(prior?.count??0,range.count)});
      }
      records.set(path,ranges);
    }
  }
  function discover(dir) {
    return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?discover(join(dir,entry.name)):entry.name.endsWith('.js')?[resolve(dir,entry.name)]:[]);
  }
  let total=0,covered=0;
  console.log('V8 compiled application line coverage (comments and blank lines excluded):');
  for(const path of discover(sourceRoot).sort()) {
    const ranges=[...(records.get(path)?.values()??[])];
    let offset=0,lines=0,hits=0;
    for(const line of readFileSync(path,'utf8').split('\n')) {
      const text=line.trim();
      if(text && !text.startsWith('//') && !text.startsWith('/*') && !text.startsWith('*') && !text.startsWith('#!')) {
        const position=offset+line.search(/\S/);
        const range=ranges.filter(r=>r.startOffset<=position&&position<r.endOffset).sort((a,b)=>(a.endOffset-a.startOffset)-(b.endOffset-b.startOffset))[0];
        lines++;if(range?.count>0)hits++;
      }
      offset+=line.length+1;
    }
    total+=lines;covered+=hits;
    console.log(`${relative(sourceRoot,path)}: ${hits}/${lines}`);
  }
  if(!records.size || !total)throw new Error('empty_coverage');
  console.log(`Application total: ${covered}/${total} (${(100*covered/total).toFixed(2)}%)`);
}
