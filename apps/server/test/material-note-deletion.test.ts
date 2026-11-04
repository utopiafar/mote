import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {materialId,type MaterialDraft,type MaterialRecord} from '../src/materials.js';
import {MaterialNoteDeletion} from '../src/material-note-deletion.js';
import {captureLibraryVersion,materialEvidenceLibraryVersion} from '../src/capture-library-version.js';
import {EvidenceDeletion} from '../src/evidence-deletion.js';

async function fixture(t:TestContext){
 const dataDir=mkdtempSync(join(tmpdir(),'mote-note-delete-identity-')),token='generated-note-delete-identity-token';let modelCalls=0;
 const node=await buildApp({dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false,agent:{configured:false,query:async()=>{modelCalls++;throw Error('No model in deletion fixture');},close:async()=>{}}});
 t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});assert.equal(modelCalls,0);});
 const headers={authorization:'Bearer '+token},get=(url:string)=>node.app.inject({url,headers}),remove=(id:string)=>node.app.inject({method:'DELETE',url:'/api/captures/'+id,headers});
 async function note(metadata?:unknown){
  const id=randomUUID(),text='  Exact generated note '+id+'\nLiteral original bytes.  ';
  const response=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,text,deviceId:'generated-device',deviceName:'Generated',platform:'macos',capturedAt:'2026-10-29T01:00:00Z',...(metadata?{metadata}:{})}});assert.equal(response.statusCode,201,response.body);
  await node.materialOrganizer.tick(100);
  const material=node.materials.list({kind:'mote.note'}).items.find(item=>item.origin.externalId===id)!;assert.ok(material);
  const anchor=node.materials.evidenceIds(material.ref,['record'])[0];assert.ok(anchor);assert.notEqual(anchor,id);
  return {id,text,material,anchor};
 }
 // Re-publish valid host-domain Material drafts, retaining exact stored blocks.
 function draft(material:MaterialRecord):MaterialDraft{
  const db=node.store.db,manifest=JSON.parse(String(db.prepare('SELECT manifest FROM material_revisions WHERE material_id=? AND revision=?').get(material.id,material.revision)!.manifest));
  const members=node.materials.members(material.ref,{limit:200}).items;
  const blocks=db.prepare('SELECT b.*,p.text,c.json context FROM material_blocks b JOIN material_block_payloads p ON p.hash=b.payload_hash LEFT JOIN material_evidence_context c ON c.anchor_id=b.anchor_id WHERE b.material_id=? AND b.revision=? ORDER BY b.idx').all(material.id,material.revision).map(b=>({id:String(b.block_id),kind:'text' as const,format:String(b.format),text:String(b.text),memberIds:JSON.parse(String(b.member_ids)),...(b.locator?{locator:JSON.parse(String(b.locator))}:{}),...(b.context?{evidenceContext:JSON.parse(String(b.context))}:{})}));
  return {...manifest,members,blocks};
 }
 return {...node,get,remove,note,draft,headers};
}

test('deleting the current complete note body anchor deletes that same original and preserves the recorded conversation',async t=>{
 const f=await fixture(t),n=await f.note(),other=await f.note();
 const read=await f.get('/api/capture-browser/'+n.anchor);assert.equal(read.statusCode,200);assert.equal(read.json().ocrText,n.text);assert.deepEqual(read.json().deletion,{available:true,kind:'capture'});assert.equal(JSON.stringify(read.json().deletion).includes(n.id),false);
 const conversation=f.conversations.append(undefined,{question:'Generated original question'},{answer:'Generated preserved answer',citations:[{id:n.anchor,capturedAt:'2026-10-29T01:00:00Z',appName:'Generated',excerpt:n.text}],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[n.id,n.anchor]}});
 assert.equal((await f.app.inject({method:'DELETE',url:'/api/captures/'+n.anchor})).statusCode,401);
 const removed=await f.remove(n.anchor);assert.equal(removed.statusCode,200,removed.body);assert.deepEqual(removed.json(),{deleted:1});
 for(const id of [n.id,n.anchor])assert.equal((await f.get('/api/capture-browser/'+id)).statusCode,404);
 assert.equal((await f.get('/api/materials/'+n.material.id)).statusCode,404);assert.equal((await f.get('/api/capture-browser/'+other.id)).statusCode,200);
 const turn=f.conversations.get(conversation.conversationId).turns[0];assert.equal(turn.question,'Generated original question');assert.equal(turn.result!.answer,'Generated preserved answer');assert.equal(turn.evidenceDeleted,undefined);assert.equal(turn.evidenceUnavailable,true);
 assert.deepEqual((await f.remove(n.id)).json(),{deleted:0});assert.deepEqual((await f.remove(randomUUID())).json(),{deleted:0});
});

