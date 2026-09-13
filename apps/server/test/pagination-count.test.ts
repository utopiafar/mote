import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';

const base={deviceId:'generated-scope',deviceName:'Synthetic count fixture',platform:'import',appId:'dev.mote.notes',appName:'随手记',durationMs:0,source:'note',ocrText:'Generated evidence only.',privacy:{excluded:false,redacted:false,mode:'none'}};
function vault(t:{after(fn:()=>void):void}) {const directory=mkdtempSync(join(tmpdir(),'mote-count-'));const store=new Store(directory);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return store;}

test('totalCount retains the complete time/device/source scope after all cursor pages',async t=>{
  const store=vault(t);const beginning=Date.parse('2026-09-10T00:00:00Z');
  for(let index=0;index<121;index++)await store.ingest({...base,id:randomUUID(),capturedAt:new Date(beginning+index*60000).toISOString()});
  for(const override of [{deviceId:'another-device'}, {source:'file'}, {capturedAt:'2026-09-09T23:59:59Z'}, {capturedAt:'2026-09-11T00:00:00Z'}]) {
    await store.ingest({...base,id:randomUUID(),capturedAt:'2026-09-10T01:00:00Z',...override});
  }
  const scope={deviceId:base.deviceId,source:'note' as const,after:'2026-09-10T00:00:00Z',before:'2026-09-11T00:00:00Z',limit:100};
  const first=store.list(scope);assert.equal(first.items.length,100);assert.equal(first.totalCount,121);assert.ok(first.nextCursor);
  const second=store.list({...scope,cursor:first.nextCursor});assert.equal(second.items.length,21);assert.equal(second.totalCount,121);assert.equal(second.nextCursor,null);
  assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,121);
  const last=second.items.at(-1)!;
  const empty=store.list({...scope,cursor:Buffer.from(JSON.stringify({t:last.capturedAt,id:last.id})).toString('base64url')});
  assert.equal(empty.items.length,0);assert.equal(empty.totalCount,121);
  assert.equal(store.list({...scope,deviceId:'missing'}).totalCount,0);
});
test('source intervals expose overlap inputs while aggregate time excludes overlap and note self-report',async t=>{
  const store=vault(t);
  for(const [at,durationMs] of [['00:00:20',20000],['00:00:30',20000],['00:10:00',10000]] as const) {
    await store.ingest({...base,id:randomUUID(),source:'screen',appName:'Synthetic reader',capturedAt:`2026-09-11T${at}Z`,durationMs});
  }
  await store.ingest({...base,id:randomUUID(),capturedAt:'2026-09-11T00:15:00Z',ocrText:'Synthetic self-report: I read for two hours; not measured.'});
  await store.ingest({...base,id:randomUUID(),source:'screen',deviceId:'unselected',capturedAt:'2026-09-11T00:20:00Z',durationMs:60000});
  const scope={deviceId:base.deviceId,after:'2026-09-11T00:00:00Z',before:'2026-09-12T00:00:00Z'};
  const page=store.list(scope);assert.equal(page.totalCount,4);
  assert.deepEqual(page.items.filter(record=>record.source==='screen').map(record=>[record.capturedAt,record.durationMs]),[['2026-09-11T00:10:00.000Z',10000],['2026-09-11T00:00:30.000Z',20000],['2026-09-11T00:00:20.000Z',20000]]);
  assert.equal(store.activity(scope).totalDurationMs,40000);assert.equal(store.activity(scope).captures,3);
});
