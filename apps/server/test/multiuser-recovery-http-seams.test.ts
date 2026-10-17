import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {createServer,type ServerResponse} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';

const password='Generated-recovery-seams-password';
async function until(check:()=>boolean|Promise<boolean>,label:string){
 const deadline=Date.now()+15000;
 while(!await check()){assert.ok(Date.now()<deadline,label);await delay(10);}
}
async function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-recovery7-http-'));
 const calls:{taskId:string;issuance:string;owner:string;response:ServerResponse}[]=[];
 const upstream=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;calls.push({...JSON.parse(body),response:res});});
 const children:ReturnType<typeof spawn>[]=[];
 t.after(async()=>{
  for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}
  upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));
  rmSync(directory,{recursive:true,force:true});
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const external='http://127.0.0.1:'+(upstream.address() as {port:number}).port;
 const start=async(initialize=false)=>{
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/recovery-http-host.ts',import.meta.url))],{
   env:{...process.env,MOTE_GENERATED_RECOVERY_DIRECTORY:directory,MOTE_GENERATED_RECOVERY_EXTERNAL:external,MOTE_GENERATED_RECOVERY_INITIALIZE:initialize?'1':'0'},stdio:['ignore','ignore','pipe','ipc'],
  });children.push(child);
  let diagnostic='',origin='';const settled:{settled:string;accepted:boolean}[]=[];
  child.stderr!.on('data',chunk=>{diagnostic=(diagnostic+String(chunk)).slice(-4096);});
  child.on('message',(value:any)=>{if(value.ready)origin='http://127.0.0.1:'+value.ready.port;if(value.settled)settled.push(value);});
  await until(()=>{assert.equal(child.exitCode,null,diagnostic);return Boolean(origin);},'generated process did not listen');
  const request=async(token:string|undefined,path:string,method='GET',payload?:unknown)=>{
   const response=await fetch(origin+path,{method,headers:{'x-mote-protocol-version':'2',...(token?{authorization:'Bearer '+token}:{}),...(payload===undefined?{}:{'content-type':'application/json'})},...(payload===undefined?{}:{body:JSON.stringify(payload)}),signal:AbortSignal.timeout(10000)});
   return {status:response.status,body:await response.json() as any};
  };
  const ok=async(...args:Parameters<typeof request>)=>{const response=await request(...args);assert.equal(response.status,200,JSON.stringify(response.body));return response.body;};
  const login=(username:string)=>ok(undefined,'/api/auth/login','POST',{username,password,mode:'client'});
  const submit=(token:string,operationId:string,external=true,dependencies:string[]=[])=>ok(token,'/api/tasks','POST',{kind:'generated.recovery-http',operationId,input:{external},dependencies});
  const task=(token:string,id:string)=>ok(token,'/api/tasks/'+id);
  const wait=async(token:string,id:string,state:string)=>{let value:any;await until(async()=>{value=await task(token,id);return value.state===state;},'task did not reach '+state);return value;};
  const kill=async()=>{const exit=once(child,'exit');child.kill('SIGKILL');await exit;assert.equal(child.signalCode,'SIGKILL');};
  return {child,settled,request,ok,login,submit,task,wait,kill};
 };
 const first=await start(true),admin=await first.login('generated-admin');
 for(const username of ['generated-a','generated-b'])await first.ok(admin.token,'/api/admin/accounts','POST',{username,password});
 const a=await first.login('generated-a'),b=await first.login('generated-b');
 // Match the product's connection wait while the separate host finishes a
 // revocation transaction; a zero-wait observer can race the real writer.
 const read=<T>(query:(db:DatabaseSync)=>T)=>{const db=new DatabaseSync(join(directory,'mote.sqlite'),{readOnly:true});try{db.exec('PRAGMA busy_timeout=5000');return query(db);}finally{db.close();}};
 return {directory,calls,start,first,admin,a,b,read};
}

