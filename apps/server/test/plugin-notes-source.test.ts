import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {noteCapture,noteSchema} from '@mote/shared';
import {PluginHost} from '@mote/plugin-host';
import type {ScopeIdentity} from '@mote/plugin-api/contracts';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {MaterialNoteDeletion} from '../src/material-note-deletion.js';
import {register as registerNotesFeature} from '../src/features/notes.js';
import {createNotesSource,createNotesSourceFactory,notesSourceContribution,notesSourceDeclaration} from '../src/plugins/notes-source.js';

async function fixture(t:any){
  const dataDir=mkdtempSync(join(tmpdir(),'mote-notes-source-'));
  const config:Config={dataDir,token:'generated-notes-source-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
  const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model in notes-source fixture');},close:async()=>{}}});
  const source=createNotesSource({
    page:args=>node.store.list({...args,source:'note'}),
    attribution:record=>node.materials.contextForEvidence(record),
    evidence:ids=>node.store.evidence(ids),
    deleteNote:id=>node.store.delete(id),
    noteDeletion:new MaterialNoteDeletion(node.store,node.materials),
  });
  await source.prepare();source.start();
  const app=Fastify();
  registerNotesFeature(app,{...node.featureServices,notesSource:source.assemblyForRoutes()} as any);
  await app.ready();
  t.after(async()=>{await app.close();await source.close();await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  return {node,source,app,assembly:source.assemblyForRoutes(),headers:{authorization:'Bearer '+config.token}};
}
const note=(changes:Record<string,unknown>={})=>({id:randomUUID(),deviceId:'generated-note-device',deviceName:'Generated device',platform:'android',capturedAt:'2026-11-02T10:00:00.000Z',text:'  Generated note body\nwith original spacing.  ',...changes});

test('real HTTP note list keeps cursor, attribution and note-only deletion over current production readers',async t=>{
  const f=await fixture(t),ids:string[]=[];
  for(let i=0;i<3;i++){const input=note({id:randomUUID(),capturedAt:`2026-11-02T10:0${i}:00.000Z`,text:`Generated note ${i}`});ids.push(input.id);const created=await f.app.inject({method:'POST',url:'/api/notes',headers:f.headers,payload:input});assert.equal(created.statusCode,201,created.body);}
  const first=note({text:'Generated duplicate'}),again=await f.app.inject({method:'POST',url:'/api/notes',headers:f.headers,payload:first});assert.equal(again.statusCode,201);
  assert.equal((await f.app.inject({method:'POST',url:'/api/notes',headers:f.headers,payload:{...first,text:'changed'}})).statusCode,409);
  const duplicate=await f.app.inject({method:'POST',url:'/api/notes',headers:f.headers,payload:first});assert.equal(duplicate.statusCode,200,duplicate.body);
  await f.node.materialOrganizer.tick(100);
  const read=new Set<string>();let cursor:string|null=null,pages=0;
  do{
    const response=await f.app.inject({url:'/api/notes?limit=2'+(cursor?'&cursor='+cursor:'')});
    assert.equal(response.statusCode,200,response.body);const page=response.json();pages++;
    for(const item of page.items){assert.ok(!read.has(item.id));read.add(item.id);assert.equal(item.source,'note');assert.equal(typeof item.attributionContext,'object');}
    cursor=page.nextCursor;
  }while(cursor);
  assert.equal(pages,2);assert.deepEqual(read,new Set([...ids,first.id]));
  const screen={...noteCapture(noteSchema.parse(note())),id:randomUUID(),source:'screen'};
  await f.node.store.ingest(screen);
  assert.equal((await f.app.inject({method:'DELETE',url:'/api/notes/'+screen.id})).statusCode,404);
  assert.ok(f.node.store.evidence([screen.id])[0]);
  const material=f.node.materials.list({kind:'mote.note'}).items.find(item=>item.origin.externalId===first.id);assert.ok(material);
  const anchor=f.node.materials.evidenceIds(material.ref,['record'])[0];assert.ok(anchor);
  assert.deepEqual(f.assembly.resolve(anchor),{virtual:true,captureId:first.id});
  assert.deepEqual(f.assembly.delete(anchor),{deleted:0},'notes deletion must not consume a Material alias');
  assert.ok(f.node.store.evidence([first.id])[0]);
  assert.deepEqual((await f.app.inject({method:'DELETE',url:'/api/notes/'+first.id})).json(),{deleted:1});
  assert.deepEqual((await f.app.inject({method:'DELETE',url:'/api/notes/'+first.id})).json(),{deleted:0});
});

test('notes-source quiesce keeps reads but refuses new delete, and the factory mounts with no published service',async t=>{
  const f=await fixture(t),created=await f.app.inject({method:'POST',url:'/api/notes',headers:f.headers,payload:note()});assert.equal(created.statusCode,201);
  await f.source.quiesce('upgrade');
  assert.equal((await f.app.inject({url:'/api/notes'})).statusCode,200);
  assert.equal((await f.app.inject({method:'DELETE',url:'/api/notes/'+created.json().id})).statusCode,503);
  assert.throws(()=>f.source.assemblyForRoutes(),{statusCode:503});
  assert.equal(notesSourceContribution.provides?.length,0);
  const host=new PluginHost({kind:'central',id:'generated-notes-host'}),identity:ScopeIdentity={packageId:'generated.notes',installationId:'generated-install',instanceId:'generated-notes',activationId:'generated-activation',host:{kind:'central',id:'generated-notes-host'}};
  t.after(()=>host.close());
  await host.install({identity,restartRequired:false,contributions:[notesSourceDeclaration],factory:createNotesSourceFactory({
    page:args=>f.node.store.list({...args,source:'note'}),attribution:record=>f.node.materials.contextForEvidence(record),
    evidence:ids=>f.node.store.evidence(ids),deleteNote:id=>f.node.store.delete(id),noteDeletion:new MaterialNoteDeletion(f.node.store,f.node.materials),
  })});
  assert.equal(host.snapshot().contributions.find(item=>item.identity.contributionId==='notes-source')?.availability.state,'active');
});
