import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {formatEvidenceRef} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {Store} from '../src/store.js';
import {ModelSettingsStore} from '../src/model-settings.js';

const inactive={configured:false,query:async()=>{throw Error('No fixture model call authorized');},close:async()=>{}};
const config=(dataDir:string):Config=>({dataDir,token:'generated-contract-owner',tokenPath:'generated',profile:'test',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:20_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'https://generated.invalid',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''});

test('fresh epoch 4 installs final schema and refuses an old epoch without changing its persisted rows',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-epoch4-contract-')),node=await buildApp(config(directory),{agent:inactive,backgroundWorker:false});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 assert.equal(node.store.db.prepare("SELECT value FROM settings WHERE key='backend_epoch'").get()!.value,'4');
 assert.equal(node.store.db.prepare('PRAGMA user_version').get()!.user_version,4);
 for(const [table,column] of [['execution_steps','recovery_deadline'],['material_blocks','anchor_id'],['file_jobs','policy_json'],['memory_deletion_dependencies','lineage_keys'],['material_memory_requests','scope']])assert.ok(node.store.db.prepare(`PRAGMA table_info(${table})`).all().some(row=>row.name===column),table+'.'+column);
 assert.ok(node.store.db.prepare("SELECT sql FROM sqlite_master WHERE name='material_block_payload_delete'").get()!.sql.includes('material_block_versions'));
 node.store.db.prepare("INSERT INTO settings(key,value) VALUES('generated-preserved','yes')").run();node.store.db.prepare("UPDATE settings SET value='2' WHERE key='backend_epoch'").run();
 assert.throws(()=>new Store(directory),/epoch|backend/i);
 assert.equal(node.store.db.prepare("SELECT value FROM settings WHERE key='backend_epoch'").get()!.value,'2');
 assert.equal(node.store.db.prepare("SELECT value FROM settings WHERE key='generated-preserved'").get()!.value,'yes');
});

test('current resource IDs, typed readers, explicit policies and frozen Memory jobs have distinct strict contracts',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-current-contract-')),node=await buildApp(config(directory),{agent:inactive,backgroundWorker:false});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const id=randomUUID(),bytes=await sharp({create:{width:8,height:8,channels:3,background:'#16495c'}}).png().toBuffer();
 await node.store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'screen',capturedAt:'2026-09-20T00:00:00Z',durationMs:0,ocrText:'Generated current evidence.',ocr:{status:'completed'},imageMime:'image/png',imageBase64:bytes.toString('base64')});
 const reader=node.featureServices.evidenceReader;
 assert.equal(reader.evidence([id]).length,0);assert.equal(reader.evidence([formatEvidenceRef('capture',id)]).length,1);
 const headers={authorization:'Bearer generated-contract-owner'},image=await node.app.inject({url:`/api/captures/${id}/image`,headers});assert.equal(image.statusCode,200);assert.deepEqual(image.rawPayload,bytes);
 assert.equal((await node.app.inject({url:`/api/captures/${encodeURIComponent(formatEvidenceRef('capture',id))}/image`,headers})).statusCode,400);
 const view=node.processing.view();assert.throws(()=>node.processing.update({revision:view.revision,settings:view.settings}));
 const audio=view.policy.profiles.find(profile=>profile.processorId==='audio.local-dialogue')!;assert.equal(audio.serviceId,'asr-local','fresh defaults bind current builtins before plugin initialization');
 const job=node.memoryPipeline.create({evidenceIds:[id],contextTime:'2026-10-01T00:00:00Z'});assert.equal(job.inputPlanVersion,1);assert.equal(job.contextTime,'2026-10-01T00:00:00Z');assert.ok(Array.isArray(job.materialInputs));assert.ok(Array.isArray(job.recipeProgress));assert.equal(job.memoryCount,0);assert.equal(job.inputPlans.total,0);assert.equal(job.activationRequired,true);
 node.store.db.prepare("UPDATE memory_jobs SET json=json_remove(json,'$.contextTime') WHERE id=?").run(job.id);assert.throws(()=>node.memoryPipeline.get(job.id),/Unsupported Memory job/);
});

test('current model registry persists version 2 and refuses a retired single-model envelope unchanged',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-profile-contract-')),node=await buildApp(config(directory),{agent:inactive,backgroundWorker:false,createModelAgent:async()=>inactive});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 await node.modelSettings.update({revision:0,settings:{...node.modelSettings.current(),model:'generated-model'}});
 const path=join(directory,'model-settings.json'),saved=JSON.parse(readFileSync(path,'utf8'));assert.equal(saved.version,2);assert.ok(saved.profiles.some((profile:{id:string})=>profile.id==='primary'));assert.ok(saved.defaults);assert.ok(saved.defaultModels);assert.equal(saved.settings,undefined);
 const retired=JSON.stringify({version:1,revision:1,settings:node.modelSettings.current()});writeFileSync(path,retired);
 const rejected=new ModelSettingsStore({directory,environment:node.modelSettings.current(),prepare:async()=>({activate(){},async dispose(){}}),probe:async()=>({ok:true,code:'ok',message:'Generated',durationMs:0})});
 await assert.rejects(rejected.initialize());assert.equal(readFileSync(path,'utf8'),retired);
});
