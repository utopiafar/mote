import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';

type Drain={type:'drain';drains:number;rejoins:number;fullDetailReads:number;durationMs:number;cpuMs:number;resumed:boolean};
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function frozenRanges(directory:string,originalBatches?:readonly string[]){
 const db=new DatabaseSync(join(directory,'mote.sqlite'),{readOnly:true}),hash=createHash('sha256');
 try{
  for(const row of db.prepare("SELECT id,json_extract(json,'$.authorizedChunks') chunks,json_extract(json,'$.materialInputs') inputs,json_extract(json,'$.materialRefs') refs,json_extract(json,'$.automaticGrants') grants,json_extract(json,'$.workPackage') package FROM memory_jobs ORDER BY id").iterate())hash.update(JSON.stringify(row));
  const batchIds:string[]=[];
  for(const row of db.prepare("SELECT id,job_id,idx,json_extract(json,'$.chunks') chunks,json_extract(json,'$.evidenceRanges') ranges,json_extract(json,'$.materialInputs') inputs,json_extract(json,'$.materialRefs') refs FROM memory_batches ORDER BY id").iterate()){
   const id=String(row.id);batchIds.push(id);if(!originalBatches||originalBatches.includes(id))hash.update(JSON.stringify(row));
  }
  if(originalBatches)assert.ok(originalBatches.every(id=>batchIds.includes(id)),'transport partitioning cannot erase a saved parent');
  return {hash:hash.digest('hex'),batchIds};
 }finally{db.close();}
}
function assertPartitions(directory:string,originalBatches:readonly string[]){
 const db=new DatabaseSync(join(directory,'mote.sqlite'),{readOnly:true});
 try{
  let splitParents=0;const visited=new Set<string>();
  const batches=new Map(db.prepare('SELECT id,json FROM memory_batches').all().map(row=>[String(row.id),JSON.parse(String(row.json))]));
  const leaves=(id:string):any[]=>{assert.ok(!visited.has(id),'transport children cannot repeat or form a cycle');visited.add(id);const batch=batches.get(id);assert.ok(batch,'every transport child must remain durable');return batch.supersededBy?.length?batch.supersededBy.flatMap(leaves):[batch];};
  for(const id of originalBatches){
   const parent=batches.get(id),children=leaves(id);
   if(children.length>1)splitParents++;
   assert.deepEqual(children.flatMap(child=>child.chunks),parent.chunks,'transport children retain every exact original target/checkpoint in order');
   assert.deepEqual(children.flatMap(child=>child.evidenceRanges),parent.evidenceRanges,'transport subdivision cannot omit, clip or duplicate a frozen range');
   for(const child of children){
    assert.ok(child.materialInputs.every((pin:unknown)=>parent.materialInputs.some((original:unknown)=>JSON.stringify(original)===JSON.stringify(pin))),'transport children cannot mint or expand an original Material pin');
    assert.ok(Object.entries(child.materialRefs).every(([id,ref])=>parent.materialRefs[id]===ref),'transport children retain the original authorizing Material identities');
   }
  }
  assert.ok(splitParents>0,'native request/review sizing must durably subdivide saved over-budget work, including after restart');
  assert.deepEqual([...visited].sort(),[...batches.keys()].sort(),'every added transport batch must descend from exactly one frozen original parent');
 }finally{db.close();}
}
async function originalFiles(directory:string){
 const root=join(directory,'source-archive'),hash=createHash('sha256'),files=(await readdir(root,{recursive:true})).filter(name=>/\.(plain|aes)$/.test(name)).sort();
 assert.equal(files.length,540,'every received raw original must remain archived');
 for(const file of files)hash.update(file).update(await readFile(join(root,file)));
 return hash.digest('hex');
}

