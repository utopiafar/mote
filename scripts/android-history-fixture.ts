/** Generated native H01 history only. The agent is deterministic; storage, HTTP,
 * source revisions, owner deletion, privacy erasure and permission checks are real. */
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../apps/server/src/app.js';
const directory=await mkdtemp(join(tmpdir(),'mote-native-history-'));
const port=Number(process.env.MOTE_ANDROID_HISTORY_PORT??47887),address=`http://127.0.0.1:${port}`;
const token='generated-native-history-owner-token-123456',headers={authorization:'Bearer '+token};
let active:{sourceId:string;evidenceId:string;conversationId:string;title:string;workTitle:string;answer:string;olderAnswer:string;excerpt:string;olderExcerpt:string};
const node=await buildApp({dataDir:directory,token,tokenPath:'generated-only',host:'127.0.0.1',port,profile:'test',maxStorageBytes:32_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-fixture-model',modelBaseUrl:'https://fixture.invalid',apiKey:'generated-fixture-key',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async()=>result(active.answer,active.excerpt)}});
const restricted=await node.connections.mintMcp({serverUrl:address,label:'Generated history restricted client',access:'read'},{mcpEnabled:true,directory:'unused'});
const restrictedToken=restricted.config.mcpServers.mote.headers.Authorization.slice(7);
const item=(revision:string)=>({externalId:'generated-document',revision,observedAt:`2026-10-${revision==='1'?'01':'02'}T00:00:00Z`,title:'Generated immutable source '+revision,text:revision==='1'?active.excerpt:'Generated revised original; previous source ID remains immutable.',kind:'message',layer:'snapshot'});
function result(answer:string,excerpt:string){return {answer,citations:[{id:active.evidenceId,appName:'Generated history source',capturedAt:'2026-10-01T00:00:00Z',excerpt}],trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids:[active.evidenceId]}};}
async function reset(){
 const suffix=randomUUID();active={sourceId:'generated-history-'+suffix,evidenceId:'',conversationId:'',title:'Generated history '+suffix,workTitle:'Generated history work '+suffix,answer:'Generated latest retained answer '+suffix,olderAnswer:'Generated older retained answer '+suffix,excerpt:'Generated immutable historical evidence '+suffix,olderExcerpt:'Generated older excerpt '+suffix};
 node.sources.register({id:active.sourceId,name:'Generated historical source',kind:'custom',deviceId:'generated-history-phone',platform:'import'});
 active.evidenceId=(await node.sources.upsert(active.sourceId,item('1'))).id;
 const conversations=node.conversations;
 active.conversationId=conversations.append(undefined,{question:active.title},result(active.olderAnswer,active.olderExcerpt)).conversationId;
 // Preserve the prior real pagination scale: the older dependent turn is outside
 // the initial twenty-turn page, with unrelated generated turns in between.
 for(let i=0;i<27;i++)conversations.append(conversations.get(active.conversationId),{question:'Generated intervening question '+i},{answer:'Generated intervening answer '+i,citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[]}});
 const started=await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id:randomUUID(),input:{question:active.workTitle,conversationId:active.conversationId}}});
 if(started.statusCode!==202)throw Error(started.body);
 const runId=started.json().id,deadline=Date.now()+20_000;
 for(;;){const run=node.featureServices.queryRuns.get(runId);if(run.status==='completed')break;if(run.status==='failed'||Date.now()>deadline)throw Error(JSON.stringify(run));await new Promise(resolve=>setTimeout(resolve,25));}
}
await reset();
function state(){return {generatedOnly:true,address,controlAddress:address+'/api/__fixture/history',token,restrictedToken,...active};}
const server=createServer(async(req,res)=>{
 try{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const payload=Buffer.concat(chunks),url=req.url??'/';
  if(url.startsWith('/api/__fixture/history/')){
   if(req.headers.authorization!=='Bearer '+token){res.writeHead(401).end();return;}
   const action=url.slice('/api/__fixture/history/'.length);
   if(req.method==='POST'){
    if(action==='reset')await reset();
    else if(action==='stale')await node.sources.upsert(active.sourceId,item('2'));
    else if(action==='deleted'){
     const deleted=await node.app.inject({method:'DELETE',url:'/api/captures/'+active.evidenceId,headers});if(deleted.statusCode!==200)throw Error(deleted.body);
    }else if(action==='erase')node.store.invalidateConversationAnswers([active.evidenceId],true);
    else if(action!=='state')throw Error('Unknown generated history control');
   }
   res.setHeader('content-type','application/json');res.end(JSON.stringify(state()));return;
  }
  const response=await node.app.inject({method:req.method as 'GET',url,headers:req.headers,payload:payload.length?payload:undefined});
  res.writeHead(response.statusCode,response.headers);res.end(response.rawPayload);
 }catch(error){res.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({error:String(error)}));}
});
server.listen(port,'127.0.0.1',async()=>{if(process.env.MOTE_ANDROID_HISTORY_CONNECTION)await writeFile(process.env.MOTE_ANDROID_HISTORY_CONNECTION,JSON.stringify(state()),{mode:0o600});console.log('Generated native history fixture listening on '+port);});
process.on('SIGTERM',()=>server.close(()=>{void node.app.close().then(()=>rm(directory,{recursive:true,force:true})).then(()=>process.exit(0));}));
