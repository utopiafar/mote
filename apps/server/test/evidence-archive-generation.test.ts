import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';

test('a changed group cannot publish an exact segment from its earlier member snapshot',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-archive-generation-')),store=new Store(directory),id=randomUUID();
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  await store.ingest({id,deviceId:'generated-device',deviceName:'Generated device',platform:'macos',
    capturedAt:'2026-09-24T01:00:00.000Z',durationMs:5000,appId:'generated.app',appName:'Generated app',
    windowTitle:'Generated old group',ocrText:'GENERATED_PRIVATE_ANCHOR',source:'screen',
    privacy:{excluded:false,redacted:false,mode:'none'}});
  const previous=store.evidence.bind(store);let changed=false;
  store.evidence=ids=>{
    const records=previous(ids);
    if(!changed){
      changed=true;
      const row=store.db.prepare('SELECT json FROM captures WHERE id=?').get(id) as {json:string};
      store.db.prepare('UPDATE captures SET json=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.json),windowTitle:'Generated corrected group'}),id);
    }
    return records;
  };
  store.archive.aggregate(1);
  store.evidence=previous;
  assert.equal(changed,true);
  assert.equal(store.archive.page({query:'GENERATED_PRIVATE_ANCHOR'}).items.length,0,'stale subset must not become searchable');
  assert.equal(Number((store.db.prepare('SELECT COUNT(*) AS n FROM context_dirty').get() as {n:number}).n),2,'both changed groups remain queued');
  store.archive.aggregate(10);
  const page=store.archive.page({query:'GENERATED_PRIVATE_ANCHOR'});
  assert.equal(page.items.length,1);
  const current=page.items[0];assert.ok(current);
  assert.equal(current.members[0],id);
});
