import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {FILE_PART_BYTES,fileViewSchema,type FileRevision} from '@mote/shared';
import {startBridge} from '../../../packages/agent/dist/bridge.js';
import {buildApp,type QueryAgent} from '../src/app.js';
import type {Config} from '../src/config.js';
import {sha256} from '../src/store.js';
import {Indexer} from '../src/indexer.js';

async function fixture(t:any,query?:QueryAgent['query']){
 const directory=mkdtempSync(join(tmpdir(),'mote-f9-search-')),token='generated-file-search-owner',headers={authorization:'Bearer '+token,'x-mote-ingress-version':'2'};
 const config:Config={dataDir:directory,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:Boolean(query),query:query??(async()=>{throw Error('No model expected');}),close:async()=>{}}});await node.app.ready();
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const api=(method:'GET'|'POST'|'PUT'|'PATCH',url:string,payload?:unknown)=>node.app.inject({method,url,headers,payload:payload as any});
 for(const [id,deviceId,retention] of [['visible','device-a','snapshot'],['private','device-b','snapshot'],['archive','device-a','archive']] as const){
  const response=await api('POST','/api/sources',{id,name:'Generated '+id,kind:'local-files',deviceId,platform:'macos',retention});assert.equal(response.statusCode,200,response.body);
 }
 const upload=async(sourceId:string,key:string,title:string,body:string,at:string,layer:'snapshot'|'original'='snapshot',previousRevision:string|null=null)=>{
  const bytes=Buffer.from(body),hash=sha256(bytes);
  const manifest:FileRevision={sourceId,previousRevision,sizeBytes:bytes.length,sha256:hash,relativePath:key+'.txt',item:{externalId:key,revision:hash,observedAt:at,title,uri:`file:///generated/${sourceId}/${key}.txt`,kind:'file',layer,text:'',mimeType:'text/plain',deleted:false,...(layer==='snapshot'?{document:{fileIndex:{version:1,fileId:key,contentVersion:hash,mode:'index',coverage:'none',parser:'central-pending',status:'pending',totalCharacters:0,offset:0,length:0,maxIndexCharacters:8000,allowRead:true}}}:{})}};
  const started=await api('POST','/api/file-sync/v1/uploads',manifest);assert.equal(started.statusCode,200,started.body);const session=started.json();
  if(session.ack)return session.ack.id as string;
  for(let part=0;part<Math.ceil(bytes.length/FILE_PART_BYTES);part++){
   const response=await node.app.inject({method:'PUT',url:`/api/file-sync/v1/uploads/${session.uploadId}/parts/${part}`,headers:{...headers,'content-type':'application/octet-stream'},payload:bytes.subarray(part*FILE_PART_BYTES,(part+1)*FILE_PART_BYTES)});assert.equal(response.statusCode,200,response.body);
  }
  const done=await api('POST',`/api/file-sync/v1/uploads/${session.uploadId}/commit`,{});assert.equal(done.statusCode,200,done.body);return done.json().id as string;
 };
 return {node,api,upload};
}

