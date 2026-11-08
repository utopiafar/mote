import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {MaterialStore} from '../src/materials.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';

test('native notifications publish title and every body field to formal Material and automatic exact segments without rewriting the transport original',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-notification-material-')),store=new Store(directory),materials=new MaterialStore(store),organizers=new MaterialOrganizerRuntime(store,materials);
 t.after(async()=>{await organizers.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const id=randomUUID(),notification={action:'posted' as const,notificationKey:'32'.repeat(32),postedAt:'2026-10-01T00:00:00Z',ongoing:false,groupSummary:false,title:'Generated appointment notice',text:'Generated meeting starts at 09:30',bigText:'Generated full details include the revised meeting location',subText:'Generated organizer',textLines:['Generated line one','Generated line two']};
 await store.ingest({id,deviceId:'generated',deviceName:'Generated Android',platform:'android',capturedAt:'2026-10-01T00:00:01Z',durationMs:0,source:'notification',appId:'generated.notifications',appName:'Generated calendar',windowTitle:'',ocrText:'',metadata:{version:1,observedAt:'2026-10-01T00:00:01Z',collector:{method:'notification_listener'},observation:{sessionId:randomUUID(),elapsedRealtimeMs:1000},notification},privacy:{excluded:false,redacted:false,mode:'none'}});
 const raw=JSON.parse(String(store.db.prepare('SELECT json FROM captures WHERE id=?').get(id)!.json));assert.equal(raw.ocrText,'');assert.deepEqual(raw.metadata.notification,notification);
 const evidence=store.evidence([id])[0];assert.deepEqual(JSON.parse(evidence.ocrText).notification,notification);
 store.archive.aggregate(20);const preview=store.archive.page({query:'revised meeting location'}).items[0]!,segment=store.archive.page({id:preview.id}).items[0]!;assert.equal(segment.kind,'segment');assert.deepEqual(segment.members,[id]);assert.match(segment.text,/Generated appointment notice/);assert.match(segment.text,/Generated line two/);
 const quote='Generated meeting starts at 09:30',offset=evidence.ocrText.indexOf(quote);assert.equal(store.evidence([id])[0].ocrText.slice(offset,offset+quote.length),quote,'semantic quotes share the exact evidence projection');
 while(await organizers.tick(100));const material=materials.list({kind:'mote.notification'}).items[0]!;assert.equal(material.title,notification.title);assert.match(materials.read(material.ref).text,/revised meeting location/);assert.match(materials.read(material.ref).text,/Generated line two/);
});
