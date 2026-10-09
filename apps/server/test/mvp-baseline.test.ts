import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {buildApp,type QueryAgent} from '../src/app.js';
import {Store} from '../src/store.js';
import type {Config} from '../src/config.js';
import {restoreProfile} from '../../../scripts/profile-lib.mjs';

const config=(dataDir:string):Config=>({dataDir,token:'generated-mvp-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'});
const result=()=>({answer:'Generated current answer',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids:[]}});
const inactive:QueryAgent={configured:false,close:async()=>{},query:async()=>{throw Error('No model call expected');}};
async function until(read:()=>boolean){const deadline=Date.now()+15000;while(Date.now()<deadline){if(read())return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Generated lifecycle did not settle');}

test('epoch 3 is rejected before schema or originals are changed',t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-old-baseline-')),path=join(directory,'mote.sqlite'),db=new DatabaseSync(path);
 db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO settings VALUES('backend_epoch','3');CREATE TABLE preserved(body TEXT);INSERT INTO preserved VALUES('Generated old fixture');");db.close();
 t.after(()=>rmSync(directory,{recursive:true,force:true}));const before=readFileSync(path);
 assert.throws(()=>new Store(directory),/epoch 4/);assert.deepEqual(readFileSync(path),before);assert.equal(existsSync(join(directory,'files')),false);assert.equal(existsSync(join(directory,'blobs')),false);
});

test('fresh app installs current defaults and intake projections before receiving originals',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-fresh-baseline-')),node=await buildApp(config(directory),{agent:inactive,backgroundWorker:false});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 assert.equal(node.processing.imageDefault().profile.processorId,'image.http');assert.equal(node.lifecycle.settings().extraction.enabled,true);
 assert.throws(()=>node.lifecycle.configure({...node.lifecycle.settings(),extraction:{...node.lifecycle.settings().extraction,enabled:false}}));
 assert.throws(()=>node.sourcePipelines.configure('generated',{memory:false}));
 assert.throws(()=>node.featureServices.queryRuns.start(randomUUID(),{}),{statusCode:400});
 assert.equal(node.store.db.prepare("SELECT count(*) n FROM settings WHERE key IN ('model-budgets','image-policy-migrated')").get()!.n,0);
 assert.equal(node.store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'model_budget_%' OR name='processing_usage'").get()!.n,0);
 const bytes=await (await import('sharp')).default({create:{width:16,height:16,channels:3,background:'#6699cc'}}).png().toBuffer(),id=randomUUID();
 await node.store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'screen',capturedAt:new Date().toISOString(),durationMs:0,imageMime:'image/png',imageBase64:bytes.toString('base64')});
 assert.equal(node.store.db.prepare('SELECT auto_eligible FROM image_inputs WHERE capture_id=?').get(id)!.auto_eligible,1);
 assert.equal(node.store.db.prepare('SELECT count(*) n FROM image_inputs').get()!.n,1);
});

test('current HTTP query timeout and cancellation fence uncooperative late answers',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-current-deadline-'));let release!:()=>void;
 const held=new Promise<void>(resolve=>release=resolve),signals:AbortSignal[]=[];
 const node=await buildApp(config(directory),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async input=>{signals.push(input.signal!);await held;return result();}}});
 t.after(async()=>{release();await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const expired=randomUUID(),cancelled=randomUUID(),headers={authorization:'Bearer generated-mvp-owner'};
 node.featureServices.queryRuns.start(expired,{question:'Generated deadline'},{timeoutMs:5000});await until(()=>signals.length>0);await until(()=>node.featureServices.queryRuns.get(expired).status!=='running');
 assert.equal(node.featureServices.queryRuns.get(expired).error?.code,'timeout');
 const accepted=await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id:cancelled,input:{question:'Generated cancel'}}});assert.equal(accepted.statusCode,202,accepted.body);
 assert.equal((await node.app.inject({method:'POST',url:'/api/query-runs/'+cancelled+'/cancel',headers})).json().status,'cancelled');
 release();await new Promise(resolve=>setTimeout(resolve,50));
 for(const id of [expired,cancelled])assert.equal(node.featureServices.queryRuns.get(id).turnId,undefined);
 assert.equal(node.store.db.prepare('SELECT count(*) n FROM conversation_turns').get()!.n,0);assert.ok(signals[0].aborted);
});

test('current backup restores a durable query and never repeats its completed answer',async t=>{
 const root=mkdtempSync(join(tmpdir(),'mote-current-query-backup-')),source=join(root,'source'),backup=join(root,'backup'),target=join(root,'target'),id=randomUUID();let entered=false,calls=0;
 let node=await buildApp(config(source),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async input=>{entered=true;await new Promise(resolve=>input.signal!.addEventListener('abort',resolve,{once:true}));throw input.signal!.reason;}}});
 t.after(async()=>{await node.app.close();rmSync(root,{recursive:true,force:true});});
 const accepted=await node.app.inject({method:'POST',url:'/api/query-runs',headers:{authorization:'Bearer generated-mvp-owner'},payload:{id,input:{question:'Generated saved question'}}});assert.equal(accepted.statusCode,202,accepted.body);await until(()=>entered);
 await node.app.close();execFileSync(process.execPath,['--import','tsx',fileURLToPath(new URL('../../../scripts/backup.ts',import.meta.url)),'--data',source,'--out',backup],{stdio:'pipe'});
 await restoreProfile({meta:{runtime:'native'},dataDir:target,processFile:join(root,'missing-process')},backup);
 const agent:QueryAgent={configured:true,close:async()=>{},query:async()=>{calls++;return result();}};
 node=await buildApp(config(target),{agent,backgroundWorker:false});await until(()=>node.featureServices.queryRuns.get(id).status==='completed');
 const receipt=node.featureServices.queryRuns.get(id);assert.ok(receipt.turnId);assert.equal(calls,1);await node.app.close();
 node=await buildApp(config(target),{agent,backgroundWorker:false});assert.equal(node.featureServices.queryRuns.get(id).turnId,receipt.turnId);assert.equal(calls,1);
});
