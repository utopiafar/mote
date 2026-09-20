import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {scanSourceFiles} from '../apps/desktop/src/source-files.js';
import {DEFAULT_SOURCE_OPTIONS,type LocalFileCheckpoint} from '../apps/desktop/src/source-types.js';
const root=await realpath(await mkdtemp(join(tmpdir(),'mote-directory-scale-'))),count=Number(process.env.MOTE_BENCH_FILES??100000);
let checkpoint:LocalFileCheckpoint|undefined;
try{
 const created=performance.now();for(let folder=0;folder<Math.ceil(count/1000);folder++){
  const path=join(root,'folder-'+folder);await mkdir(path);for(let n=0;n<1000&&folder*1000+n<count;n+=50)await Promise.all(Array.from({length:Math.min(50,1000-n,count-folder*1000-n)},(_,i)=>writeFile(join(path,`file-${n+i}.txt`),`Generated synthetic file ${folder*1000+n+i}.\n`)));
 }
 console.log(JSON.stringify({stage:'generate',files:count,durationMs:performance.now()-created}));
 async function scan(label:string){const start=performance.now();let emitted=0,passes=0;for(;;){const result=await scanSourceFiles(root,{...DEFAULT_SOURCE_OPTIONS,retention:'reference'},undefined,undefined,undefined,checkpoint);checkpoint=result.checkpoint as LocalFileCheckpoint;emitted+=result.items.length;passes++;if(result.complete)break;if(passes>Math.ceil(count/1000)+5)throw Error('Directory scan failed to converge');}console.log(JSON.stringify({stage:label,files:count,durationMs:performance.now()-start,passes,emitted,modelCalls:0,realPersonalData:false}));return emitted;}
 assert.equal(await scan('initial-catalog'),count);assert.equal(await scan('unchanged-reconciliation'),0);
 await writeFile(join(root,'folder-0/file-0.txt'),'Generated changed file.');assert.equal(await scan('one-file-change'),1);
}finally{await rm(root,{recursive:true,force:true});}