test('a source-only conversation reads file chunks and locations on demand without another source on the same device',async t=>{
 let f!:Awaited<ReturnType<typeof fixture>>,failure:unknown,visible='';
 f=await fixture(t,async input=>{
  const bridge=await startBridge(f.node.featureServices.archiveReader,input);
  try{
   assert.equal(input.evidenceIds,undefined);assert.deepEqual(bridge.seedEvidence,[]);
   const call=async(tool:string,args:unknown)=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});const body=await response.json() as any;assert.equal(response.status,200,JSON.stringify(body));return body;};
   const search=await call('search_context',{query:'Generated shared needle'}),metadata=await call('search_context',{query:'FILENAME'});
   const chunk=search.data.find((item:any)=>item.fileEvidence?.captureId===visible);assert.ok(chunk,JSON.stringify(search));
   const original=await call('evidence',{ids:[chunk.id]});assert.match(original.data[0].ocrText,/Generated shared needle/);
   const found=await call('capability_discover',{name:'read_file_evidence'});
   const excerpt=await call('capability_execute',{name:'read_file_evidence',version:found.data.version,argumentsJson:JSON.stringify({id:chunk.id,offset:0,length:30})});assert.equal(excerpt.data.status,'ready');
   assert.match(JSON.stringify(metadata),/GENERATED_VISIBLE_FILENAME/);
   assert.doesNotMatch(JSON.stringify({search,metadata,original,excerpt}),/GENERATED_HIDDEN_FILENAME|archive\/hidden/);
   return {answer:'Generated file answer',citations:[],trace:bridge.trace,runId:randomUUID(),evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies};
  }catch(error){failure=error;throw error;}finally{await bridge.close();}
 });
 visible=await f.upload('visible','selected','GENERATED_VISIBLE_FILENAME.txt','Generated shared needle selected body','2026-10-02T00:00:00Z');
 await f.upload('archive','hidden','GENERATED_HIDDEN_FILENAME.txt','Generated shared needle hidden body','2026-10-02T00:00:00Z','original');
 await f.node.processing.tick();while(await f.node.materialOrganizer.tick(100));
 const id=f.node.conversations.main().id,admitted=await f.api('POST','/api/conversations/messages',{conversationId:id,clientRequestId:randomUUID(),question:'Generated source file question',scope:{kind:'selection',sourceIds:['visible']}});assert.equal(admitted.statusCode,202,admitted.body);
 let message:any;const deadline=Date.now()+10000;
 do{message=f.node.conversations.message(admitted.json().id);if(['completed','failed'].includes(message.status))break;await new Promise(resolve=>setTimeout(resolve,10));}while(Date.now()<deadline);
 if(failure)throw failure;assert.equal(message.status,'completed',JSON.stringify(message));
});

