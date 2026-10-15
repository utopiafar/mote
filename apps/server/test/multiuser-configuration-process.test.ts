import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parse,stringify} from 'yaml';
import {defaultModelSettings} from '../src/model-settings.js';

const entry=process.env.MOTE_CONFIGURATION_PROCESS_ENTRY??fileURLToPath(new URL('../src/index.ts',import.meta.url));
const password='Generated-M04-process-password';
test('real production process serves scoped configuration/catalog, reloads YAML with CAS, and preserves A/B across restart',async t=>{
 const root=mkdtempSync(join(tmpdir(),'mote-m04-process-')),directory=join(root,'vault'),file=join(root,'instance.yaml');
 const sharedKey='synthetic-process-shared-key',aKey='synthetic-process-A-key',bKey='synthetic-process-B-key';
 const settings=(key:string,model:string)=>({...defaultModelSettings(),provider:'custom',protocol:'openai-completions',reasoningEffort:'auto',baseUrl:'http://127.0.0.1:9/v1',model,apiKey:key});
 writeFileSync(file,stringify({version:1,revision:0,storage:{dataDir:directory},server:{host:'127.0.0.1',port:0},models:{deployment:settings(sharedKey,'shared-fixture')}}));
 const env={...process.env,MOTE_CONFIG_FILE:file},bootstrap=fileURLToPath(new URL('../src/scope/initialize-admin.ts',import.meta.url));
 execFileSync(process.execPath,['--import','tsx',bootstrap],{env,input:JSON.stringify({username:'process-admin',password}),stdio:['pipe','pipe','pipe'],timeout:15000});
 let active:Awaited<ReturnType<typeof start>>|undefined,output='';
 async function start(){
  const child=spawn(process.execPath,entry.endsWith('.ts')?['--import','tsx',entry]:[entry],{env,stdio:['ignore','pipe','pipe']}),closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
  child.stderr.on('data',part=>output+=part);
  const url=await new Promise<string>((resolve,reject)=>{
   const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('M04 synthetic startup timeout'));},15000);let stdout='';
   child.once('exit',code=>{clearTimeout(timer);reject(Error('M04 synthetic startup exit '+code));});
   child.stdout.on('data',part=>{stdout+=part;output+=part;for(const line of stdout.split('\n'))try{const event=JSON.parse(line);if(event.event==='server.listening'){clearTimeout(timer);resolve('http://127.0.0.1:'+event.port);}}catch{}});
  });return {child,closed,url};
 }
 t.after(async()=>{if(active){active.child.kill('SIGTERM');await active.closed;}rmSync(root,{recursive:true,force:true});});
 active=await start();
 const request=async(method:string,path:string,payload?:unknown,token?:string)=>{
  const result=await fetch(active!.url+path,{method,headers:{'x-mote-protocol-version':'2',...(payload===undefined?{}:{'content-type':'application/json'}),...(token?{authorization:'Bearer '+token}:{})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
  const text=await result.text();for(const key of [sharedKey,aKey,bKey])assert.ok(!text.includes(key));return {status:result.status,body:JSON.parse(text)};
 };
 const login=async(username:string)=>{const r=await request('POST','/api/auth/login',{username,password,mode:'client'});assert.equal(r.status,200);return r.body;};
 const admin=await login('process-admin');for(const username of ['process-a','process-b'])assert.equal((await request('POST','/api/admin/accounts',{username,password},admin.token)).status,200);
 const a=await login('process-a'),b=await login('process-b');
 for(const [grant,key,model] of [[a,aKey,'model-A'],[b,bKey,'model-B']] as const){
  const value={profiles:[{id:'same-profile',name:'Synthetic model',settings:settings(key,model)}],selections:{chat:{kind:'personal',id:'same-profile'}}};
  assert.equal((await request('PUT','/api/configuration/models',{revision:0,value},grant.token)).status,200);
 }
 assert.equal((await request('GET','/api/models',undefined,a.token)).body.shared[0].model,'shared-fixture');
 assert.equal((await request('GET','/api/models/selection/chat',undefined,b.token)).body.model,'model-B');
 const path=join(directory,'configuration','users',a.userId,'mote.yaml'),document=parse(readFileSync(path,'utf8'));document.models.profiles[0].settings.model='file-A';writeFileSync(path,stringify(document));
 assert.equal((await request('POST','/api/configuration/reload',{},a.token)).status,200);
 assert.equal((await request('PATCH','/api/configuration',{revision:1,patches:{models:{selections:{}}}},a.token)).status,409);
 assert.equal((await request('PATCH','/api/configuration',{revision:2,patches:{server:{port:1}}},a.token)).status,400);
 assert.equal((await request('GET','/api/configuration?userId='+b.userId,undefined,admin.token)).status,401);
 assert.equal((await request('GET','/api/materials',undefined,a.token)).status,503);
 active.child.kill('SIGTERM');await active.closed;active=undefined;active=await start();
 assert.equal((await request('GET','/api/models/selection/chat',undefined,a.token)).body.model,'file-A');assert.equal((await request('GET','/api/models/selection/chat',undefined,b.token)).body.model,'model-B');
 assert.equal((await request('GET','/api/usage',undefined,a.token)).body.total.runs,0);
 assert.equal((await request('PATCH','/api/admin/accounts/'+a.userId,{disabled:true},admin.token)).status,200);
 assert.equal((await request('GET','/api/configuration',undefined,a.token)).status,401);assert.equal((await request('GET','/api/models',undefined,b.token)).status,200);
 for(const key of [sharedKey,aKey,bKey,password])assert.ok(!output.includes(key));
});
