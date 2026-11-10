import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {MaterialStore} from '../src/materials.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';

test('an earlier media ID stays readable after 2001 newer same-label samples from another content identity',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-media-material-scale-')),store=new Store(directory),materials=new MaterialStore(store),organizers=new MaterialOrganizerRuntime(store,materials);
  t.after(async()=>{await organizers.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const record=(second:number,mediaId:string)=>{const at=new Date(Date.parse('2026-10-10T00:00:00Z')+second*1000).toISOString();return {id:randomUUID(),deviceId:'generated-phone',deviceName:'Generated phone',platform:'android',source:'media',capturedAt:at,durationMs:1000,appId:'generated.player',appName:'Generated player',ocrText:'',privacy:{collection:'content'},metadata:{version:1,observedAt:at,media:{status:'available',sessions:[{appId:'generated.player',appName:'Generated player',sessionId:'generated-persistent-session',mediaId,title:'Generated identical display label',artist:'Generated narrator',album:'Generated album',playbackState:'playing',appVisibility:'background',playbackType:'local',positionMs:second*1000}]}}};};
  const original=record(1,'generated-content-A');await store.ingest(original);await organizers.tick(500);
  const initial=materials.list({kind:'mote.state-series'}).items[0]!;assert.ok(initial);
  const later=Array.from({length:2001},(_,index)=>record(index+2,'generated-content-B'));
  for(let offset=0;offset<later.length;offset+=500)await store.ingestBatch(later.slice(offset,offset+500));
  while(await organizers.tick(500));
  store.db.prepare("INSERT INTO changes(id,operation,changed_at) VALUES(?,'upsert',?)").run(original.id,new Date().toISOString());await organizers.tick(500);
  const retained=materials.get(initial.id);assert.ok(retained,'unrelated newer records cannot empty an earlier exact media group');assert.equal(retained.memberCount,1);assert.equal(retained.coverage.state,'complete');assert.match(materials.read(retained.ref).text,/generated-content-A/);
  const other=materials.list({kind:'mote.state-series',limit:100}).items.find(material=>material.id!==initial.id)!;assert.ok(other,'explicit mediaId separates identical display labels in one persistent session');assert.equal(other.memberCount,2001);assert.equal(other.coverage.state,'complete');
  const summary=JSON.parse(materials.block(other.ref,0)!.block.text);assert.equal(summary.measuredPlaybackMs,2001000);assert.equal(summary.intervals.length,1);assert.equal(store.list({source:'media',limit:100}).totalCount,2002);
});