test('Central keeps HTTP responsive through native-budget source Memory recovery, debug logging and two starts with 540 frozen jobs',{timeout:180000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-source-startup-backlog-')),fixture=fileURLToPath(new URL('./fixtures/startup-source-memory-backlog.ts',import.meta.url));
 const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));
 const port=(socket.address() as {port:number}).port;await new Promise<void>((resolve,reject)=>socket.close(error=>error?reject(error):resolve()));
 const children:Array<ReturnType<typeof launch>>=[];
 function launch(mode:'seed'|'serve'){
  const child=spawn(process.execPath,['--import','tsx',fixture,mode,directory,String(port)],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH,TMPDIR:tmpdir(),MOTE_CONFIG_FILE:join(directory,'mote.yaml'),...(process.env.MOTE_STARTUP_WEB_ROOT?{MOTE_STARTUP_WEB_ROOT:process.env.MOTE_STARTUP_WEB_ROOT}:{})}});
  let output='',modelCalls=0;const drains:Drain[]=[];
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+chunk.toString()).slice(-8000);});
  child.on('message',message=>{const event=message as {type:string};if(event.type==='model')modelCalls++;if(event.type==='drain')drains.push(message as Drain);});
  const exited=new Promise<number|null>((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  const run={child,exited,output:()=>output,modelCalls:()=>modelCalls,drains};children.push(run);return run;
 }
 async function stop(run:ReturnType<typeof launch>){
  if(run.child.exitCode!==null||run.child.signalCode!==null)return;
  const force=setTimeout(()=>run.child.kill('SIGKILL'),5000);force.unref();run.child.kill('SIGTERM');
  try{assert.equal(await run.exited,0,run.output());}finally{clearTimeout(force);}
 }
 t.after(async()=>{try{for(const run of children)await stop(run);}finally{await rm(directory,{recursive:true,force:true});}});
 const seeded=performance.now(),seed=launch('seed');assert.equal(await seed.exited,0,seed.output());
 t.diagnostic(`real source intake/Material/claim seed: ${(performance.now()-seeded).toFixed(0)} ms`);
 // The first deployed start must also build its derived indexes over the full
 // existing backlog; seeding with the candidate must not hide that work.
 const unindexed=new DatabaseSync(join(directory,'mote.sqlite'));
 try{for(const name of ['memory_jobs_scheduling','memory_jobs_queue_status','memory_batches_scheduling'])unindexed.exec('DROP INDEX '+name);}finally{unindexed.close();}
 const expected=JSON.parse(await readFile(join(directory,'expected.json'),'utf8')) as {ids:string[];resumedId:string;material:string;range:unknown;webHash:string;asset:string;assetHash:string};
 const frozen=frozenRanges(directory),originals=await originalFiles(directory);
 const url=`http://127.0.0.1:${port}`,headers={authorization:'Bearer generated-source-backlog-owner-only'};
 let phase='startup';
 const request=async(path:string,method='GET')=>{
  try{return await fetch(url+path,{method,headers,signal:AbortSignal.timeout(1500)});}catch(error){throw new Error(`${phase}: ${method} ${path} failed`,{cause:error});}
 };
 for(let restart=0;restart<2;restart++){
  const began=performance.now(),run=launch('serve'),deadline=Date.now()+30000;
  while(!run.output().includes('"event":"server.listening"')&&Date.now()<deadline){assert.equal(run.child.exitCode,null,run.output());assert.equal(run.child.signalCode,null,run.output());await delay(25);}
  assert.match(run.output(),/"event":"server.listening"/,run.output());const startupMs=performance.now()-began;
  phase=`restart ${restart} static web after ${startupMs.toFixed(0)} ms startup`;
  const [web,asset]=await Promise.all([request('/'),request(expected.asset)]);
  assert.equal(web.status,200);assert.equal(digest(Buffer.from(await web.arrayBuffer())),expected.webHash);
  assert.equal(asset.status,200);assert.equal(digest(Buffer.from(await asset.arrayBuffer())),expected.assetHash);
  assert.equal((await fetch(url+'/api/memory-spaces/default/binding',{signal:AbortSignal.timeout(1500)})).status,401);
  if(restart===0){const resume=await request('/api/memory-jobs/'+expected.resumedId+'/resume','POST');assert.equal(resume.status,200,await resume.text());}
  phase=`restart ${restart} sustained drain`;const latencies:number[]=[],steadyUntil=Date.now()+18000;
  while(Date.now()<steadyUntil){
   const at=performance.now(),health=await request('/api/health');assert.equal(health.status,200);assert.equal((await health.json() as {ok:boolean}).ok,true);latencies.push(performance.now()-at);
   const binding=await request('/api/memory-spaces/default/binding');assert.equal(binding.status,200);const state=await binding.json() as {admission:{queued:number;running:number;checkpointed:number}};
   assert.equal(state.admission.queued+state.admission.running+state.admission.checkpointed,400,'completed history stays separate while every unfinished source claim is retained');
   await delay(250);
  }
  assert.ok(run.modelCalls()>0,'real source-owned work must reach the generated cancellable model transport');
  assert.ok(run.drains.length>=3,'the canonical recurring worker must drain across several intervals');
  assert.ok(run.drains.every(event=>event.rejoins>0&&event.fullDetailReads===0),'every drain must traverse dormant rejoin without opening full job details');
  assert.ok(run.drains.some(event=>event.resumed),'rotation past a whole paused page must rejoin the existing resumed claim');
  phase=`restart ${restart} original range`;const range=await request('/api/materials/'+expected.material+'/read?offset=27&length=81');assert.equal(range.status,200);assert.deepEqual(await range.json(),expected.range);
  await stop(run);await assert.rejects(readFile(join(directory,'server.pid')),{code:'ENOENT'});await assert.rejects(readFile(join(directory,'.mote.yaml.runtime.json')),{code:'ENOENT'});
  assert.ok((await readdir(join(directory,'logs'))).some(name=>name.startsWith('central.')),'enabled Central debug diagnostics must remain active through recovery and shutdown');
  assert.equal(frozenRanges(directory,frozen.batchIds).hash,frozen.hash,'shutdown/restart must retain every frozen job and original batch target, pin and grant');assertPartitions(directory,frozen.batchIds);assert.equal(await originalFiles(directory),originals,'all original archive bytes and identities must survive');
  t.diagnostic(`restart ${restart}: startup ${startupMs.toFixed(0)} ms, ${latencies.length} health probes, max ${Math.max(...latencies).toFixed(0)} ms; ${run.drains.length} drains/rejoins, max drain ${Math.max(...run.drains.map(event=>event.durationMs)).toFixed(0)} ms, full detail reads 0, generated model calls ${run.modelCalls()}`);
 }
});