test('current block identity is checked after a revision and context changes cannot authorize an old anchor',async t=>{
 const f=await fixture(t),n=await f.note(),draft=f.draft(n.material);
 const settled=f.materials.publish(draft,{expectedRevision:n.material.revision}),stableAnchor=f.materials.evidenceIds(settled.ref,['record'])[0];
 const next=f.materials.publish({...draft,coverage:{state:'partial',reason:'generated_readiness_change'}},{expectedRevision:settled.revision});assert.notEqual(next.revision,settled.revision);assert.ok(f.materials.evidenceIds(next.ref).includes(stableAnchor),'unchanged body retains its actual anchor');
 assert.notEqual(String(f.store.db.prepare('SELECT revision FROM material_evidence WHERE id=?').get(stableAnchor)!.revision),next.revision);
 assert.deepEqual((await f.get('/api/capture-browser/'+stableAnchor)).json().deletion,{available:true,kind:'capture'});
 const corrected=f.materials.correctContext(next.id,next.revision,'third_party'),fresh=f.materials.evidenceIds(corrected.ref,['record'])[0];assert.notEqual(fresh,stableAnchor);assert.equal((await f.remove(stableAnchor)).statusCode,409);assert.equal((await f.get('/api/capture-browser/'+n.id)).statusCode,200);
 assert.deepEqual((await f.get('/api/capture-browser/'+fresh)).json().deletion,{available:true,kind:'capture'});assert.deepEqual((await f.remove(fresh)).json(),{deleted:1});
});

test('shared original and metadata anchors cannot delete the note that merely contains them',async t=>{
 const f=await fixture(t),n=await f.note({version:1,observedAt:'2026-10-29T01:00:00Z',noteOrigin:{kind:'share',text:'Generated shared original'}});
 const shared=f.materials.evidenceIds(n.material.ref,['shared-original'])[0];assert.ok(shared);
 const read=await f.get('/api/capture-browser/'+shared);assert.equal(read.statusCode,200);assert.deepEqual(read.json().deletion,{available:false,kind:null});assert.equal((await f.remove(shared)).statusCode,409);
 // Metadata normally has no original member and therefore no evidence anchor;
 // a valid plugin projection of such metadata still must not gain deletion.
 const draft=f.draft(n.material);draft.blocks=draft.blocks.map(b=>b.id==='record-metadata'?{...b,memberIds:[n.id]}:b);
 const changed=f.materials.publish(draft,{expectedRevision:n.material.revision}),metadata=f.materials.evidenceIds(changed.ref,['record-metadata'])[0];assert.ok(metadata);assert.equal((await f.remove(metadata)).statusCode,409);assert.ok(f.store.evidence([n.id])[0]);
});

for(const mode of ['fragment','multiple members','source identity','role','changed bytes'] as const)test('a '+mode+' projection cannot impersonate the complete original deletion target',async t=>{
 const f=await fixture(t),n=await f.note(),draft=f.draft(n.material);
 if(mode==='fragment')draft.blocks=draft.blocks.map(b=>b.id==='record'?{...b,id:'record:1',locator:{textStart:1,textEnd:n.text.length},text:n.text.slice(1)}:b);
 if(mode==='multiple members'){const other=await f.note();draft.members.push({id:other.id,kind:'capture',ref:'capture:'+other.id});draft.blocks=draft.blocks.map(b=>b.id==='record'?{...b,memberIds:[n.id,other.id]}:b);}
 if(mode==='source identity'){draft.origin={...draft.origin,externalId:randomUUID()};draft.id=materialId(draft.origin.sourceId,draft.origin.externalId);}
 if(mode==='role')draft.blocks=draft.blocks.map(b=>b.id==='record'&&b.kind==='text'?{...b,evidenceContext:{observedAt:'2026-10-29T01:00:00Z',document:{timeBasis:'unknown',contentRole:'reference'}}}:b);
 if(mode==='changed bytes')draft.blocks=draft.blocks.map(b=>b.id==='record'&&b.kind==='text'?{...b,text:n.text.trim()}:b);
 const changed=f.materials.publish(draft,mode==='source identity'?undefined:{expectedRevision:n.material.revision}),anchor=f.materials.evidenceIds(changed.ref,[mode==='fragment'?'record:1':'record'])[0];assert.ok(anchor);
 assert.deepEqual((await f.get('/api/capture-browser/'+anchor)).json().deletion,{available:false,kind:null});assert.equal((await f.remove(anchor)).statusCode,409);assert.equal(f.store.evidence([n.id])[0].ocrText,n.text);
});

