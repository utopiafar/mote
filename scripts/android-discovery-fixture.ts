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
const dataDir=await mkdtemp(join(tmpdir(),'mote-native-discovery-')),port=Number(process.env.MOTE_DISCOVERY_FIXTURE_PORT ?? 47886),token='generated-native-discovery-owner-token';
let noteId=randomUUID(),ids:string[]=[],queryCalls=0,insightCalls=0,dropAck=false,lastQuery:unknown=null;
let offline=false;
let holdNext=false,releaseGeneration:(()=>void)|undefined,activeGenerations=0;
const seenRequests:string[]=[];
function agent(reader:ContextReader):QueryAgent{return {configured:true,close:async()=>{},query:async input=>{
 const evidenceIds=input.anchorEvidenceIds??input.evidenceIds??[noteId];
 const records=await reader.evidence({ids:evidenceIds});if(records.length!==evidenceIds.length)throw Error('Generated fixture evidence is not actually readable');
 const citations=records.map(row=>({id:row.id,appName:row.appName,capturedAt:row.capturedAt,excerpt:row.ocrText}));
 if(input.skill==='personal-insight'){
  insightCalls++;activeGenerations++;
  if(holdNext){holdNext=false;await new Promise<void>(resolve=>releaseGeneration=resolve);}else await new Promise(resolve=>setTimeout(resolve,2500));
  activeGenerations--;
  return {answer:JSON.stringify({title:'Generated native report',markdown:'Generated native conclusion remains uncertain. ['+records[0].id+']',html:'<p>Generated native conclusion remains uncertain.</p>'}),citations,trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:evidenceIds}};
 }
 queryCalls++;lastQuery={question:input.question,anchorEvidenceIds:input.anchorEvidenceIds??null,evidenceIds:input.evidenceIds??null};
 return {answer:'Generated answer from the actual original: '+records.map(row=>row.ocrText+' ['+row.id+']').join('\n'),citations,trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:evidenceIds}};
}};}
const node=await buildApp({dataDir,token,tokenPath:'fixture-only',host:'127.0.0.1',port,profile:'test',maxStorageBytes:32_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-fixture-model',modelBaseUrl:'https://fixture.invalid',apiKey:'generated-fixture-key',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false,createModelAgent:async(_settings,reader)=>agent(reader)});
const restricted=await node.connections.mintMcp({serverUrl:'http://127.0.0.1:'+port,label:'Generated read-only Agent',access:'read'},{mcpEnabled:true,directory:'unused'});
const restrictedToken=restricted.config.mcpServers.mote.headers.Authorization.slice(7);
async function reset(){
 for(const run of node.insightRuns.list())if(run.status==='running')node.insightRuns.cancel(run.id);
 releaseGeneration?.();releaseGeneration=undefined;holdNext=false;
 if(node.store.evidence([noteId]).length)node.store.delete(noteId);
 noteId=randomUUID();ids=Array.from({length:67},()=>randomUUID()).sort().reverse();queryCalls=0;insightCalls=0;lastQuery=null;seenRequests.length=0;dropAck=false;offline=false;
 await node.store.ingest(noteCapture({id:noteId,deviceId:'generated-discovery-phone',deviceName:'Generated discovery phone',platform:'android',capturedAt:'2026-10-01T00:00:00.000Z',text:'Generated original discovery record: completion remains unknown.',mood:'Generated explicit mood'}));
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
   if(req.method==='POST'&&url==='/api/__fixture/offline')offline=true;
   if(req.method==='POST'&&url==='/api/__fixture/online')offline=false;
   if(req.method==='POST'&&url==='/api/__fixture/drop-ack')dropAck=true;
   if(req.method==='POST'&&url==='/api/__fixture/hold-generation')holdNext=true;
   if(req.method==='POST'&&url==='/api/__fixture/release-generation'){releaseGeneration?.();releaseGeneration=undefined;}
   res.setHeader('content-type','application/json');res.end(JSON.stringify({noteId,latestId:ids[0],oldId:ids[66],restrictedToken,queryCalls,insightCalls,lastQuery,seenRequests,activeGenerations,savedCount:node.store.insights({limit:100}).items.length}));return;
  }
  if(offline){req.socket.destroy();return;}
  if(req.method==='POST'&&url==='/api/insight-runs')seenRequests.push(JSON.parse(payload.toString()).requestId);
  const result=await node.app.inject({method:req.method as 'GET',url,headers:req.headers,payload:payload.length?payload:undefined});
  if(dropAck&&req.method==='POST'&&url==='/api/insight-runs'&&result.statusCode===202){dropAck=false;res.writeHead(502,{'content-type':'application/json'}).end(JSON.stringify({error:'generated_ack_lost'}));return;}
  res.writeHead(result.statusCode,result.headers);res.end(result.rawPayload);
 }catch(error){res.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({error:String(error)}));}
});
server.listen(port,'127.0.0.1',()=>console.log('Generated native discovery fixture listening on '+port));
process.on('SIGTERM',()=>{server.close(()=>{void node.app.close().then(()=>rm(dataDir,{recursive:true,force:true})).then(()=>process.exit(0));});});