test('file search exposes scoped locations and current availability, and a chunk leads to its retained file',async t=>{
 const {node,api,upload}=await fixture(t),body='Generated start. '+'x'.repeat(5000)+'\nGenerated 正文尾句 and common content.';
 const visible=await upload('visible','a-visible','Generated visible filename.txt',body,'2026-10-02T00:00:00Z');
 const hidden=await upload('private','hidden','GENERATED_HIDDEN_FILENAME.txt',body,'2026-10-02T00:00:00Z');
 const older=await upload('visible','old','GENERATED_OLD_FILENAME.txt','Generated unrelated','2026-09-01T00:00:00Z');
 const archived=await upload('archive','archived','Generated archived.txt','Generated archived original','2026-10-02T00:00:00Z','original');
 await node.processing.tick();
 while(await node.materialOrganizer.tick(100));
 node.sources.reportStatus('visible',{state:'error',code:'generated_offline'});
 const view=await api('GET',`/api/files/${visible}/view?deviceId=device-a`);assert.equal(view.statusCode,200,view.body);
 const projected=fileViewSchema.parse(view.json());assert.equal(projected.coverage.extraction.status,'ready');assert.equal(projected.canOpenOriginal,false);
 const filename=await api('GET','/api/context/retrieve?source=file&deviceId=device-a&query=filename');assert.equal(filename.statusCode,200,filename.body);
 const filenameHit=filename.json().items.find((item:any)=>item.id===visible);assert.ok(filenameHit?.matchReasons.some((reason:string)=>reason.includes('metadata')));assert.equal(filenameHit.locator,undefined);
 for(const route of ['search','retrieve']){const pathHit=await api('GET','/api/context/'+route+'?source=file&deviceId=device-a&query='+encodeURIComponent('visible/a-visible'));assert.equal(pathHit.statusCode,200,pathHit.body);assert.ok(pathHit.json().items.some((item:any)=>item.id===visible&&item.matchReasons.some((reason:string)=>reason.includes('metadata'))),pathHit.body);}
 const chinese=await api('GET','/api/context/retrieve?source=file&deviceId=device-a&query='+encodeURIComponent('尾句'));assert.equal(chinese.statusCode,200,chinese.body);
 const found=chinese.json();assert.equal(found.retrieval.mode,'lexical');assert.equal(found.retrieval.degraded,true);
 assert.ok(found.items.some((item:any)=>item.fileView?.captureId===visible&&item.matchReasons.some((reason:string)=>reason.includes('text'))));
 assert.doesNotMatch(JSON.stringify(found),/GENERATED_HIDDEN_FILENAME|private\/hidden/);
 const offsetSearch=await api('GET','/api/context/retrieve?source=file&deviceId=device-a&after=2026-10-02T07%3A59%3A59%2B08%3A00&query='+encodeURIComponent('尾句'));assert.equal(offsetSearch.statusCode,200,offsetSearch.body);assert.ok(offsetSearch.json().items.some((item:any)=>item.fileView?.captureId===visible));
 const both=await api('GET','/api/context/retrieve?source=file&query='+encodeURIComponent('尾句'));assert.equal(both.statusCode,200,both.body);
 assert.deepEqual(new Set(both.json().items.flatMap((item:any)=>item.fileView?[item.fileView.captureId]:[])),new Set([visible,hidden]),'same bytes retain their independent authorized locations');
 const original=await api('GET',`/api/files/${archived}/content?deviceId=device-a`);assert.equal(original.statusCode,200,original.body);assert.equal(original.body,'Generated archived original');
 const newer=await upload('archive','archived','Generated archived.txt','Generated newer original','2026-10-03T00:00:00Z','original',sha256(Buffer.from('Generated archived original')));
 const historical=await api('GET',`/api/files/${archived}/content?deviceId=device-a`);assert.equal(historical.statusCode,200,historical.body);assert.equal(historical.body,'Generated archived original');
 const oldContext=await api('POST','/api/context/read',{refs:['capture:'+archived],offset:0,length:100,deviceId:'device-a'});assert.deepEqual(oldContext.json().items,[],'a historical archive does not become a current query result');
 const allPage=await api('GET','/api/files?deviceId=device-a&limit=1');assert.equal(allPage.json().items[0].captureId,newer);assert.equal(typeof allPage.json().nextCursor,'string');
 assert.equal((await api('PATCH','/api/sources/archive',{enabled:false})).statusCode,200);
 const afterFirstRemoved=await api('GET','/api/files?deviceId=device-a&limit=1&cursor='+encodeURIComponent(allPage.json().nextCursor));assert.equal(afterFirstRemoved.statusCode,200,afterFirstRemoved.body);assert.equal(afterFirstRemoved.json().items[0].captureId,visible,'revocation of the previous page does not skip the next authorized file');
 assert.notEqual((await api('GET','/api/files?sourceId=visible&limit=1&cursor='+encodeURIComponent(allPage.json().nextCursor))).statusCode,200,'a cursor is bound to its original scope');
 assert.equal((await api('GET',`/api/files/${archived}/content`)).statusCode,404);assert.equal((await api('GET',`/api/files/${newer}/content`)).statusCode,404);
 assert.equal((await api('GET',`/api/files/${hidden}/view?deviceId=device-a`)).statusCode,404);
 const catalog=await api('GET','/api/sources/visible/catalog?parent='+encodeURIComponent('file:///generated/visible/')+'&after=2026-09-15T00%3A00%3A00Z&limit=1');assert.equal(catalog.statusCode,200,catalog.body);
 assert.deepEqual(catalog.json().items.map((item:any)=>item.evidenceId),[visible]);assert.equal(catalog.json().nextCursor,null);assert.doesNotMatch(catalog.body,/GENERATED_OLD_FILENAME/);
 const list=await api('GET','/api/files?sourceId=visible&after=2026-09-15T00%3A00%3A00Z');assert.equal(list.statusCode,200,list.body);assert.deepEqual(list.json().items.map((item:any)=>item.captureId),[visible]);
 const offsetList=await api('GET','/api/files?sourceId=visible&after=2026-10-02T07%3A59%3A59%2B08%3A00');assert.deepEqual(offsetList.json().items.map((item:any)=>item.captureId),[visible]);
 const offsetCatalog=await api('GET','/api/sources/visible/catalog?after=2026-10-02T07%3A59%3A59%2B08%3A00');assert.equal(offsetCatalog.json().directories[0].files,1);
 const firstList=await api('GET','/api/files?sourceId=visible&limit=1');assert.equal(firstList.statusCode,200,firstList.body);assert.equal(typeof firstList.json().nextCursor,'string');
 const metadataUrl='/api/context/search?source=file&deviceId=device-a&limit=1&query='+encodeURIComponent('visible/');
 const firstMetadata=await api('GET',metadataUrl);assert.equal(firstMetadata.statusCode,200,firstMetadata.body);assert.deepEqual(firstMetadata.json().items.map((item:any)=>item.id),[visible]);assert.equal(typeof firstMetadata.json().nextCursor,'string');
 const nextMetadata=await api('GET',metadataUrl+'&cursor='+encodeURIComponent(firstMetadata.json().nextCursor));assert.equal(nextMetadata.statusCode,200,nextMetadata.body);assert.deepEqual(nextMetadata.json().items.map((item:any)=>item.id),[older]);assert.equal(nextMetadata.json().nextCursor,null);
 const firstCatalog=await api('GET','/api/sources/visible/catalog?parent='+encodeURIComponent('file:///generated/visible/')+'&limit=1');assert.equal(firstCatalog.statusCode,200,firstCatalog.body);assert.equal(typeof firstCatalog.json().nextCursor,'string');
 const initialCounts=await api('GET','/api/sources/visible/catalog?after=2026-09-15T00%3A00%3A00Z');assert.equal(initialCounts.json().directories[0].files,1);
 const bridge=await startBridge(node.featureServices.archiveReader,{question:'Generated file query',deviceId:'device-a',executionLane:'interactive'} as any);
 try{
  const send=async(tool:string,args:unknown)=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});return {status:response.status,body:await response.json() as any};};
  const search=await send('search_context',{source:'file',query:'尾句'});assert.equal(search.status,200,JSON.stringify(search.body));
  assert.equal(search.body.retrieval.mode,'lexical');assert.equal(search.body.retrieval.degraded,true);
  const chunk=search.body.data.find((row:any)=>row.fileEvidence?.captureId===visible);assert.ok(chunk,JSON.stringify(search.body));assert.equal(chunk.fileView.captureId,visible);assert.equal(chunk.fileView.canOpenOriginal,false);
  assert.doesNotMatch(JSON.stringify(search.body),/GENERATED_HIDDEN_FILENAME|private\/hidden/);
  const discovered=await send('capability_discover',{name:'file_chunks'});assert.equal(discovered.status,200,JSON.stringify(discovered.body));
  const sourceItems=await send('capability_discover',{name:'source_items'});assert.equal(sourceItems.status,200,JSON.stringify(sourceItems.body));
  const browse=async()=>send('capability_execute',{name:'source_items',version:sourceItems.body.data.version,argumentsJson:JSON.stringify({sourceId:'visible',kind:'file',limit:10})});
  const listed=await browse();assert.equal(listed.status,200,JSON.stringify(listed.body));assert.equal(listed.body.data.length,2);assert.ok(listed.body.data.some((row:any)=>row.fileView?.captureId===visible));
  const execute=async(id:string)=>send('capability_execute',{name:'file_chunks',version:discovered.body.data.version,argumentsJson:JSON.stringify({id})});
  const chunks=await execute(chunk.id);assert.equal(chunks.status,200,JSON.stringify(chunks.body));assert.ok(chunks.body.data.some((row:any)=>row.id===chunk.id),JSON.stringify(chunks.body));
  const tail=await send('evidence',{ids:[chunk.id],offset:chunk.textRange.start,length:600});assert.equal(tail.status,200,JSON.stringify(tail.body));assert.match(tail.body.data[0].ocrText,/尾句/);
  const readable=await send('capability_discover',{name:'read_file_evidence'});assert.equal(readable.status,200,JSON.stringify(readable.body));
  const excerpt=await send('capability_execute',{name:'read_file_evidence',version:readable.body.data.version,argumentsJson:JSON.stringify({id:chunk.id,offset:body.indexOf('尾句'),length:2})});assert.equal(excerpt.status,200,JSON.stringify(excerpt.body));assert.equal(excerpt.body.data.record.ocrText,'尾句');
  const excerptId=excerpt.body.data.record.id;
  const afterReadCounts=await api('GET','/api/sources/visible/catalog');assert.equal(afterReadCounts.json().directories[0].files,2,'a cited text range is not a new file location');
  const materials=await send('material_catalog',{query:'尾句'});assert.equal(materials.status,200,JSON.stringify(materials.body));const material=materials.body.data.items.find((item:any)=>item.origin?.sourceId==='visible');assert.ok(material,JSON.stringify(materials.body));
  assert.notEqual((await execute('file:///generated/visible/a-visible.txt')).status,200);
  const revoked=await api('PATCH','/api/sources/visible',{enabled:false});assert.equal(revoked.statusCode,200,revoked.body);
  const withdrawn=await execute(chunk.id);assert.ok(withdrawn.status!==200||withdrawn.body.data.length===0,JSON.stringify(withdrawn.body));
  const afterExcerpt=await send('capability_execute',{name:'read_file_evidence',version:readable.body.data.version,argumentsJson:JSON.stringify({id:chunk.id,offset:body.indexOf('尾句'),length:2})});assert.ok(afterExcerpt.status!==200||afterExcerpt.body.data.status==='unavailable',JSON.stringify(afterExcerpt.body));
  const oldExcerpt=await send('evidence',{ids:[excerptId]});assert.ok(oldExcerpt.status!==200||oldExcerpt.body.data.length===0,JSON.stringify(oldExcerpt.body));
  const staleMaterial=await send('material_read',{ref:material.ref});assert.notEqual(staleMaterial.status,200);assert.doesNotMatch(JSON.stringify(staleMaterial.body),/尾句|filename|a-visible/);
  const currentMaterials=await send('material_catalog',{query:'尾句'});assert.equal(currentMaterials.status,200,JSON.stringify(currentMaterials.body));assert.doesNotMatch(JSON.stringify(currentMaterials.body),/尾句|filename|a-visible/);
  const hiddenList=await browse();assert.equal(hiddenList.status,200,JSON.stringify(hiddenList.body));assert.deepEqual(hiddenList.body.data,[]);assert.equal(hiddenList.body.pagination.nextCursor,null);
  assert.equal((await api('GET',`/api/files/${visible}/view?deviceId=device-a`)).statusCode,404);
  assert.equal((await api('GET',`/api/files/${visible}/chunks?deviceId=device-a`)).statusCode,404);
  const deep=await api('POST','/api/context/read',{refs:['capture:'+visible],offset:0,length:100,deviceId:'device-a'});assert.equal(deep.statusCode,200,deep.body);assert.deepEqual(deep.json().items,[]);assert.deepEqual(deep.json().missingRefs,['capture:'+visible]);
  const excerptDeep=await api('POST','/api/context/read',{refs:['capture:'+excerptId],offset:0,length:100,deviceId:'device-a'});assert.equal(excerptDeep.statusCode,200,excerptDeep.body);assert.deepEqual(excerptDeep.json().items,[]);
  const afterSearch=await api('GET','/api/context/retrieve?source=file&deviceId=device-a&query='+encodeURIComponent('尾句'));assert.equal(afterSearch.statusCode,200,afterSearch.body);assert.deepEqual(afterSearch.json().items,[]);
  const after=await api('GET','/api/sources/visible/catalog?parent='+encodeURIComponent('file:///generated/visible/')+'&limit=1');assert.equal(after.statusCode,200,after.body);assert.deepEqual(after.json().items,[]);assert.equal(after.json().nextCursor,null);
  const page=await api('GET','/api/files?sourceId=visible&limit=1');assert.equal(page.statusCode,200,page.body);assert.deepEqual(page.json().items,[]);assert.equal(page.json().nextCursor,null);
  const resumed=await api('GET','/api/files?sourceId=visible&limit=1&cursor='+encodeURIComponent(firstList.json().nextCursor));assert.deepEqual(resumed.json().items,[]);assert.equal(resumed.json().nextCursor,null);
  const resumedMetadata=await api('GET',metadataUrl+'&cursor='+encodeURIComponent(firstMetadata.json().nextCursor));assert.equal(resumedMetadata.statusCode,200,resumedMetadata.body);assert.deepEqual(resumedMetadata.json().items,[]);assert.equal(resumedMetadata.json().nextCursor,null);
  const continued=await api('GET','/api/sources/visible/catalog?parent='+encodeURIComponent('file:///generated/visible/')+'&limit=1&cursor='+encodeURIComponent(firstCatalog.json().nextCursor));assert.deepEqual(continued.json().items,[]);assert.equal(continued.json().nextCursor,null);
  const counts=await api('GET','/api/sources/visible/catalog');assert.equal(counts.statusCode,200,counts.body);assert.deepEqual(counts.json().directories,[]);
 }finally{await bridge.close();}
 assert.ok(older);
});