test('SIGKILL after real external HTTP issuance preserves unknown facts and checkpoints until explicit owner retry',async t=>{
 const f=await fixture(t),job=await f.first.submit(f.a.token,'generated-kill-issued');
 await until(()=>f.calls.length===1,'external HTTP was not issued');
 const child=await f.first.submit(f.a.token,'generated-dependent',false,[job.id]);
 const b=await f.first.submit(f.b.token,'generated-independent',false);await f.first.wait(f.b.token,b.id,'succeeded');
 const original=f.read(db=>db.prepare('SELECT * FROM task_external_calls WHERE task_id=?').get(job.id));assert.equal(original!.state,'issued');
 await f.first.kill();
 // Fault injection only: shorten the dead host lease in this generated DB.
 const db=new DatabaseSync(join(f.directory,'mote.sqlite'));try{db.prepare('UPDATE execution_steps SET lease_until=0 WHERE id=?').run(job.id);}finally{db.close();}
 const replacement=await f.start();await replacement.wait(f.a.token,job.id,'blocked');await replacement.wait(f.a.token,child.id,'blocked');
 f.calls[0].response.end('Generated late external ACK');
 assert.equal((await replacement.request(f.a.token,'/api/tasks/'+job.id+'/retry','POST',{})).status,409);
 assert.equal((await replacement.request(f.b.token,'/api/tasks/'+job.id+'/retry','POST',{confirmUnknown:true})).status,404);
 assert.equal(f.calls.length,1);assert.deepEqual(f.read(db=>db.prepare('SELECT * FROM task_external_calls WHERE task_id=?').get(job.id)),original);
 await replacement.ok(f.a.token,'/api/tasks/'+job.id+'/retry','POST',{confirmUnknown:true});
 await until(()=>f.calls.length===2,'confirmed retry did not issue a fresh call');assert.notEqual(f.calls[0].issuance,f.calls[1].issuance);
 f.calls[1].response.end('Generated current ACK');const completed=await replacement.wait(f.a.token,job.id,'succeeded');
 assert.equal(completed.result.reused,true);assert.deepEqual(completed.result.checkpoint,{count:1,owner:f.a.userId});
 await replacement.ok(f.a.token,'/api/tasks/'+child.id+'/retry','POST',{});await replacement.wait(f.a.token,child.id,'succeeded');
 assert.deepEqual(f.read(db=>db.prepare('SELECT state FROM task_external_calls WHERE task_id=? ORDER BY state').all(job.id)).map(row=>row.state),['succeeded','unknown']);
 assert.equal(f.read(db=>db.prepare('SELECT count(*) n FROM task_external_retry_confirmations').get()!.n),1);
 assert.equal((await replacement.task(f.b.token,b.id)).result.owner,f.b.userId);
 assert.deepEqual(f.read(db=>db.prepare('PRAGMA foreign_key_check').all()),[]);
});

for(const action of ['cancel','disable'] as const)test('late external HTTP ACK cannot publish after '+action,async t=>{
 const f=await fixture(t),job=await f.first.submit(f.a.token,'generated-late-ack');await until(()=>f.calls.length===1,'external call did not start');
 if(action==='cancel')await f.first.ok(f.a.token,'/api/tasks/'+job.id+'/cancel','POST',{});
 else await f.first.ok(f.admin.token,'/api/admin/accounts/'+f.a.userId,'PATCH',{disabled:true});
 const b=await f.first.submit(f.b.token,'generated-b-positive',false);await f.first.wait(f.b.token,b.id,'succeeded');
 f.calls[0].response.end('Generated revoked ACK');await until(()=>f.first.settled.length===1,'old callback did not settle');assert.equal(f.first.settled[0].accepted,false);
 const stored=f.read(db=>db.prepare('SELECT t.result,t.external_state,e.state FROM user_tasks t JOIN execution_steps e ON e.id=t.task_id WHERE t.task_id=?').get(job.id))!;
 assert.equal(stored.result,null);assert.equal(stored.external_state,'issued');assert.notEqual(stored.state,'succeeded');
 assert.equal(f.calls.length,1);assert.equal((await f.first.task(f.b.token,b.id)).state,'succeeded');
 if(action==='disable')assert.equal((await f.first.request(f.a.token,'/api/tasks/'+job.id)).status,401);
 else assert.equal((await f.first.task(f.a.token,job.id)).state,'cancelled');
});
