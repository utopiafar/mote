import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {Store} from '../src/store.js';
import {MemoryStore} from '../src/memory.js';
import {SourceStore} from '../src/sources.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';

async function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-archive-admission-'));
 const config:Config={dataDir:directory,token:'generated-archive-admission-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:1_000_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,close:async()=>{},query:async()=>{throw Error('Generated archive fixtures must not invoke a live model');}}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 await node.app.listen({host:'127.0.0.1',port:0});
 const request=async(path:string,body?:unknown)=>fetch(new URL(path,node.app.listeningOrigin),{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+config.token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {...node,request};
}

test('HTTP automatic import after 500 retained sources archives original bytes and completes without a model',{timeout:60_000},async t=>{
 const node=await fixture(t);
 for(let i=0;i<500;i++)node.sources.register({id:'generated-history-'+i,name:'Generated historical import',kind:'upload',deviceId:'generated',platform:'import',enabled:false,retention:'archive'});
 const text='Generated original after the former source threshold 🌱';
 const response=await node.request('/api/imports',{files:[{name:'generated.txt',dataBase64:Buffer.from(text).toString('base64')}],processing:'automatic'});
 assert.equal(response.status,202);let job=await response.json();
 for(const deadline=Date.now()+30_000;Date.now()<deadline&&!['failed','completed','needs_configuration'].includes(job.status);){await setTimeout(25);job=await (await node.request('/api/imports/'+job.id)).json();}
 assert.equal(job.status,'completed',job.error);assert.equal(job.progress.imported,1);assert.equal(node.sources.listSources().length,501);
 assert.equal(node.store.evidence(job.captureIds)[0].ocrText,text);
 const original=await node.request('/api/archived-files/'+job.files[0].id+'/content');assert.equal(original.status,200);assert.equal(await original.text(),text);
 assert.equal(node.store.db.prepare('SELECT COUNT(*) n FROM model_usage').get()!.n,0);
});

test('HTTP owner correction, extraction and portable merge remain available after 100000 retained Memory revisions',{timeout:60_000},async t=>{
 const node=await fixture(t);
 node.sources.register({id:'generated-memory',name:'Generated authored evidence',kind:'custom',deviceId:'generated',platform:'import'});
 const text='Generated original preference used only for archive regressions.';
 const ack=await node.sources.upsert('generated-memory',{externalId:'original',revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'message',layer:'original',text});
 const result=(title:string)=>fixtureMemoryResult(node.memories,{answer:JSON.stringify({memories:[{title,statement:`Generated scoped preference [${ack.id}]`,uncertainty:'Generated fixture only',evidenceIds:[ack.id]}]}),citations:[{id:ack.id,capturedAt:'2026-01-01T00:00:00Z',appName:'Generated',excerpt:text}],trace:[],runId:randomUUID()});
 const memory=node.memories.publish(node.memories.extract(result('Generated original preference'),'generated').items[0].id);
 const archive=node.store.exportArchive(10_000_000),restoredId=randomUUID();archive.memories=[{...memory,id:restoredId}];
 // Every retained row has the current Memory shape; only its identity and stale status differ.
 const stale={...memory,status:'stale',staleReason:'evidence_changed'};
 node.store.db.prepare("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<99999) INSERT INTO memories(id,created_at,json) SELECT printf('00000000-0000-4000-8000-%012d',x),?,json_set(?,'$.id',printf('00000000-0000-4000-8000-%012d',x)) FROM n").run(memory.createdAt,JSON.stringify(stale));
 assert.equal(node.store.db.prepare('SELECT COUNT(*) n FROM memories').get()!.n,100000);
 const correction=await node.request('/api/memories/'+memory.id+'/correct',{version:memory.version,title:'Generated owner correction',statement:'Generated owner explicitly corrects the scoped preference.'});
 assert.equal(correction.status,200);const corrected=await correction.json();assert.equal(corrected.status,'published');assert.equal(corrected.model,'owner');
 assert.equal(node.memories.get(memory.id).supersededBy,corrected.id);assert.equal(node.store.evidence(corrected.evidenceIds)[0].source,'note');
 const late=await node.request('/api/memories/'+memory.id+'/correct',{version:memory.version,title:'Generated stale correction',statement:'A stale version must still be rejected.'});assert.equal(late.status,409);
 // A distinct statement creates a new candidate rather than exercising deduplication.
 const next=result('Generated newly extracted preference');const output=JSON.parse(next.answer);output.memories[0].statement=`Generated new statement [${ack.id}]`;next.answer=JSON.stringify(output);
 const extracted=node.memories.extract(next,'generated').items;assert.equal(extracted.length,1);
 await node.store.importArchive(archive);assert.equal(node.memories.get(restoredId).status,'stale');assert.equal(node.store.db.prepare('SELECT COUNT(*) n FROM memories').get()!.n,100003);
 // Portable output from this exact current vault must be consumable by a fresh vault, including deletion intent.
 node.memories.delete(extracted[0].id);
 const portable=node.store.exportArchive(400_000_000);assert.equal(portable.memories.length,100002);assert.equal(portable.memoryDeletions.length,1);
 const directory=mkdtempSync(join(tmpdir(),'mote-many-memory-roundtrip-')),mirror=new Store(directory,{maxStorageBytes:1_000_000_000});
 t.after(()=>{mirror.close();rmSync(directory,{recursive:true,force:true});});
 await mirror.importArchive(portable);const restored=new MemoryStore(mirror);
 assert.equal(mirror.db.prepare('SELECT COUNT(*) n FROM memories').get()!.n,100002);
 assert.equal(restored.get(corrected.id).status,'stale');assert.equal(restored.get(corrected.id).staleReason,'restored_archive');
 assert.equal(restored.get(memory.id).supersededBy,corrected.id);assert.equal(mirror.evidence(corrected.evidenceIds)[0].ocrText,node.store.evidence(corrected.evidenceIds)[0].ocrText);
 assert.equal(new SourceStore(mirror).getSource('generated-memory').enabled,false);
 assert.deepEqual(restored.deletions.export(),node.memories.deletions.export());assert.throws(()=>restored.get(extracted[0].id),{statusCode:404});
 assert.equal(node.store.db.prepare('SELECT COUNT(*) n FROM model_usage').get()!.n,0);
});
