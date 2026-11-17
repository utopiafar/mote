import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {EvidenceStore as Store} from '../src/evidence-store.js';

const at=(second:number)=>new Date(Date.UTC(2026,8,12,1,0,second)).toISOString();
function fixture(t:TestContext){const directory=mkdtempSync(join(tmpdir(),'mote-generated-measurement-lineage-')),store=new Store(directory);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return store;}
const screen=(overrides:Record<string,unknown>={})=>({id:randomUUID(),deviceId:'generated-device',deviceName:'Generated device',platform:'android',capturedAt:at(20),durationMs:20000,source:'screen',appId:'generated.other',appName:'Generated app',ocrText:'Generated original body stays private.',windowTitle:'',privacy:{collection:'content'},...overrides});
const session={sessionId:'generated-session',appId:'generated.player',appName:'Generated player',playbackState:'playing',appVisibility:'background',playbackType:'local'};
const media=(second:number,overrides:Record<string,unknown>={})=>({id:randomUUID(),deviceId:'generated-device',deviceName:'Generated device',platform:'android',capturedAt:at(second),durationMs:1000,source:'media',appId:session.appId,appName:session.appName,ocrText:'',windowTitle:'',privacy:{collection:'activity'},metadata:{version:1,observedAt:at(second),media:{status:'available',sessions:[session]}},...overrides});

test('activity contributor receipts include app-filtered predecessors used to clip overlap without altering totals',async t=>{
 const store=fixture(t),predecessor=screen(),selected=screen({capturedAt:at(25),appId:'generated.selected'}),ignored=screen({capturedAt:at(26),durationMs:0}),otherDevice=screen({deviceId:'unselected-device',capturedAt:at(30),appId:'generated.selected'});
 for(const record of [predecessor,selected,ignored,otherDevice])await store.ingest(record);
 const scope={deviceId:'generated-device',appId:'generated.selected',after:at(12),before:at(30)},ids=new Set<string>(),result=store.activity(scope,id=>ids.add(id));
 assert.deepEqual(result,store.activity(scope));assert.equal(result.totalDurationMs,5000);assert.equal(result.captures,1);assert.deepEqual(ids,new Set([predecessor.id,selected.id]));
 const empty=new Set<string>();assert.equal(store.activity({deviceId:'absent-device'},id=>empty.add(id)).captures,0);assert.equal(empty.size,0);
 store.delete(predecessor.id);const afterDelete=new Set<string>(),changed=store.activity(scope,id=>afterDelete.add(id));assert.equal(changed.totalDurationMs,13000);assert.deepEqual(afterDelete,new Set([selected.id]));
});

test('media contributor receipts cover all counted samples beyond public navigation IDs and exclude other devices',async t=>{
 const store=fixture(t),values=Array.from({length:101},(_,index)=>media(index+1));for(const record of values)await store.ingest(record);
 const unavailable=media(102,{durationMs:0,appId:'',appName:'',metadata:{version:1,observedAt:at(102),media:{status:'unavailable',sessions:[]}}}),otherDevice=media(103,{deviceId:'unselected-device'});
 await store.ingest(unavailable);await store.ingest(otherDevice);
 const scope={deviceId:'generated-device'},ids=new Set<string>(),result=store.mediaActivity(scope,id=>ids.add(id));
 assert.deepEqual(result,store.mediaActivity(scope));assert.equal(result.observations,102);assert.equal(result.totalDurationMs,101000);assert.equal(result.evidenceIds.length,100);assert.equal(result.evidenceTruncated,true);assert.equal(result.availability.unavailable,1);
 assert.deepEqual(ids,new Set([...values.map(record=>record.id),unavailable.id]));assert.equal(ids.has(otherDevice.id),false);
 const selected=new Set<string>();assert.equal(store.mediaActivity({...scope,appId:'generated.player'},id=>selected.add(id)).observations,101);assert.deepEqual(selected,new Set(values.map(record=>record.id)));
});

test('media receipts retain the actual original beyond the upper boundary when its playing interval overlaps the scope',async t=>{
 const store=fixture(t),record=media(20,{durationMs:20000});await store.ingest(record);
 const ids=new Set<string>(),result=store.mediaActivity({deviceId:'generated-device',after:at(12),before:at(18)},id=>ids.add(id));
 assert.equal(result.totalDurationMs,6000);assert.equal(result.observations,1);assert.deepEqual(ids,new Set([record.id]));
 const empty=new Set<string>();assert.equal(store.mediaActivity({deviceId:'generated-device',before:at(0)},id=>empty.add(id)).observations,0);assert.equal(empty.size,0);
});
