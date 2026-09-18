import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {ContextQuery} from '../src/context-query.js';

const captured=(minutes:number)=>new Date(Date.parse('2026-09-18T00:00:00.000Z')+minutes*60000).toISOString();
async function fixture(t:any){
  const directory=await mkdtemp(join(tmpdir(),'mote-context-query-')),store=new Store(join(directory,'vault')),sources=new SourceStore(store);
  sources.register({id:'coding',name:'Generated coding source',kind:'coding-agent',deviceId:'fixture-device',platform:'import'});
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  return {store,sources,query:new ContextQuery(store,sources)};
}
async function coding(store:Store,minutes:number,projectKey:string,sessionId:string,text:string,provider:'codex'|'claude'='codex'){
  const id=randomUUID();await store.ingest({id,deviceId:sessionId==='s-a'?'device-a':'device-b',deviceName:'Generated device',platform:'import',capturedAt:captured(minutes),durationMs:0,appId:'generated.agent',appName:'Generated Agent',windowTitle:'Generated coding turn',ocrText:text,source:'message',provenance:{sourceId:'coding',externalId:id,revision:'1',layer:'snapshot',document:{contentRole:'transcript',coding:{version:1,provider,sessionId,projectKey,eventId:id,role:'user',part:0,parts:1}}},privacy:{excluded:false,redacted:false,mode:'none'}});return id;
}

test('unified context query keeps candidate projects explainable and reads exact hit ranges',async t=>{
  const {store,sources,query}=await fixture(t);
  const first=await coding(store,1,'github:utopiafar/mote','s-a','ANCHOR_REFACTOR: use the batch read path; the rollback test passed.');
  const second=await coding(store,2,'github:utopiafar/mote','s-b','ANCHOR_REFACTOR follow-up: the same repository continues on another device; the old single-row path is superseded.','claude');
  await coding(store,3,'github:other/mote','s-c','ANCHOR_REFACTOR appears in a different repository and must remain separate.');

  const searched=query.search({query:'ANCHOR_REFACTOR',projectKey:'github:utopiafar/mote',limit:1});
  assert.equal(searched.items.length,1);assert.equal(searched.items[0].id,second);assert.equal(searched.items[0].origin.projectKey,'github:utopiafar/mote');assert.ok(searched.items[0].locator);assert.ok(searched.nextCursor,'search cursor must be resumable');
  const next=query.search({query:'ANCHOR_REFACTOR',projectKey:'github:utopiafar/mote',limit:1,cursor:searched.nextCursor!});
  assert.equal(next.items.length,1);assert.equal(next.items[0].id,first);

  const browse=query.browse({query:'mote',limit:10});
  assert.equal(browse.items.length,2,'same projectKey is one query view; a different repository is separate');
  assert.ok(browse.items.every(item=>item.snippet.includes('not a canonical project identity')),JSON.stringify(browse.items));
  const read=query.read([`capture:${first}`],searched.items[0].locator!.offset,12);
  assert.equal(read.items[0].text,'ANCHOR_REFAC');assert.equal(read.missingRefs.length,0);

  const context=query.context({query:'ANCHOR_REFACTOR',projectKey:'github:utopiafar/mote',maxCharacters:5000,includeMemories:false});
  assert.equal(context.recentRecords.length,2);assert.ok(JSON.stringify(context).length<=5000);assert.ok(context.coverage.originalLatestAt);
  const status=query.status();assert.equal(status.archive.captures,3);assert.equal(status.sources.length,1);
});

test('literal search remains bounded on generated archive data',async t=>{
  const {store,sources,query}=await fixture(t);
  for(let i=0;i<120;i++)await coding(store,i%60,'github:utopiafar/mote',`s-${i%3}`,`generated filler ${i} ${i===119?'EFFICIENCY_ANCHOR':''}`);
  const started=performance.now();const result=query.search({query:'EFFICIENCY_ANCHOR',limit:5});const durationMs=performance.now()-started;
  assert.equal(result.items.length,1);assert.match(result.items[0].snippet,/EFFICIENCY_ANCHOR/);assert.ok(result.items[0].locator);assert.ok(durationMs<1000,`fixture lexical search was too slow: ${durationMs}ms`);assert.equal(sources.listSources().length,1);
});
