// Generated directory and fixed stat metadata; compare against the frozen original algorithm.
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {mkdtemp,mkdir,writeFile,lstat,realpath,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const Module=require('node:module');
const ts=require('typescript');
const {DirectoryCatalog}=require('../dist/directory-catalog');
const base='af11ab7c3e9fb5f38deaea4e4bae11462a7306b4';
const repository=resolve(__dirname,'../../..');
const original=execFileSync('git',['show',base+':apps/desktop/src/directory-catalog.ts'],{cwd:repository,encoding:'utf8'});
const compiled=ts.transpileModule(original,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const baseline=new Module(join(__dirname,'frozen-directory-baseline.cjs'),module);
baseline.paths=module.paths;baseline.filename=baseline.id;baseline._compile(compiled,baseline.filename);
const FrozenDirectoryCatalog=baseline.exports.DirectoryCatalog;
const normalized=checkpoint=>({...checkpoint,scanStartedAt:'WALL_CLOCK_ONLY'});
async function sweep(Type,root,metadata){
  let stats=0;const catalog=new Type(root,undefined,async()=>{stats++;return metadata;});
  const pages=[];const started=performance.now();
  for(;;){const page=await catalog.next(1,[]);pages.push(page);if(!catalog.inProgress)break;}
  const elapsedMs=performance.now()-started;
  return {pages,checkpoint:normalized(catalog.checkpoint()),stats,elapsedMs};
}
(async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'mote-E-directory-benchmark-'))),results=[];
  try{
    for(const count of [1000,6000,12000]){
      const directory=join(root,String(count));await mkdir(directory);
      const names=Array.from({length:count},(_,i)=>`generated-${String(i).padStart(6,'0')}.txt`);
      for(let start=0;start<names.length;start+=128)await Promise.all(names.slice(start,start+128).map(name=>writeFile(join(directory,name),'Generated')));
      const metadata=await lstat(join(directory,names[0]));
      const before=await sweep(FrozenDirectoryCatalog,directory,metadata),after=await sweep(DirectoryCatalog,directory,metadata);
      assert.deepEqual(after.pages,before.pages);assert.deepEqual(after.checkpoint,before.checkpoint);
      assert.equal(before.stats,count);assert.equal(after.stats,count);
      assert.equal(after.pages.at(-1).complete,true);assert.equal(after.pages.length,count+1);
      results.push({count,constantStat:true,statCalls:count,pages:count+1,equivalent:true,beforeMs:before.elapsedMs,afterMs:after.elapsedMs,speedup:before.elapsedMs/after.elapsedMs});
    }
  }finally{await rm(root,{recursive:true,force:true});}
  process.stdout.write(JSON.stringify({ok:true,base,node:process.version,platform:process.platform,arch:process.arch,generatedOnly:true,results,temporaryDirectoryRemoved:true})+'\n');
})().catch(error=>{console.error(error);process.exitCode=1;});
