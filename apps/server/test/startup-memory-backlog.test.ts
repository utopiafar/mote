import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

test('Central starts its static web and serves automatic Memory state while recovering a 540-job backlog',{timeout:90000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-startup-backlog-')),fixture=fileURLToPath(new URL('./fixtures/startup-memory-backlog.ts',import.meta.url));
 const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));
 const port=(socket.address() as {port:number}).port;await new Promise<void>((resolve,reject)=>socket.close(error=>error?reject(error):resolve()));
 const children:Array<ReturnType<typeof launch>>=[];
 function launch(mode:'seed'|'serve'){
  const child=spawn(process.execPath,['--import','tsx',fixture,mode,directory,String(port)],{
   stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH,TMPDIR:tmpdir(),MOTE_CONFIG_FILE:join(directory,'mote.yaml')},
  });
  let output='',modelCalls=0;for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+chunk.toString()).slice(-8000);});
  child.on('message',message=>{if((message as {type?:string}).type==='model')modelCalls++;});
  const exited=new Promise<number|null>((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  const result={child,exited,output:()=>output,modelCalls:()=>modelCalls};children.push(result);return result;
 }
 async function stop(run:ReturnType<typeof launch>){
  if(run.child.exitCode!==null||run.child.signalCode!==null)return;
  const force=setTimeout(()=>run.child.kill('SIGKILL'),5000);force.unref();run.child.kill('SIGTERM');
  try{assert.equal(await run.exited,0,run.output());}finally{clearTimeout(force);}
 }
 t.after(async()=>{try{for(const run of children)await stop(run);}finally{await rm(directory,{recursive:true,force:true});}});
 const seed=launch('seed');assert.equal(await seed.exited,0,seed.output());
 const expected=JSON.parse(await readFile(join(directory,'expected.json'),'utf8')) as {receiptId:string;text:string;ids:string[];manualId:string};
 const url=`http://127.0.0.1:${port}`,headers={authorization:'Bearer generated-startup-backlog-owner-only'};
 for(let restart=0;restart<2;restart++){
  const began=performance.now(),run=launch('serve'),deadline=Date.now()+20000;
  while(!run.output().includes('"event":"server.listening"')&&Date.now()<deadline){
   assert.equal(run.child.exitCode,null,run.output());assert.equal(run.child.signalCode,null,run.output());await delay(25);
  }
  assert.match(run.output(),/"event":"server.listening"/,run.output());
  const startupMs=performance.now()-began;
  const [web,asset,health,binding]=await Promise.all([
   fetch(url+'/',{signal:AbortSignal.timeout(1500)}),fetch(url+'/assets/generated-174.js',{signal:AbortSignal.timeout(1500)}),
   fetch(url+'/api/health',{signal:AbortSignal.timeout(1500)}),fetch(url+'/api/memory-spaces/default/binding',{headers,signal:AbortSignal.timeout(1500)}),
  ]);
  assert.equal(web.status,200);assert.match(await web.text(),/Generated startup web/);
  assert.equal(asset.status,200);assert.match(await asset.text(),/Generated static startup asset/);
  assert.equal(health.status,200);assert.equal((await health.json() as {ok:boolean}).ok,true);
  assert.equal(binding.status,200);const view=await binding.json() as {admission:{queued:number;running:number;checkpointed:number}};
  assert.equal(view.admission.queued+view.admission.running+view.admission.checkpointed,540);
  const original=await fetch(url+'/api/captures/'+expected.receiptId,{headers,signal:AbortSignal.timeout(1500)});
  assert.equal(original.status,200);assert.equal((await original.json() as {ocrText:string}).ocrText,expected.text);
  assert.equal((await fetch(url+'/api/memory-spaces/default/binding',{signal:AbortSignal.timeout(1500)})).status,401);
  const modelDeadline=Date.now()+5000;while(!run.modelCalls()&&Date.now()<modelDeadline)await delay(25);
  if(!run.modelCalls()){
   const detail=await (await fetch(url+'/api/memory-jobs/'+expected.manualId,{headers,signal:AbortSignal.timeout(1500)})).json() as any;
   assert.fail('Recovering jobs must reach the generated model transport: '+JSON.stringify({status:detail.status,errorCode:detail.errorCode,batches:detail.batches?.map((batch:any)=>({status:batch.status,errorCode:batch.errorCode}))}));
  }
  await stop(run);
  await assert.rejects(readFile(join(directory,'server.pid')),{code:'ENOENT'});
  await assert.rejects(readFile(join(directory,'.mote.yaml.runtime.json')),{code:'ENOENT'});
  t.diagnostic(`restart ${restart}: startup ${startupMs.toFixed(0)} ms, ${run.modelCalls()} generated model calls, 540 persisted jobs`);
 }
});
