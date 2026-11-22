import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../../server/src/app.js';
import type {ConfigurationPlatformOptions} from '../../server/src/config.js';

// Private generated fixture, with actual owner HTTP APIs and durable SQLite.
// The model alone is replaced; no provider or personal archive is contacted.
const ready=process.argv[2];if(!ready)throw Error('Private ready file required');
const dataDir=await mkdtemp(join(tmpdir(),'mote-desktop-conversation-service-')),token=randomUUID()+randomUUID();
const config:ConfigurationPlatformOptions={
 path:join(dataDir,'mote.yaml'),
 privateCredential:{token,tokenPath:'generated-only'},
 initialDocument:{
  version:1,revision:0,storage:{dataDir,maxExportBytes:1_000_000},
  server:{host:'127.0.0.1',port:0,allowedOrigins:[]},
  execution:{insightIntervalHours:0}
 }
};
const result=(answer:string)=>({answer,citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids:[] as string[]}});
const node=await buildApp(config,{webRoot:resolve('apps/web/dist'),backgroundWorker:false,agent:{configured:true,query:async()=>result('Generated continued response'),close:async()=>{}}});
const conversations=node.conversations;
const {id:conversationId}=conversations.main();
for(let index=1;index<=45;index++){
 conversations.append(conversations.get(conversationId),{question:'Generated question '+index},result('Generated answer '+index));
}
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
node.app.post('/fixture/advance-revision',async(request,reply)=>{
 if(request.headers.authorization!=='Bearer '+token)return reply.code(403).send({});
 conversations.append(conversations.get(conversationId),{question:'Generated other-client continuation'},result('Generated other-client answer'));
 return {revision:conversations.get(conversationId).revision};
});
await node.app.listen({host:'127.0.0.1',port:0});
const address=node.app.server.address();if(!address||typeof address==='string')throw Error('Missing fixture address');
await writeFile(ready,JSON.stringify({url:'http://127.0.0.1:'+address.port,token,conversationId}),{mode:0o600});
async function close(){await node.app.close();await rm(dataDir,{recursive:true,force:true});process.exit(0);}
process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
