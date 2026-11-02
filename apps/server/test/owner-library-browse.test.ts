import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import {materialId,type MaterialDraft} from '../src/materials.js';
import {storedCaptureLibraryVersion} from '../src/capture-library-version.js';

async function fixture(t:import('node:test').TestContext){
 const dir=mkdtempSync(join(tmpdir(),'mote-owner-browse-')),token='generated-owner-browse-token-123456789';
 const node=await buildApp({dataDir:dir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false});
 // This fixture publishes its own replacement materials. Disable the unselected
 // periodic organizer before any intake, independent of machine/test speed.
 await node.materialOrganizer.close();
 t.after(async()=>{await node.app.close();rmSync(dir,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+token,'x-mote-ingress-version':'2'};
 const note=async(index:number,at='2026-10-21T01:00:00.000Z')=>{const id=randomUUID(),text='Generated note '+index+' literal searchable body';const response=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-note-device',deviceName:'Generated note device',platform:'import',capturedAt:at,text,metadata:{version:1,observedAt:at,ownerDescription:'PRIVATE DESCRIPTION must never become a browse preview'}}});assert.equal(response.statusCode,201,response.body);return {id,text,at};};
 const read=async(query:Record<string,string>={},status=200,auth=headers)=>{const response=await node.app.inject({url:'/api/library/browse?'+new URLSearchParams(query),headers:auth});assert.equal(response.statusCode,status,response.body);return response.json();};
 node.sources.register({id:'generated-source',name:'Generated source',kind:'custom',deviceId:'generated-material-device',platform:'import'});
 const material=(id:string,original:{id:string;text:string;at:string},extra:Partial<MaterialDraft>={},options:Parameters<typeof node.materials.publish>[1]={})=>node.materials.publish({id:materialId('generated-source',id),kind:'mote.note',schemaVersion:1,title:'Generated material '+id,origin:{sourceId:'generated-source',externalId:id,firstAt:original.at,lastAt:original.at,deviceId:'generated-material-device'},members:[{id:original.id,kind:'capture',ref:'capture:'+original.id,revision:storedCaptureLibraryVersion(node.store,original.id)}],blocks:[{id:'body',kind:'text',format:'plain',text:original.text,memberIds:[original.id]}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'},...extra},options);
 return {node,headers,note,read,material};
}

test('real note intake appears immediately among existing materials with one complete chronological cursor',async t=>{
 const f=await fixture(t),originals=[];for(let i=0;i<29;i++)originals.push(await f.note(i,new Date(Date.parse('2026-10-21T01:00:00Z')+Math.floor(i/3)*60000).toISOString()));
 const pinned=f.material('exact',originals[0]),partial=f.material('partial',originals[1],{coverage:{state:'partial'}}),summary=f.material('summary',originals[2],{fidelity:{state:'summary-only'}});
 // Grouping and unpinned projections cannot replace the actual original note.
 const grouped=f.material('group',originals[3],{members:[{id:originals[3].id,kind:'capture',ref:'capture:'+originals[3].id},{id:originals[4].id,kind:'capture',ref:'capture:'+originals[4].id}]}),unpinned=f.material('unpinned',originals[5],{members:[{id:originals[5].id,kind:'capture',ref:'capture:'+originals[5].id}]});
 const seen:any[]=[];let cursor:string|undefined;do{const page=await f.read({limit:'7',...(cursor?{cursor}:{})});assert.ok(page.items.length<=7);seen.push(...page.items);cursor=page.nextCursor??undefined;}while(cursor);
 assert.equal(seen.length,33);assert.equal(new Set(seen.map(item=>item.ref)).size,33);assert.deepEqual(seen.map(item=>[item.contentAt,item.ref]),[...seen].sort((a,b)=>b.contentAt.localeCompare(a.contentAt)||b.ref.localeCompare(a.ref)).map(item=>[item.contentAt,item.ref]));
 assert.equal(seen.some(item=>item.ref==='capture:'+originals[0].id),false);assert.ok(seen.some(item=>item.ref===pinned.ref));for(const value of [partial,summary,grouped,unpinned])assert.ok(seen.some(item=>item.ref===value.ref));for(const i of [1,2,3,4,5])assert.ok(seen.some(item=>item.ref==='capture:'+originals[i].id));
 const original=seen.find(item=>item.ref==='capture:'+originals[28].id);assert.equal(original.entryType,'capture');assert.equal(original.capture.textPreview,originals[28].text);assert.equal(original.revision,storedCaptureLibraryVersion(f.node.store,originals[28].id));assert.doesNotMatch(JSON.stringify(seen),/PRIVATE DESCRIPTION/);
 const detail=await f.node.app.inject({url:'/api/capture-browser/'+originals[28].id,headers:f.headers});assert.equal(detail.statusCode,200);assert.equal(detail.json().ocrText,originals[28].text);
 assert.deepEqual((await f.read({query:'PRIVATE DESCRIPTION'})).items,[]);assert.equal((await f.read({type:'note',limit:'100'})).items.length,33);assert.deepEqual((await f.read({type:'image'})).items,[]);assert.equal((await f.read({origin:'notes',limit:'100'})).items.length,29);assert.ok((await f.read({sourceId:'generated-source',limit:'100'})).items.every((item:any)=>item.entryType==='material'));assert.ok((await f.read({deviceId:'generated-note-device',limit:'100'})).items.every((item:any)=>item.entryType==='capture'));
 // The distinct Material-only route still exposes only its five real materials.
 const catalog=await f.node.app.inject({url:'/api/library/catalog?limit=100',headers:f.headers});assert.equal(catalog.json().items.length,5);assert.ok(catalog.json().items.every((item:any)=>item.ref.startsWith('material:')));
});

test('browse privacy and deletion boundaries invalidate cursors and non-owner credentials stay denied',async t=>{
 const f=await fixture(t),first=await f.note(1),second=await f.note(2),page=await f.read({limit:'1'});assert.ok(page.nextCursor);
 await f.read({limit:'1',type:'note',cursor:page.nextCursor},409);await f.read({limit:'1',cursor:page.nextCursor+'tampered'},400);await f.read({limit:'1',origin:'notes',sourceId:'generated-source'},400);
 const removed=await f.node.app.inject({method:'DELETE',url:'/api/captures/'+first.id,headers:f.headers});assert.equal(removed.statusCode,200);await f.read({limit:'1',cursor:page.nextCursor},409);assert.equal((await f.read({limit:'100'})).items.some((item:any)=>item.ref==='capture:'+first.id),false);assert.equal((await f.node.app.inject({url:'/api/capture-browser/'+first.id,headers:f.headers})).statusCode,404);
 // Actual retention erasure uses the existing store boundary. It cannot be
 // reconstructed from an old browse page, original version, or cursor.
 f.node.store.prune('2026-10-22T00:00:00.000Z');assert.equal((await f.read()).items.length,0);assert.equal((await f.node.app.inject({url:'/api/capture-browser/'+second.id,headers:f.headers})).statusCode,404);
 const note=await f.note(3);const material=f.material('current',note);const before=await f.read({limit:'1'});f.node.materials.retire(material.id,{expectedRevision:material.revision});if(before.nextCursor)await f.read({limit:'1',cursor:before.nextCursor},409);assert.ok((await f.read()).items.some((item:any)=>item.ref==='capture:'+note.id));
 assert.equal((await f.node.app.inject('/api/library/browse')).statusCode,401);
 const invitation=await f.node.app.inject({method:'POST',url:'/api/connections/collector-invitations',headers:f.headers,payload:{serverUrl:'https://generated.invalid',label:'Generated collector'}});const redeemed=await f.node.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invitation.json().invitation.code,deviceId:'generated-collector',deviceName:'Generated collector',platform:'android'}});await f.read({},403,{...f.headers,authorization:'Bearer '+redeemed.json().token});
 const readOnly=await f.node.connections.mintMcp({serverUrl:'https://generated.invalid',label:'Generated Agent',access:'read'},{directory:join(f.node.store.directory,'connectors'),mcpEnabled:true});const credential=Object.values(readOnly.config.mcpServers)[0].headers.Authorization;await f.read({},403,{...f.headers,authorization:credential});
});

test('browse source ordering normalizes ISO offsets and equivalent millisecond timestamps through multiple pages',async t=>{
 const f=await fixture(t);const instants=['2026-10-29T08:00:00+08:00','2026-10-29T01:00:00Z','2026-10-29T01:00:00.000Z','2026-10-28T18:00:00-07:00','2026-10-29T09:00:00.001+08:00'];
 const expected:any[]=[];
 for(let index=0;index<instants.length;index++){const original=await f.note(index,instants[index]);expected.push({ref:'capture:'+original.id,contentAt:new Date(instants[index]).toISOString()});const material=f.material('offset-'+index,original,{members:[{id:original.id,kind:'capture',ref:'capture:'+original.id}],origin:{sourceId:'generated-source',externalId:'offset-'+index,firstAt:instants[index],lastAt:instants[index]}});expected.push({ref:material.ref,contentAt:new Date(instants[index]).toISOString()});}
 const seen:any[]=[];let cursor:string|undefined;do{const page=await f.read({limit:'2',...(cursor?{cursor}:{})});seen.push(...page.items.map(({ref,contentAt}:any)=>({ref,contentAt})));cursor=page.nextCursor??undefined;}while(cursor);
 assert.deepEqual(seen,expected.sort((a,b)=>b.contentAt.localeCompare(a.contentAt)||b.ref.localeCompare(a.ref)));assert.equal(new Set(seen.map(item=>item.ref)).size,10);
 const bounded=await f.read({after:'2026-10-29T08:30:00+08:00',before:'2026-10-29T09:00:00.001+08:00',limit:'100'});assert.equal(bounded.items.length,6);assert.ok(bounded.items.every((item:any)=>item.contentAt==='2026-10-29T01:00:00.000Z'));
});

function observeBrowse(f:Awaited<ReturnType<typeof fixture>>){
 const reads={preflight:0,exact:0,exactCompiles:0,perItemVisibility:0,facets:0},db=f.node.store.db,prepare=db.prepare.bind(db),list=f.node.materials.list.bind(f.node.materials),catalog=f.node.materials.catalog.list.bind(f.node.materials.catalog);
 db.prepare=sql=>{const represented=sql.includes('r.member_count=1'),preflight=represented&&sql.includes('m.ref IN');if(represented&&!preflight)reads.exactCompiles++;return new Proxy(prepare(sql),{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;return (...args:unknown[])=>{if(key==='all'&&represented){if(preflight)reads.preflight++;else reads.exact++;}return value.apply(target,args);};}});};
 f.node.materials.list=args=>{if(args?.id)reads.perItemVisibility++;return list(args);};
 f.node.materials.catalog.list=(...args)=>{reads.facets++;return catalog(...args);};
 return reads;
}

test('400 unrepresented notes use batch-bounded preflight without per-note replacement queries',async t=>{
 const f=await fixture(t);for(let i=0;i<400;i++)await f.note(i);
 const reads=observeBrowse(f),page=await f.read({limit:'100'});assert.equal(page.items.length,100);assert.ok(page.items.every((item:any)=>item.entryType==='capture'));
 assert.equal(reads.exact,0,'No candidate has a possible replacement');assert.equal(reads.exactCompiles,0,'Exact statement remains lazy');assert.equal(reads.preflight,2,'101 candidates come from two batches of at most100');assert.equal(reads.perItemVisibility,0);
});

test('400 notes with390 exact replacements retain every entry, order, revision, cursor and facet while preparing exact lookup once',async t=>{
 const f=await fixture(t),expected:{ref:string;contentAt:string}[]=[];
 for(let i=0;i<400;i++){const at=new Date(Date.parse('2026-10-21T01:00:00Z')+Math.floor(i/3)*60000).toISOString(),original=await f.note(i,at);expected.push({ref:i<390?f.material('exact-'+i,original).ref:'capture:'+original.id,contentAt:at});}
 await f.node.materialOrganizer.tick(200); // Exercise a delayed background pump before the first read.
 expected.sort((a,b)=>b.contentAt.localeCompare(a.contentAt)||b.ref.localeCompare(a.ref));const reads=observeBrowse(f),first=await f.read({limit:'100'});
 assert.deepEqual(await f.read({limit:'100'}),first,'A cache hit preserves the complete first page including its signed cursor');
 const seen:any[]=[];let page=first;do{seen.push(...page.items.map(({ref,contentAt}:any)=>({ref,contentAt})));assert.equal(page.revision,first.revision);assert.deepEqual(page.types,first.types);assert.deepEqual(page.sources,first.sources);assert.equal(page.sourcesTruncated,first.sourcesTruncated);if(!page.nextCursor)break;page=await f.read({limit:'100',cursor:page.nextCursor});}while(true);
 assert.deepEqual(seen,expected);assert.equal(new Set(seen.map(item=>item.ref)).size,400);assert.equal(reads.exactCompiles,1);assert.ok(reads.perItemVisibility>=390,'Every possible exact replacement still checks live visibility');assert.equal(reads.facets,1);
});

test('version mismatches, duplicate members and query-invisible replacements never hide an original note',async t=>{
 const f=await fixture(t),mismatch=await f.note(1),duplicate=await f.note(2),invisible=await f.note(3),hidden=await f.note(4);
 f.material('mismatch',mismatch,{members:[{id:mismatch.id,kind:'capture',ref:'capture:'+mismatch.id,revision:'generated-wrong-version'}]});
 f.material('duplicate',duplicate,{members:[{id:duplicate.id,kind:'capture',ref:'capture:'+duplicate.id,revision:storedCaptureLibraryVersion(f.node.store,duplicate.id)},{id:'same-original-again',kind:'capture',ref:'capture:'+duplicate.id,revision:storedCaptureLibraryVersion(f.node.store,duplicate.id)}]});
 f.material('different-device',invisible);
 const protectedMaterial=f.material('redacted',hidden);f.node.materials.redactUntilRebuilt(protectedMaterial.id);
 const all=await f.read({limit:'100'});for(const original of [mismatch,duplicate,hidden])assert.ok(all.items.some((item:any)=>item.ref==='capture:'+original.id));
 const device=await f.read({deviceId:'generated-note-device',limit:'100'});assert.ok(device.items.some((item:any)=>item.ref==='capture:'+invisible.id));assert.ok(device.items.every((item:any)=>item.entryType==='capture'));
});

test('facets reuse only live generation, source names, registry and owner credentials while authorization stays current',async t=>{
 const f=await fixture(t),original=await f.note(1),material=f.material('facets',original),reads=observeBrowse(f),catalog=f.node.materials.catalog;
 const first=await f.read();assert.equal(reads.facets,1);assert.deepEqual(await f.read(),first);assert.equal(reads.facets,1);
 const added=f.material('new-facet',await f.note(2));assert.equal((await f.read()).sources[0].count,2);assert.equal(reads.facets,2);
 f.node.materials.retire(added.id,{expectedRevision:added.revision});assert.equal((await f.read()).sources[0].count,1);assert.equal(reads.facets,3);
 const generation=catalog.generation();f.node.sources.update('generated-source',{name:'Renamed generated source'});assert.equal(catalog.generation(),generation,'Source labels are outside material generation');
 assert.equal((await f.read()).sources.find((source:any)=>source.id==='generated-source').label,'Renamed generated source');assert.equal(reads.facets,4);
 const dispose=catalog.registry.register({id:'generated.extra-type',kind:'generated.extra-kind',schemaVersion:1,label:'Generated extra type'});assert.ok((await f.read()).types.some((type:any)=>type.id==='generated.extra-type'));assert.equal(reads.facets,5);
 dispose();assert.equal((await f.read()).types.some((type:any)=>type.id==='generated.extra-type'),false);assert.equal(reads.facets,6);
 f.node.materials.redactUntilRebuilt(material.id);const protectedPage=await f.read();assert.deepEqual(protectedPage.sources,[]);assert.ok(protectedPage.items.some((item:any)=>item.ref==='capture:'+original.id));assert.equal(reads.facets,7);
 const replacement=f.material('facets',original,{title:'Generated rebuilt material'},{expectedRevision:material.revision});assert.equal((await f.read()).sources[0].count,1);assert.equal(reads.facets,8);
 f.node.materials.retire(replacement.id,{expectedRevision:replacement.revision});assert.deepEqual((await f.read()).sources,[]);assert.equal(reads.facets,9);
 const removed=await f.node.app.inject({method:'DELETE',url:'/api/captures/'+original.id,headers:f.headers});assert.equal(removed.statusCode,200);assert.equal((await f.read()).items.some((item:any)=>item.ref==='capture:'+original.id),false);assert.equal(reads.facets,10);
 const invitation=await f.node.app.inject({method:'POST',url:'/api/connections/invitations',headers:f.headers,payload:{serverUrl:'https://generated.invalid',label:'Generated second owner device'}});assert.equal(invitation.statusCode,200,invitation.body);
 const redeemed=await f.node.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invitation.json().invitation.code,deviceId:'generated-second-owner',deviceName:'Generated owner',platform:'android'}});assert.equal(redeemed.statusCode,200,redeemed.body);
 const paired=redeemed.json(),auth={...f.headers,authorization:'Bearer '+paired.token};await f.read({},200,auth);assert.equal(reads.facets,11,'A different owner credential cannot reuse the cached identity');
 const revoked=await f.node.app.inject({method:'DELETE',url:'/api/connections/'+paired.credentialId,headers:f.headers});assert.equal(revoked.statusCode,200);await f.read({},401,auth);assert.equal(reads.facets,11,'Revoked credentials fail before a cached projection is read');
});