test('a device-reported missing original retains its independently authorized snapshot text',async t=>{
 const {node,api,upload}=await fixture(t),body='Generated snapshot retained after origin loss',id=await upload('visible','missing','Generated missing file.txt',body,'2026-10-01T00:00:00Z');
 await node.processing.tick();
 const manifest=JSON.parse(node.files.version(id).manifest) as FileRevision;
 const removed={...manifest,previousRevision:manifest.item.revision,sha256:undefined,item:{...manifest.item,revision:'deleted:generated',observedAt:'2026-10-03T00:00:00Z',deleted:true}};
 const response=await api('PUT','/api/file-sync/v1/revisions',removed);assert.equal(response.statusCode,200,response.body);
 node.files.sweep();
 const chunks=node.files.chunks(id);assert.ok(chunks.length);assert.equal(node.evidenceContext.assembly.reader.contextDependenciesAllowed([id,chunks[0].id]),true);
 const view=await api('GET',`/api/files/${id}/view`);assert.equal(view.statusCode,200,view.body);assert.equal(view.json().originMissing,true);assert.equal(view.json().canOpenOriginal,false);
 const excerpt=await node.featureServices.archiveReader.readFileEvidence!({id,offset:0,length:body.length});assert.equal(excerpt.record?.ocrText,body);
 const found=await api('GET','/api/context/retrieve?source=file&query=retained');assert.equal(found.statusCode,200,found.body);assert.ok(found.json().items.some((item:any)=>item.fileView?.captureId===id));
 const catalog=await api('GET','/api/sources/visible/catalog?parent='+encodeURIComponent('file:///generated/visible/'));assert.equal(catalog.statusCode,200,catalog.body);assert.deepEqual(catalog.json().items.map((item:any)=>item.evidenceId),[id]);
 const disabled=await api('PATCH','/api/sources/visible',{enabled:false});assert.equal(disabled.statusCode,200,disabled.body);assert.equal(node.evidenceContext.assembly.reader.contextDependenciesAllowed([id,chunks[0].id]),false);
});

