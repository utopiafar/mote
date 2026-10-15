import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {serializeConfigDocument} from '@mote/shared/config-file';
const entry=process.env.MOTE_INGRESS_PROCESS_ENTRY??fileURLToPath(new URL('../src/index.ts',import.meta.url));
const password='Generated-ingress-process-01';
test('real server startup, account-bound intake, lost ACK restart and authenticated original download use the production listener',async t=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'mote-m03-process-')),directory=join(root,'vault'),file=join(root,'generated.yaml');writeFileSync(file,serializeConfigDocument({version:1,revision:0,storage:{dataDir:directory},server:{host:'127.0.0.1',port:0}}));
 const env={...process.env,MOTE_CONFIG_FILE:file,MOTE_TOKEN:'synthetic-retired-owner-token-12345'};
 execFileSync(process.execPath,['--import','tsx',fileURLToPath(new URL('../src/scope/initialize-admin.ts',import.meta.url))],{env,input:JSON.stringify({username:'generated-admin',password}),stdio:['pipe','pipe','pipe'],timeout:15000});
 let active:Awaited<ReturnType<typeof start>>|undefined;
 async function start(){const child=spawn(process.execPath,entry.endsWith('.ts')?['--import','tsx',entry]:[entry],{env,stdio:['ignore','pipe','pipe']}),closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));const url=await new Promise<string>((resolve,reject)=>{const deadline=setTimeout(()=>{child.kill('SIGTERM');reject(Error('Generated ingress startup timeout'));},15000);let output='',errors='';child.stderr.on('data',part=>errors+=String(part).slice(0,8192));child.once('exit',code=>{clearTimeout(deadline);reject(Error('Generated ingress startup exited '+code+': '+errors));});child.stdout.on('data',part=>{output+=part;for(const line of output.split('\n'))try{const event=JSON.parse(line);if(event.event==='server.listening'){clearTimeout(deadline);resolve('http://127.0.0.1:'+event.port);}}catch{}});});return {child,closed,url};}
 t.after(async()=>{if(active){active.child.kill('SIGTERM');await active.closed;}rmSync(root,{recursive:true,force:true});});active=await start();
 const request=async(method:string,path:string,body?:unknown,token?:string)=>{const response=await fetch(active!.url+path,{method,headers:{'x-mote-protocol-version':'2','x-mote-ingress-version':'3',...(body===undefined?{}:{'content-type':'application/json'}),...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json() as any};};
 const admin=await request('POST','/api/auth/login',{username:'generated-admin',password,mode:'client'});assert.equal(admin.status,200);
 const users=[];for(const username of ['generated-a','generated-b']){assert.equal((await request('POST','/api/admin/accounts',{username,password},admin.body.token)).status,200);const user=await request('POST','/api/auth/login',{username,password,mode:'client'});users.push(user.body);assert.equal((await request('POST','/api/ingress/sources',{id:'same-source',name:'Generated source',kind:'custom',deviceId:'same-device',platform:'import'},user.body.token)).status,200);}
 const bytes=Buffer.from('Generated process screenshot'),capture={id:randomUUID(),deviceId:'same-device',deviceName:'Generated fixture',platform:'import',capturedAt:'2026-01-01T00:00:00Z',durationMs:0,source:'screen',imageBase64:bytes.toString('base64'),imageMime:'image/png'},batch={batchId:'same-batch',items:[capture]},first=await request('POST','/api/ingress/sources/same-source/captures',batch,users[0].token);assert.equal(first.status,200);
 active.child.kill('SIGTERM');await active.closed;active=undefined;active=await start();const replay=await request('POST','/api/ingress/sources/same-source/captures',batch,users[0].token);assert.deepEqual(replay.body,first.body);const second=await request('POST','/api/ingress/sources/same-source/captures',batch,users[1].token);assert.equal(second.status,200);assert.notEqual(second.body.id,first.body.id);
 const original=first.body.captures[0].original.ref.slice(9),ticket=await request('POST',`/api/ingress/originals/${original}/tickets`,{},users[0].token);assert.equal(ticket.status,200);
 const path=`/api/ingress/originals/${original}/content?ticket=${ticket.body.ticket}`;assert.equal((await request('GET',path,undefined,users[1].token)).status,404);
 const download=await fetch(active.url+path,{headers:{'x-mote-protocol-version':'2','x-mote-ingress-version':'3',authorization:'Bearer '+users[0].token}});assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
 assert.equal((await request('POST','/api/ask',{},users[0].token)).status,503);
});
