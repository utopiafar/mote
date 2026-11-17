import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {SourceStore} from '../src/sources.js';
import {sourceSchema} from '../src/source-schema.js';
import {fileSchema} from '../src/file-schema.js';
import {initializeSourceCatalog} from '../src/source-catalog.js';

test('source schema declares the capture prerequisite and rejects incorrect installation before writing',()=>{
 const db=new DatabaseSync(':memory:');try{
  assert.throws(()=>sourceSchema(db),/Capture schema must be installed/);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'source_%'").get()!.n,0);
 }finally{db.close();}
});

test('fresh and current Store initialization preserves source schema, triggers, identities and context versions on repetition',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-source-schema-owner-'));let store=new Store(directory);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const sources=new SourceStore(store);sources.register({id:'generated-source',name:'Generated',kind:'custom',deviceId:'generated',platform:'import'});
 const received=await sources.upsert('generated-source',{externalId:'generated-item',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',text:'Generated exact original'});
 const context=sources.updateContext('generated-source',{expectedVersion:0,description:'Generated owner declaration'});
 const schema=()=>store.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name GLOB 'source_*' OR name GLOB 'file_*' ORDER BY type,name").all();
 const before=schema(),rows=store.db.prepare('SELECT * FROM source_versions').all();
 for(let attempt=0;attempt<2;attempt++){sourceSchema(store.db);fileSchema(store.db);initializeSourceCatalog(store.db);assert.deepEqual(schema(),before);assert.deepEqual(store.db.prepare('SELECT * FROM source_versions').all(),rows);}
 store.close();store=new Store(directory);
 assert.deepEqual(schema(),before);assert.deepEqual(store.db.prepare('SELECT * FROM source_versions').all(),rows);
 const restarted=new SourceStore(store);assert.equal(restarted.getItem('generated-source','generated-item')?.captureId,received.id);assert.deepEqual(restarted.contexts.current('generated-source'),context);
 assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
