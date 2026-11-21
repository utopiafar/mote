import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../../server/src/app.js';
import type {Config} from '../../server/src/config.js';

// Private generated fixture, with actual owner HTTP APIs and durable SQLite.
// The model alone is replaced; no provider or personal archive is contacted.
const ready=process.argv[2];if(!ready)throw Error('Private ready file required');
const dataDir=await mkdtemp(join(tmpdir(),'mote-desktop-conversation-service-')),token=randomUUID()+randomUUID();
const config:Config={dataDir,token,tokenPath:'generated-only',host:'127.0.0.1',port:0,maxExportBytes:1_000_000,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
const result=(answer:string)=>({answer,citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids:[] as string[]}});
const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,query:async()=>result('Generated continued response'),close:async()=>{}}});
const conversations=node.conversations;
let conversation:ReturnType<typeof conversations.get>|undefined;
for(let index=1;index<=45;index++){
 const saved=conversations.append(conversation,{question:'Generated question '+index},result('Generated answer '+index));
 conversation=conversations.get(saved.conversationId);
}
const conversationId=conversation!.id;
const conversationPath=['','api','conversations',conversationId].join('/');
let failNextPage=false;
node.app.addHook('onRequest',async(request,reply)=>{
 if(request.url==='/fixture/fail-next-page'&&request.method==='POST'){if(request.headers.authorization!=='Bearer '+token)return reply.code(403).send({});failNextPage=true;return reply.send({ok:true});}
 if(failNextPage&&request.method==='GET'){
  const url=new URL(request.url,'http://fixture');
  if(url.pathname===conversationPath&&url.searchParams.has('cursor')){
   failNextPage=false;
   return reply.code(503).send({error:'Generated temporary read failure'});
  }
 }
});
await node.app.listen({host:'127.0.0.1',port:0});
const address=node.app.server.address();if(!address||typeof address==='string')throw Error('Missing fixture address');
await writeFile(ready,JSON.stringify({url:'http://127.0.0.1:'+address.port,token,conversationId}),{mode:0o600});
async function close(){await node.app.close();await rm(dataDir,{recursive:true,force:true});process.exit(0);}
process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
