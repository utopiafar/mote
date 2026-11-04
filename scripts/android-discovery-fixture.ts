/** Dedicated generated-only native discovery server. The proxy can lose an ACK
 * after real admission; report publication, scope and cancellation remain real. */
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp,type QueryAgent} from '../apps/server/src/app.js';
import type {ContextReader} from '@mote/agent';
import {noteCapture} from '@mote/shared';
import {materialId} from '../apps/server/src/materials.js';
const dataDir=await mkdtemp(join(tmpdir(),'mote-native-discovery-')),port=Number(process.env.MOTE_DISCOVERY_FIXTURE_PORT ?? 47886),token='generated-native-discovery-owner-token';
let noteId=randomUUID(),ids:string[]=[],queryCalls=0,insightCalls=0,dropAck=false,lastQuery:unknown=null;
let offline=false,failNextConversationRead=false;
let holdNext=false,releaseGeneration:(()=>void)|undefined,activeGenerations=0;
const seenRequests:string[]=[];
const seenAskRequests:string[]=[],askGetIds:string[]=[];
let dropAskAck=false,hideAskRuns=false,holdNextQuery=false,failNextQuery=false,activeQueries=0,releaseQuery:(()=>void)|undefined;
const nativeMaterialId=materialId('generated-native-material','one');let nativeMaterialRef='',changeMaterialOnStart=false;
const materialReads:string[]=[];
let holdNextMaterialRead=false,materialReadHeld=false,releaseMaterialRead:(()=>void)|undefined;
let dropAttachmentAck=false,holdAttachmentCommit=false,attachmentCommitHeld=false,releaseAttachmentCommit:(()=>void)|undefined;
const attachmentManifests:string[]=[];
let holdExport=false,exportHeld=false,releaseExport:(()=>void)|undefined;
function publishMaterial(label='Original',partial=false,assetOnly=false){
 const asset=assetOnly?node.store.assets.put(Buffer.from('Generated asset-only original bytes')):undefined;
 const material=node.materials.publish({id:nativeMaterialId,kind:'mote.file',schemaVersion:1,title:'Generated exact whole Material',origin:{sourceId:'generated-native-material',externalId:'one',deviceId:'generated-discovery-phone',firstAt:'2026-10-01T00:00:00Z',lastAt:'2026-10-01T00:00:00Z'},members:[{id:noteId,kind:'capture',ref:'capture:'+noteId}],blocks:asset?[{id:'original-asset',kind:'asset' as const,hash:asset.hash,mimeType:'text/plain',memberIds:[noteId]}]:Array.from({length:partial?2:31},(_,index)=>({id:'paragraph-'+index,kind:'text' as const,format:'plain',text:label+' generated exact paragraph '+index,memberIds:[noteId]})),coverage:{state:partial?'partial':'complete',...(partial?{reason:'generated_unavailable_tail'}:{})},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}},{expectedRevision:node.materials.revisionForWrite(nativeMaterialId)});
 asset?.release();nativeMaterialRef=material.ref;return material;
}
function agent(reader:ContextReader):QueryAgent{return {configured:true,close:async()=>{},query:async input=>{
 let evidenceIds=input.anchorEvidenceIds??input.evidenceIds??[noteId];
 if(input.anchorMaterialRef){const page=await reader.materialRead!({ref:input.anchorMaterialRef,length:12000});materialReads.push(page.material.ref);evidenceIds=page.originalRefs.filter(ref=>ref.startsWith('capture:')).map(ref=>ref.slice(8));if(!evidenceIds.length)evidenceIds=[noteId];}
 const records=await reader.evidence({ids:evidenceIds});if(records.length!==evidenceIds.length)throw Error('Generated fixture evidence is not actually readable');
 const citations=records.map(row=>({id:row.id,appName:row.appName,capturedAt:row.capturedAt,excerpt:row.ocrText}));
 if(input.skill==='personal-insight'){
  insightCalls++;activeGenerations++;
  if(holdNext){holdNext=false;await new Promise<void>(resolve=>releaseGeneration=resolve);}else await new Promise(resolve=>setTimeout(resolve,2500));
  activeGenerations--;
  return {answer:JSON.stringify({title:'Generated native report',markdown:'Generated native conclusion remains uncertain. ['+records[0].id+']',html:'<p>Generated native conclusion remains uncertain.</p>'}),citations,trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:evidenceIds}};
 }
 queryCalls++;lastQuery={question:input.question,anchorEvidenceIds:input.anchorEvidenceIds??null,evidenceIds:input.evidenceIds??null,anchorMaterialRef:input.anchorMaterialRef??null};
 activeQueries++;if(holdNextQuery){holdNextQuery=false;await new Promise<void>(resolve=>releaseQuery=resolve);}activeQueries--;if(failNextQuery){failNextQuery=false;throw Error('generated_native_query_failure: complete controlled diagnostics');}
 return {answer:'Generated answer from the actual original: '+records.map(row=>row.ocrText+' ['+row.id+']').join('\n'),citations,trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:evidenceIds}};
}};}
const node=await buildApp({dataDir,token,tokenPath:'fixture-only',host:'127.0.0.1',port,profile:'test',maxStorageBytes:32_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-fixture-model',modelBaseUrl:'https://fixture.invalid',apiKey:'generated-fixture-key',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false,createModelAgent:async(_settings,reader)=>agent(reader)});
node.sources.register({id:'generated-native-material',name:'Generated native Material source',kind:'custom',deviceId:'generated-discovery-phone',platform:'import'});
const restricted=await node.connections.mintMcp({serverUrl:'http://127.0.0.1:'+port,label:'Generated read-only Agent',access:'read'},{mcpEnabled:true,directory:'unused'});
const restrictedToken=restricted.config.mcpServers.mote.headers.Authorization.slice(7);
async function reset(){
 releaseExport?.();releaseExport=undefined;holdExport=false;exportHeld=false;
 releaseMaterialRead?.();releaseMaterialRead=undefined;holdNextMaterialRead=false;materialReadHeld=false;
 releaseAttachmentCommit?.();releaseAttachmentCommit=undefined;dropAttachmentAck=false;holdAttachmentCommit=false;attachmentCommitHeld=false;attachmentManifests.length=0;
 for(const run of node.queryRuns.list())if(run.status==='running')node.queryRuns.cancel(run.id);
 releaseQuery?.();releaseQuery=undefined;holdNextQuery=false;failNextQuery=false;
 for(let i=0;activeQueries>0&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,20));
 seenAskRequests.length=0;askGetIds.length=0;dropAskAck=false;hideAskRuns=false;materialReads.length=0;changeMaterialOnStart=false;
 for(const run of node.insightRuns.list())if(run.status==='running')node.insightRuns.cancel(run.id);
 releaseGeneration?.();releaseGeneration=undefined;holdNext=false;
 if(node.store.evidence([noteId]).length)node.store.delete(noteId);
 noteId=randomUUID();ids=Array.from({length:67},()=>randomUUID()).sort().reverse();queryCalls=0;insightCalls=0;failNextConversationRead=false;lastQuery=null;seenRequests.length=0;dropAck=false;offline=false;
 await node.store.ingest(noteCapture({id:noteId,deviceId:'generated-discovery-phone',deviceName:'Generated discovery phone',platform:'android',capturedAt:'2026-10-01T00:00:00.000Z',text:'Generated original discovery record: completion remains unknown.',mood:'Generated explicit mood'}));
 publishMaterial();
 for(const [index,id] of ids.entries())node.store.saveInsight({runId:id,answer:'Generated native discovery '+index,citations:[{id:noteId,appName:'Generated discovery note',capturedAt:'2026-10-01T00:00:00.000Z',excerpt:'Completion remains unknown.'}],trace:[]},id);
 node.store.db.prepare('UPDATE insights SET created_at=?').run('2026-10-01T00:00:00.000Z');
}
await reset();
const server=createServer(async(req,res)=>{
 try{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const payload=Buffer.concat(chunks),url=req.url??'/';
  if(url.startsWith('/api/__fixture/')){
   if(req.headers.authorization!=='Bearer '+token){res.writeHead(401).end();return;}
   if(req.method==='POST'&&url==='/api/__fixture/reset')await reset();
   if(req.method==='POST'&&url==='/api/__fixture/inline-report'){
    const runId=randomUUID(),answer='**Generated exact inline report** ['+noteId+']\n\n'+Array.from({length:35},(_,index)=>'Generated full paragraph '+index+': completion remains unknown.').join('\n\n')+'\n\nFinal generated reference ['+noteId+']';
    node.store.saveInsight({runId,answer,citations:[{id:noteId,appName:'Generated discovery note',capturedAt:'2026-10-01T00:00:00.000Z',excerpt:'Completion remains unknown.'}],trace:[]},runId);
    res.setHeader('content-type','application/json');res.end(JSON.stringify({runId,noteId}));return;
   }
   if(req.method==='POST'&&url==='/api/__fixture/offline')offline=true;
   if(req.method==='POST'&&url==='/api/__fixture/online')offline=false;
   if(req.method==='POST'&&url==='/api/__fixture/drop-ack')dropAck=true;
   if(req.method==='POST'&&url==='/api/__fixture/drop-ask-ack')dropAskAck=true;
   if(req.method==='POST'&&url==='/api/__fixture/hide-ask')hideAskRuns=true;
   if(req.method==='POST'&&url==='/api/__fixture/show-ask')hideAskRuns=false;
   if(req.method==='POST'&&url==='/api/__fixture/fail-conversation-read')failNextConversationRead=true;
   if(req.method==='POST'&&url==='/api/__fixture/fail-query')failNextQuery=true;
   if(req.method==='POST'&&url==='/api/__fixture/hold-query')holdNextQuery=true;
   if(req.method==='POST'&&url==='/api/__fixture/release-query'){releaseQuery?.();releaseQuery=undefined;}
   if(req.method==='POST'&&url==='/api/__fixture/material-update')publishMaterial('Updated');
   if(req.method==='POST'&&url==='/api/__fixture/material-partial')publishMaterial('Partial',true);
   if(req.method==='POST'&&url==='/api/__fixture/material-asset-only')publishMaterial('Asset',false,true);
   if(req.method==='POST'&&url==='/api/__fixture/material-race')changeMaterialOnStart=true;
   if(req.method==='POST'&&url==='/api/__fixture/hold-material-read')holdNextMaterialRead=true;
   if(req.method==='POST'&&url==='/api/__fixture/release-material-read'){releaseMaterialRead?.();releaseMaterialRead=undefined;}
   if(req.method==='POST'&&url==='/api/__fixture/drop-attachment-ack')dropAttachmentAck=true;
   if(req.method==='POST'&&url==='/api/__fixture/hold-attachment-commit')holdAttachmentCommit=true;
   if(req.method==='POST'&&url==='/api/__fixture/release-attachment-commit'){releaseAttachmentCommit?.();releaseAttachmentCommit=undefined;}
   if(req.method==='POST'&&url==='/api/__fixture/hold-export')holdExport=true;
   if(req.method==='POST'&&url==='/api/__fixture/release-export'){releaseExport?.();releaseExport=undefined;}
   if(req.method==='POST'&&url==='/api/__fixture/hold-generation')holdNext=true;
   if(req.method==='POST'&&url==='/api/__fixture/release-generation'){releaseGeneration?.();releaseGeneration=undefined;}
   res.setHeader('content-type','application/json');res.end(JSON.stringify({noteId,nativeMaterialId,nativeMaterialRef,materialReads,materialReadHeld,exportHeld,attachmentManifests,attachmentCommitHeld,latestId:ids[0],oldId:ids[66],restrictedToken,queryCalls,insightCalls,lastQuery,seenRequests,seenAskRequests,askGetIds,activeQueries,activeGenerations,savedCount:node.store.insights({limit:100}).items.length}));return;
  }
  if(offline){req.socket.destroy();return;}
  if(failNextConversationRead&&req.method==='GET'&&/^\/api\/conversations\/[a-f0-9-]{36}(?:\?|$)/.test(url)){failNextConversationRead=false;res.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({error:'generated_conversation_read_unavailable'}));return;}
  if(req.method==='POST'&&url==='/api/insight-runs')seenRequests.push(JSON.parse(payload.toString()).requestId);
  if(req.method==='POST'&&url==='/api/query-runs')seenAskRequests.push(payload.toString());
  if(req.method==='POST'&&url==='/api/file-sync/v1/uploads')attachmentManifests.push(payload.toString());
  if(changeMaterialOnStart&&req.method==='POST'&&url==='/api/query-runs'){changeMaterialOnStart=false;publishMaterial('Changed before admission');}
  const askId=req.method==='GET'?/^\/api\/query-runs\/([a-f0-9-]{36})$/.exec(url)?.[1]:undefined;
  if(askId){askGetIds.push(askId);if(hideAskRuns){res.writeHead(404,{'content-type':'application/json'}).end(JSON.stringify({error:'not_found'}));return;}}
  const result=await node.app.inject({method:req.method as 'GET',url,headers:req.headers,payload:payload.length?payload:undefined});
  if(holdNextMaterialRead&&req.method==='GET'&&url.startsWith('/api/materials/')&&url.includes('/read?')){holdNextMaterialRead=false;materialReadHeld=true;await new Promise<void>(resolve=>releaseMaterialRead=resolve);materialReadHeld=false;}
  if(req.method==='POST'&&/^\/api\/file-sync\/v1\/uploads\/[^/]+\/commit$/.test(url)){
   if(holdAttachmentCommit){holdAttachmentCommit=false;attachmentCommitHeld=true;await new Promise<void>(resolve=>releaseAttachmentCommit=resolve);attachmentCommitHeld=false;}
   if(dropAttachmentAck&&result.statusCode>=200&&result.statusCode<300){dropAttachmentAck=false;res.writeHead(502,{'content-type':'application/json'}).end(JSON.stringify({error:'generated_attachment_receipt_lost'}));return;}
  }
  if(dropAskAck&&req.method==='POST'&&url==='/api/query-runs'&&result.statusCode===202){dropAskAck=false;res.writeHead(502,{'content-type':'application/json'}).end(JSON.stringify({error:'generated_ask_ack_lost'}));return;}
  if(dropAck&&req.method==='POST'&&url==='/api/insight-runs'&&result.statusCode===202){dropAck=false;res.writeHead(502,{'content-type':'application/json'}).end(JSON.stringify({error:'generated_ack_lost'}));return;}
  if(holdExport&&req.method==='GET'&&url.startsWith('/api/export-bundle?')){holdExport=false;exportHeld=true;await new Promise<void>(resolve=>releaseExport=resolve);exportHeld=false;}
  res.writeHead(result.statusCode,result.headers);res.end(result.rawPayload);
 }catch(error){res.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({error:String(error)}));}
});
server.listen(port,'127.0.0.1',()=>console.log('Generated native discovery fixture listening on '+port));
process.on('SIGTERM',()=>{server.close(()=>{void node.app.close().then(()=>rm(dataDir,{recursive:true,force:true})).then(()=>process.exit(0));});});
