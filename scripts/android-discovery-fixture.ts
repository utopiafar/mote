/** Dedicated generated-only native discovery server. The proxy can lose an ACK
 * after real admission; report publication, scope and cancellation remain real. */
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
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
let askConversationId='',detailCaptureId='',detailCaptureVersion='',detailCaptureDeviceId='generated-discovery-phone';
let contractNoteId='';
const at=(hour:number,minute:number)=>{const value=new Date();value.setHours(hour,minute,0,0);return value.toISOString();};
const receiptImage=sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="296" height="224"><rect width="296" height="224" fill="#e9e5dc"/><rect x="20" y="20" width="256" height="184" rx="4" fill="#f8f7f3"/><path d="M44 60h96M44 84h140M44 108h72M44 148h88" stroke="#3a3632" stroke-width="5" stroke-linecap="round"/><path d="M196 132l16 16 32-36" stroke="#b5432f" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>')).png().toBuffer();
let dropAttachmentAck=false,holdAttachmentCommit=false,attachmentCommitHeld=false,releaseAttachmentCommit:(()=>void)|undefined;
const attachmentManifests:string[]=[];
let holdExport=false,exportHeld=false,releaseExport:(()=>void)|undefined;
function publishMaterial(label='Original',partial=false,assetOnly=false){
 const asset=assetOnly?node.store.assets.put(Buffer.from('Generated asset-only original bytes')):undefined;
 const material=node.materials.publish({id:nativeMaterialId,kind:'mote.file',schemaVersion:1,title:'租房合同 2026.pdf',origin:{sourceId:'generated-native-material',externalId:'one',deviceId:'generated-discovery-phone',firstAt:at(14,20),lastAt:at(14,20)},members:[{id:noteId,kind:'capture',ref:'capture:'+noteId}],blocks:asset?[{id:'original-asset',kind:'asset' as const,hash:asset.hash,mimeType:'text/plain',memberIds:[noteId]}]:Array.from({length:partial?2:31},(_,index)=>({id:'paragraph-'+index,kind:'text' as const,format:'plain',text:label+' generated exact paragraph '+index,memberIds:[noteId]})),coverage:{state:partial?'partial':'complete',...(partial?{reason:'generated_unavailable_tail'}:{})},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}},{expectedRevision:node.materials.revisionForWrite(nativeMaterialId)});
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
 if(contractNoteId&&node.store.evidence([contractNoteId]).length)node.store.delete(contractNoteId);
 if(detailCaptureId&&node.store.evidence([detailCaptureId]).length)node.store.delete(detailCaptureId);
 for(const conversation of node.conversations.list({limit:100}).items)node.conversations.delete(conversation.id);
 askConversationId='';detailCaptureId='';detailCaptureVersion='';
 noteId=randomUUID();contractNoteId=randomUUID();ids=Array.from({length:67},()=>randomUUID()).sort().reverse();queryCalls=0;insightCalls=0;failNextConversationRead=false;lastQuery=null;seenRequests.length=0;dropAck=false;offline=false;
 await node.store.ingest(noteCapture({id:noteId,deviceId:'generated-discovery-phone',deviceName:'我的 iPhone',platform:'android',capturedAt:at(14,20),text:'Generated original discovery record: completion remains unknown.',mood:'Generated explicit mood'}));
 await node.store.ingest(noteCapture({id:contractNoteId,deviceId:'generated-contract',deviceName:'我的 iPhone',platform:'android',capturedAt:at(14,20),text:'第 4 页\n第四条 押金为两个月租金，租期结束时验收无损坏后退还。\n第五条 暖气费按实际用量分摊，月底前提交账单照片。'}));
 publishMaterial();
 detailCaptureId=randomUUID();
 await node.store.ingest({id:detailCaptureId,deviceId:detailCaptureDeviceId,deviceName:'我的 iPhone',platform:'android',capturedAt:at(14,20),source:'screen',durationMs:0,appId:'dev.mote.notes',appName:'记录',windowTitle:'',ocrText:'周四和房东确认：暖气费按实际用量分摊，月底前把账单照片发给他。押金下个月退，记得要收据。',imageMime:'image/png',imageBase64:(await receiptImage).toString('base64'),ocr:{status:'completed',updatedAt:at(14,25)},privacy:{excluded:false,redacted:false,mode:'none'}});
 node.store.db.prepare('UPDATE captures SET received_at=? WHERE id=?').run(at(14,22),detailCaptureId);
 const detail=JSON.parse(String(node.store.db.prepare('SELECT json FROM captures WHERE id=?').get(detailCaptureId)!.json));
 detailCaptureVersion=String(detail.libraryVersion??'');
 const detailCitation={id:detailCaptureId,appName:'记录',capturedAt:at(14,20),excerpt:'暖气费按实际用量分摊，月底前把账单照片发给他。'};
 for(const [index,question] of ['暖气费是怎么约定的？','押金是多少？'].entries())node.conversations.append(undefined,{anchorEvidenceIds:[detailCaptureId],question},{answer:'Generated detail reference answer for '+question,citations:[detailCitation],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[detailCaptureId]}});
 const receiptCitation={id:noteId,appName:'记录',title:'暖气费按实际用量分摊，月底前给账单照片',capturedAt:at(14,20),excerpt:'暖气费按实际用量分摊，月底前把账单照片发给他。'};
 const contractCitation={id:contractNoteId,appName:'租房合同 2026.pdf',title:'租房合同 2026.pdf',location:'第 4 页',capturedAt:at(14,20),excerpt:'第四条 押金为两个月租金，租期结束时验收无损坏后退还。'};
 const askScope={anchorMaterialRef:nativeMaterialRef};
 const first=node.conversations.append(undefined,{...askScope,question:'暖气费是怎么约定的？'},{answer:'按实际用量分摊['+noteId+']，月底前把账单照片发给房东['+noteId+']；押金下个月退，需要收据['+contractNoteId+']。',citations:[receiptCitation,contractCitation],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[noteId,contractNoteId]}});
 askConversationId=first.conversationId;
 node.conversations.append(node.conversations.get(askConversationId),{...askScope,question:'押金是多少？'},{answer:'合同第 4 页写的是两个月租金['+contractNoteId+']。',citations:[contractCitation],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[contractNoteId]}});
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
   res.setHeader('content-type','application/json');res.end(JSON.stringify({noteId,contractNoteId,nativeMaterialId,nativeMaterialRef,materialReads,materialReadHeld,exportHeld,attachmentManifests,attachmentCommitHeld,latestId:ids[0],oldId:ids[66],restrictedToken,queryCalls,insightCalls,lastQuery,seenRequests,seenAskRequests,askGetIds,activeQueries,activeGenerations,savedCount:node.store.insights({limit:100}).items.length,askConversationId,detailCaptureId,detailCaptureVersion,detailCaptureDeviceId}));return;
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