test('a deleted original cannot be resurrected through its prior alias',async t=>{
 const f=await fixture(t),n=await f.note();assert.deepEqual((await f.remove(n.id)).json(),{deleted:1});const again=await f.remove(n.anchor);assert.deepEqual(again.json(),{deleted:0});assert.equal((await f.get('/api/capture-browser/'+n.anchor)).statusCode,404);
});

test('the existing deletion transaction rechecks the alias and rolls back a synchronous guard failure',async t=>{
 const f=await fixture(t),n=await f.note(),resolver=new MaterialNoteDeletion(f.store,f.materials);let checks=0;
 const deletion=new EvidenceDeletion(f.store,f.files,{resolve:id=>{checks++;const actual=resolver.resolve(id);if(checks===2){assert.equal(f.store.db.isTransaction,true);return {virtual:true,captureId:randomUUID()};}return actual;}});
 assert.throws(()=>deletion.delete(n.anchor),{statusCode:409});assert.equal(f.store.db.isTransaction,false);assert.equal(checks,2);assert.equal((await f.get('/api/capture-browser/'+n.anchor)).json().ocrText,n.text);assert.equal((await f.get('/api/capture-browser/'+n.id)).statusCode,200);
});

 test('a paired collector does not gain owner read or deletion access through either identity',async t=>{
 const f=await fixture(t),n=await f.note(),invite=f.connections.invite({serverUrl:'http://127.0.0.1:47832',label:'Generated collector',deviceId:'generated-device'},'collector');
 const paired=await f.connections.redeem({code:invite.invitation.code,deviceId:'generated-device',deviceName:'Generated',platform:'macos'});
 const headers={authorization:'Bearer '+paired.token};const read=await f.app.inject({url:'/api/capture-browser/'+n.id,headers});assert.equal(read.statusCode,403);
 for(const id of [n.id,n.anchor])assert.equal((await f.app.inject({method:'DELETE',url:'/api/captures/'+id,headers})).statusCode,403);
 assert.equal((await f.get('/api/capture-browser/'+n.id)).statusCode,200);
 });

test('a virtual reader pins the exact returned immutable Material view and never substitutes a raw hash or newer head',async t=>{
 const f=await fixture(t),n=await f.note(),first=(await f.get('/api/capture-browser/'+n.anchor)).json(),second=(await f.get('/api/capture-browser/'+n.anchor)).json();
 assert.equal(first.libraryVersion,n.material.ref+'#record');assert.equal(second.libraryVersion,first.libraryVersion);assert.equal(first.ocrText,n.text);assert.equal(second.id,first.id);
 const raw=(await f.get('/api/capture-browser/'+n.id)).json(),stored=f.store.evidence([n.id])[0];assert.equal(raw.libraryVersion,captureLibraryVersion(stored));assert.notEqual(raw.libraryVersion,first.libraryVersion);
 assert.equal(materialEvidenceLibraryVersion(f.store,{...first,ocrText:'Generated different bytes'}),undefined);
 assert.equal(materialEvidenceLibraryVersion(f.store,{...first,id:randomUUID()}),undefined);
 assert.equal(materialEvidenceLibraryVersion(f.store,{...stored,provenance:{uri:first.libraryVersion}}),undefined,'a raw source URI cannot impersonate a host anchor');
 const corrected=f.materials.correctContext(n.material.id,n.material.revision,'third_party'),currentAnchor=f.materials.evidenceIds(corrected.ref,['record'])[0],current=(await f.get('/api/capture-browser/'+currentAnchor)).json();
 assert.equal(current.libraryVersion,corrected.ref+'#record');assert.notEqual(current.libraryVersion,first.libraryVersion);assert.equal(current.ocrText,n.text);
 assert.equal(materialEvidenceLibraryVersion(f.store,{...current,provenance:{uri:first.libraryVersion}}),undefined,'the new anchor cannot borrow the old revision pin');
 const oldResponse=await f.get('/api/capture-browser/'+n.anchor);if(oldResponse.statusCode===200){const old=oldResponse.json();assert.equal(old.libraryVersion,first.libraryVersion);assert.equal(old.ocrText,n.text);}else assert.equal(oldResponse.statusCode,404);
});
