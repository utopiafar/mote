import {testScope} from './fixtures/plugin-scope.js';
import {rejectSqliteWrites} from './fixtures/sqlite-writer.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {ArchivedFileStore} from '../src/archived-files.js';
import {captureSchema} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {IngressService} from '../src/ingress.js';
import {RecordContextStore} from '../src/record-context.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {ProcessingRuntime} from '../src/processing-runtime.js';
import {memoryEvidenceFingerprint} from '../src/memory.js';
import {ContentStorageService} from '../src/content-storage.js';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';

const at='2026-10-01T00:00:00Z',description='  Generated description: this note concerns one record only.\nExact owner wording.  ';
const capture=(ownerDescription:string|undefined=description)=>captureSchema.parse({id:randomUUID(),deviceId:'generated-phone',deviceName:'Generated phone',platform:'android',source:'note',durationMs:0,capturedAt:at,ocrText:'Generated original note',metadata:{version:1,observedAt:at,...(ownerDescription===undefined?{}:{ownerDescription})}});
function fixture(t:TestContext,options:{encrypted?:boolean}={}){
  const directory=mkdtempSync(join(tmpdir(),'mote-record-context-'));let store=new Store(directory,{dataKey:'ab'.repeat(32),contentEncryptionEnabled:options.encrypted,});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const sources=new SourceStore(store),files=new FileStore(store,sources),materials=new MaterialStore(store),contexts=new RecordContextStore(store),ingress=new IngressService(store,sources,files);
  return {directory,store,sources,files,materials,contexts,ingress,reopen(encrypted=options.encrypted){store.close();store=new Store(directory,{dataKey:'ab'.repeat(32),contentEncryptionEnabled:encrypted});return store;}};
}
function draft(ids:string[]):MaterialDraft {
  const sourceId='generated-authored-material',externalId='generated-note';
  return {id:materialId(sourceId,externalId),origin:{sourceId,externalId},title:'Generated notes',kind:'mote.note',schemaVersion:1,
    members:ids.map(id=>({id,kind:'capture',ref:'capture:'+id})),blocks:ids.map((id,index)=>({id:'body-'+index,kind:'text',format:'plain',text:'Generated original note',memberIds:[id],evidenceContext:{observedAt:at,document:{}}})),
    artifacts:[],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
}
const reseal=(archive:{materials?:unknown})=>{const section=archive.materials as Record<string,unknown>,{checksum:_,...body}=section;const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;section.checksum=sha256(JSON.stringify(canonical(body)));};

test('a private record description survives restart and identical receipt retry without entering original or search',async t=>{
  const f=fixture(t),input=capture();assert.equal((await f.ingress.capture(input)).duplicate,false);
  const raw=f.store.evidence([input.id])[0];assert.equal(raw.ocrText,input.ocrText);assert.equal(raw.metadata?.ownerDescription,undefined);
  assert.ok(!String(f.store.db.prepare('SELECT json FROM captures WHERE id=?').get(input.id)!.json).includes(description));
  assert.ok(!String(f.store.db.prepare('SELECT text FROM captures_fts WHERE id=?').get(input.id)!.text).includes(description));
  assert.ok(!String(f.store.db.prepare('SELECT json FROM devices WHERE id=?').get(input.deviceId)!.json).includes(description));
  const context=f.materials.contextForEvidence(raw);assert.equal(context.ownerRelation,'unknown');assert.equal(context.basis,'default');assert.equal(context.recordContextStatements?.[0].description,description);
  assert.notEqual(memoryEvidenceFingerprint(raw),memoryEvidenceFingerprint({...raw,attributionContext:context}));
  const restarted=f.reopen(),sources=new SourceStore(restarted),ingress=new IngressService(restarted,sources,new FileStore(restarted,sources));
  assert.equal((await ingress.capture(input)).duplicate,true);
  assert.equal(new MaterialStore(restarted).contextForEvidence(restarted.evidence([input.id])[0]).recordContextStatements?.[0].description,description);
  for(const ownerDescription of ['',undefined,'Generated changed context'])await assert.rejects(ingress.capture({...input,metadata:{...input.metadata!,ownerDescription}}),{statusCode:409});
  assert.equal(new RecordContextStore(restarted).export().declarations.length,1);
});

test('absence and empty are the same declaration; later addition and direct evidence metadata cannot change it',async t=>{
  const f=fixture(t),input=capture('');await f.ingress.capture(input);
  assert.equal((await f.ingress.capture({...input,metadata:{...input.metadata!,ownerDescription:undefined}})).duplicate,true);
  await assert.rejects(f.ingress.capture({...input,metadata:{...input.metadata!,ownerDescription:description}}),{statusCode:409});
  await assert.rejects(f.store.ingest(capture()),/private ingress/);assert.equal(f.contexts.export().declarations.length,0);
});

test('authorization failure, SQLite writes and batch conflicts roll back each original with its declaration',async t=>{
  const f=fixture(t),first=capture(),second=capture('Generated second context');
  await assert.rejects(f.ingress.capture(first,()=>{throw Error('Generated revocation');}),/revocation/);
  assert.equal(f.store.evidence([first.id]).length,0);assert.equal(f.contexts.export().declarations.length,0);
  await f.ingress.capture(first);
  const results=await f.ingress.captureSettled([{...first,metadata:{...first.metadata!,ownerDescription:'Changed'}},second]);
  assert.ok(results[0].error);assert.equal(results[1].result?.duplicate,false);assert.equal(f.contexts.export().declarations.length,2);
  assert.equal(f.materials.contextForEvidence(f.store.evidence([first.id])[0]).recordContextStatements?.[0].description,description);
  const quota=fixture(t,{}),large=capture('x'.repeat(12000)),recover=rejectSqliteWrites(quota.store,'record_context_declarations');await assert.rejects(quota.ingress.capture(large),/Generated SQLite write failure/);
  assert.equal(quota.store.evidence([large.id]).length,0);assert.equal(quota.contexts.export().declarations.length,0);recover();
});

test('only exact original lineage inherits descriptions and material spans never borrow another member context',async t=>{
  const f=fixture(t),first=capture(),other=capture('Generated unrelated context'),derived=capture('');
  await f.ingress.capture(first);await f.ingress.capture(other);await f.ingress.capture(derived);
  f.store.db.prepare('INSERT INTO file_evidence_links VALUES(?,?)').run(first.id,derived.id);
  assert.deepEqual(f.materials.contextForEvidence(f.store.evidence([derived.id])[0]).recordContextStatements,[{captureId:first.id,version:1,description}]);
  const material=f.materials.publish(draft([first.id,other.id]));
  assert.equal(material.attributionContext?.recordContextStatements?.length,2);
  const spans=f.materials.read(material.ref).spans;assert.deepEqual(spans[0].attributionContext.recordContextDeclarations?.map(p=>p.captureId),[first.id]);assert.deepEqual(spans[1].attributionContext.recordContextDeclarations?.map(p=>p.captureId),[other.id]);
  assert.equal(f.materials.list().items[0].attributionContext?.recordContextStatements,undefined);
  const stored=String(f.store.db.prepare('SELECT manifest FROM material_revisions WHERE material_id=?').get(material.id)!.manifest);assert.ok(!stored.includes(description));
  const pin=f.contexts.identities([first.id])[0];assert.deepEqual(f.contexts.open([{...pin,captureId:other.id}]),[]);assert.deepEqual(f.contexts.open([{...pin,fingerprint:'0'.repeat(64)}]),[]);
  f.store.delete(first.id);assert.deepEqual(f.contexts.open([pin]),[]);assert.deepEqual(f.contexts.identities([derived.id]),[]);assert.equal(f.store.evidence([derived.id]).length,0,'deletion removes derived evidence rather than leaving a readable orphan');
});

test('a semantic processor receives separate scoped description, and deletion fences a late result',async t=>{
  const f=fixture(t),input=capture();await f.ingress.capture(input);let calls=0;
  const runtime=new ProcessingRuntime(f.store,[],{},Date.now,undefined,f.materials,testScope(t));t.after(()=>runtime.close());
  runtime.registry.register({id:'fixture.record-context',version:'1',lane:'semantic',async process(value){
    calls++;assert.equal(value.observations[0].ocrText,input.ocrText);assert.equal(value.observations[0].attributionContext?.recordContextStatements?.[0].description,description);
    f.store.delete(input.id);return [{kind:'generated',text:'Generated late interpretation',metadata:{}}];
  }});
  const id=runtime.enqueue([{name:'description',processor:'fixture.record-context',inputs:[input.id]}]).description;await runtime.tick();
  assert.equal(calls,1);assert.notEqual(runtime.view().jobs.find(job=>job.id===id)?.state,'succeeded');assert.deepEqual(runtime.view().jobs.find(job=>job.id===id)?.outputs,[]);
  assert.equal(f.contexts.export().declarations.length,0);
});

test('portable backup and encryption retain exact record context and reject missing, tampered or unrelated scope',async t=>{
  const f=fixture(t,{encrypted:true}),input=capture(),other=capture('');await f.ingress.capture(input);await f.ingress.capture(other);
  const material=f.materials.publish(draft([input.id]));const row=f.store.db.prepare('SELECT json FROM record_context_declarations WHERE capture_id=?').get(input.id)!;assert.match(String(row.json),/^aes:/);
  assert.ok(!String(row.json).includes(description));const archive=f.store.exportArchive(2_000_000);assert.equal(archive.materials?.recordContext?.declarations[0].description,description);
  const target=fixture(t,{encrypted:true});await target.store.importArchive(archive);
  assert.equal(target.materials.get(material.id)?.attributionContext?.recordContextStatements?.[0].description,description);
  await target.store.importArchive(archive);assert.equal(target.contexts.export().declarations.length,1);
  for(const mutation of ['missing','fingerprint','scope','pin'] as const){
    const altered=structuredClone(archive);
    if(mutation==='missing')delete altered.materials!.recordContext;
    else if(mutation==='fingerprint')altered.materials!.recordContext!.declarations[0].description='Tampered context';
    else if(mutation==='scope')altered.materials!.recordContext!.declarations[0].captureId=other.id;
    else{const r=altered.materials!.revisions[0],manifest=JSON.parse(String(r.manifest));delete manifest.attributionContext.recordContextDeclarations;r.manifest=JSON.stringify(manifest);}
    reseal(altered);const empty=fixture(t);await assert.rejects(empty.store.importArchive(altered));assert.equal(empty.store.stats().captures,0);
  }
  const reopened=f.reopen(true);assert.equal(new RecordContextStore(reopened).export().declarations[0].description,description);
  reopened.contentEncryption.setEnabled(false);const storage=new ContentStorageService(reopened,new FileStore(reopened,new SourceStore(reopened)),new ArchivedFileStore(reopened));storage.start();for(let i=0;i<1000&&storage.snapshot().job.state==='running';i++)await setImmediate();assert.equal(storage.snapshot().job.failed,0);await storage.close();assert.match(String(reopened.db.prepare('SELECT json FROM record_context_declarations WHERE capture_id=?').get(input.id)!.json),/^json:/);
});

test('HTTP owner note reads private context while collector description attempts preserve ordinary capture capability',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-record-context-http-')),token='generated-owner-record-context-token',headers={authorization:`Bearer ${token}`};
  const config:ConfigurationPlatformOptions={path:(directory)+'/mote.yaml',privateCredential:{token:token,tokenPath:'fixture'},initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}}}};
  const node=await buildApp(config,{backgroundWorker:false});t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const input=capture(),{source:_,ocrText,privacy:__,durationMs:___,...identity}=input;
  const note={id:identity.id,deviceId:identity.deviceId,deviceName:identity.deviceName,platform:identity.platform,capturedAt:identity.capturedAt,text:ocrText,metadata:identity.metadata};
  const sent=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:note});assert.equal(sent.statusCode,201,sent.body);
  assert.equal((await node.app.inject({method:'POST',url:'/api/notes',headers,payload:note})).statusCode,200);
  const read=await node.app.inject({url:'/api/notes',headers});assert.equal(read.statusCode,200);assert.equal(read.json().items[0].attributionContext.recordContextStatements[0].description,description);
  const detail=await node.app.inject({url:'/api/capture-browser/'+input.id,headers});assert.equal(detail.statusCode,200);assert.equal(detail.json().attributionContext.recordContextStatements[0].description,description);
  const invitation=node.connections.invite({serverUrl:'https://generated.invalid',label:'Generated collector'},'collector');
  const paired=await node.connections.redeem({code:invitation.invitation.code,deviceId:'generated-collector',deviceName:'Generated collector',platform:'android'}),collectorHeaders={authorization:`Bearer ${paired.token}`,'x-mote-ingress-version':'2'};
  const external={...capture(),deviceId:'generated-collector'};
  for(const route of ['/api/captures','/api/captures/batch']){
    const response=await node.app.inject({method:'POST',url:route,headers:collectorHeaders,payload:route.endsWith('batch')?{captures:[external]}:external});assert.equal(response.statusCode,403,response.body);
  }
  assert.equal(node.store.evidence([external.id]).length,0);
  const plain={...external,metadata:{version:1,observedAt:at}};assert.equal((await node.app.inject({method:'POST',url:'/api/captures',headers:collectorHeaders,payload:plain})).statusCode,201);
  const forged={...capture(),attributionContext:{version:1,basis:'default',ownerRelation:'unknown',recordContextStatements:[{captureId:input.id,version:1,description}]}};
  assert.equal((await node.app.inject({method:'POST',url:'/api/captures',headers,payload:forged})).statusCode,400);
});