test('retained file history stays owner-readable while context and model reads recheck the current revision and source grant',async t=>{
 const {node,api,upload}=await fixture(t),oldBody='Generated FILE_HISTORY_SCOPE previous body',newBody='Generated FILE_HISTORY_SCOPE current body';
 const previous=await upload('archive','history','Generated FILE_HISTORY_SCOPE previous.txt',oldBody,'2026-10-01T00:00:00Z','original');
 await node.processing.tick();
 const previousChunk=node.files.chunks(previous)[0];assert.ok(previousChunk,'the real text processor publishes a searchable chunk');
 const bridge=await startBridge(node.featureServices.archiveReader,{question:'Generated file history query',deviceId:'device-a',executionLane:'interactive'} as any);
 try{
  const tool=async(name:string,args:unknown)=>{const response=await fetch(bridge.url+'/'+name,{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});const body=await response.json() as any;assert.equal(response.status,200,JSON.stringify(body));return body;};
  const read=async(ids:string[],scope:Record<string,string>={})=>{const response=await api('POST','/api/context/read',{refs:ids.map(id=>'capture:'+id),offset:0,length:100,deviceId:'device-a',...scope});assert.equal(response.statusCode,200,response.body);return response.json();};
  const search=async()=>{
   const pages=[];
   for(const route of ['search','retrieve']){const response=await api('GET','/api/context/'+route+'?source=file&sourceId=archive&deviceId=device-a&query=FILE_HISTORY_SCOPE');assert.equal(response.statusCode,200,response.body);pages.push(response.json().items);}
   pages.push((await tool('search_context',{source:'file',query:'FILE_HISTORY_SCOPE'})).data);
   return pages as any[][];
  };
  assert.deepEqual((await read([previous])).items.map((item:any)=>item.id),[previous]);
  for(const page of await search())assert.ok(page.some(item=>item.id===previous||item.fileView?.captureId===previous),JSON.stringify(page));
  assert.deepEqual((await tool('evidence',{ids:[previousChunk.id]})).data.map((item:any)=>item.id),[previousChunk.id]);

  const current=await upload('archive','history','Generated FILE_HISTORY_SCOPE current.txt',newBody,'2026-10-02T00:00:00Z','original',sha256(Buffer.from(oldBody)));
  await node.processing.tick();
  const currentChunk=node.files.chunks(current)[0];assert.ok(currentChunk);
  const history=await api('GET',`/api/files/${previous}/content?deviceId=device-a&sourceId=archive`);assert.equal(history.statusCode,200,history.body);assert.equal(history.body,oldBody);
  for(const scope of ['deviceId=device-b','sourceId=visible','after=2026-10-03T00%3A00%3A00Z'])assert.equal((await api('GET',`/api/files/${previous}/content?${scope}`)).statusCode,404,scope);
  const retired=await read([previous,previousChunk.id]);assert.deepEqual(retired.items,[]);assert.deepEqual(retired.missingRefs,['capture:'+previous,'capture:'+previousChunk.id]);
  assert.deepEqual((await read([current,currentChunk.id])).items.map((item:any)=>item.id),[current,currentChunk.id]);
  for(const scope of [{sourceId:'visible'},{deviceId:'device-b'},{after:'2026-10-03T00:00:00Z'}])assert.deepEqual((await read([current,currentChunk.id],scope)).items,[]);
  for(const page of await search()){
   assert.ok(page.some(item=>item.id===current||item.fileView?.captureId===current),JSON.stringify(page));
   assert.ok(page.every(item=>item.id!==previous&&item.id!==previousChunk.id&&item.fileView?.captureId!==previous),JSON.stringify(page));
  }
  assert.deepEqual((await tool('evidence',{ids:[previous,previousChunk.id]})).data,[]);
  assert.match(JSON.stringify((await tool('evidence',{ids:[currentChunk.id]})).data),/current body/);

  for(const change of [{enabled:false},{enabled:true,retention:'reference'}]){
   const changed=await api('PATCH','/api/sources/archive',change);assert.equal(changed.statusCode,200,changed.body);
   for(const id of [previous,current])assert.equal((await api('GET',`/api/files/${id}/content`)).statusCode,404);
   const withdrawn=await read([previous,previousChunk.id,current,currentChunk.id]);assert.deepEqual(withdrawn.items,[]);assert.equal(withdrawn.missingRefs.length,4);
   assert.deepEqual((await tool('evidence',{ids:[previous,previousChunk.id,current,currentChunk.id]})).data,[]);
   for(const page of await search())assert.deepEqual(page,[]);
  }
 }finally{await bridge.close();}
});

