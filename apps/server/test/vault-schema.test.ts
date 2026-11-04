import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
import {Conversations} from '../src/conversations.js';
import {installVaultSchema} from '../src/vault-schema-installation.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';

const schema=(store:Store)=>store.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();

test('first capture intake has OCR, gallery, search, count and foreign-key constraints before any feature starts',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-vault-schema-intake-')),store=new Store(directory);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const image=await sharp({create:{width:12,height:8,channels:3,background:'#83a69b'}}).png().toBuffer();
 const input={id:randomUUID(),deviceId:'generated-device',deviceName:'Generated',platform:'macos',capturedAt:'2026-10-01T00:00:00.000Z',durationMs:1000,appId:'generated.schema',appName:'Generated schema intake',ocrText:'',source:'screen',privacy:{excluded:false,redacted:false,mode:'local'},imageBase64:image.toString('base64'),imageMime:'image/png'};
 await store.ingest(input);
 assert.equal(store.db.prepare('SELECT state FROM perception_jobs WHERE capture_id=?').get(input.id)?.state,'waiting');
 assert.equal(store.db.prepare('SELECT has_image FROM capture_gallery WHERE id=?').get(input.id)?.has_image,1);
 assert.equal(store.search({query:'schema'}).some(item=>item.id===input.id),true);
 assert.equal((store.stats() as {captures:number;blobs:number}).captures,1);
 assert.equal((store.stats() as {captures:number;blobs:number}).blobs,1);
 assert.equal(store.db.prepare('SELECT context_at FROM captures WHERE id=?').get(input.id)?.context_at,input.capturedAt);
 assert.throws(()=>store.db.prepare('INSERT INTO memory_batches(id,job_id,idx,json) VALUES(?,?,?,?)').run('generated-batch','missing-job',0,'{}'),/FOREIGN KEY/);
 assert.throws(()=>store.db.prepare('INSERT INTO file_versions(capture_id,source_id,external_id,revision,manifest) VALUES(?,?,?,?,?)').run('missing-capture','generated','item','1','{}'),/FOREIGN KEY/);
 store.delete(input.id);
 assert.equal(store.db.prepare('SELECT count(*) n FROM perception_jobs').get()?.n,0);
 assert.equal(store.db.prepare('SELECT count(*) n FROM capture_gallery').get()?.n,0);
 assert.equal(store.search({query:'schema'}).length,0);
 assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('current vault schema can be installed repeatedly and restarted without changing source, memory, insight or conversation identities',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-vault-schema-restart-'));let store=new Store(directory);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const sources=new SourceStore(store),memories=new MemoryStore(store),conversations=new Conversations(store);
 sources.register({id:'generated-source',name:'Generated',kind:'custom',deviceId:'generated',platform:'import'});
 const input={externalId:'generated-item',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',text:'Generated exact owner statement'};
 const capture=await sources.upsert('generated-source',input);
 const memory=memories.extract(fixtureMemoryResult(memories,{answer:JSON.stringify({memories:[{title:'Generated owner statement',statement:`Generated exact owner statement [${capture.id}]`,uncertainty:'Generated fixture only',evidenceIds:[capture.id]}]}),citations:[{id:capture.id,capturedAt:input.observedAt,appName:'generated',excerpt:input.text}],trace:[],runId:'generated-schema-memory'}),'fixture-model').items[0];
 const result={answer:'Generated persisted reply',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids:[]}};
 const conversation=conversations.append(undefined,{question:'Generated question'},result);
 store.saveInsight(result,'generated-schema-insight');
 store.stats(); // Include the existing lazy quota-ledger triggers for feature tables.
 const before=schema(store),savedMemory=memories.get(memory.id),savedConversation=conversations.get(conversation.conversationId),savedInsights=store.insights();
 for(let attempt=0;attempt<2;attempt++){installVaultSchema(store.db);assert.deepEqual(schema(store),before);}
 store.close();store=new Store(directory);
 const restartedSources=new SourceStore(store),restartedMemories=new MemoryStore(store),restartedConversations=new Conversations(store);
 store.stats();
 assert.deepEqual(schema(store),before);
 assert.equal(restartedSources.getItem('generated-source','generated-item')?.captureId,capture.id);
 assert.deepEqual(restartedMemories.get(memory.id),savedMemory);
 assert.deepEqual(restartedConversations.get(conversation.conversationId),savedConversation);
 assert.deepEqual(store.insights(),savedInsights);assert.equal(savedInsights.items.length,1);
 assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='backend_epoch'").get()?.value,'5');
 assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version,5);
 assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