test('a source withdrawn while the vector request is in flight cannot appear in the refreshed results',async t=>{
 const {node,api,upload}=await fixture(t),id=await upload('visible','vector','Generated vector.txt','Generated vector search tail','2026-10-01T00:00:00Z');await node.processing.tick();
 let entered!:()=>void,release!:()=>void,blocking=false;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
 const provider=createServer(async(req,res)=>{for await(const _ of req){}if(blocking){entered();await gate;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{embedding:[1,0]}]}));});
 await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const indexer=new Indexer(node.store,{embeddingModel:'generated-vector',embeddingBaseUrl:`http://127.0.0.1:${(provider.address() as {port:number}).port}`,embeddingApiKey:''},undefined,node.files);
 try{
  const chunk=node.files.chunks(id)[0];node.files.indexed(chunk.id,[1,0],'generated-vector');
  const semantic=await indexer.search({query:'unmatched semantic phrase',source:'file'});assert.equal(semantic.retrieval.mode,'hybrid');assert.ok(semantic.some(record=>record.id===chunk.id),'the real vector channel returns an authorized file chunk');
  blocking=true;
  const pending=indexer.search({query:'search',source:'file'});await started;
  const disabled=await api('PATCH','/api/sources/visible',{enabled:false});assert.equal(disabled.statusCode,200,disabled.body);release();
  assert.deepEqual([...await pending],[]);
 }finally{release();await indexer.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));}
});
