import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {buildApp} from '../../server/src/app.js';
import type {Config} from '../../server/src/config.js';
import type {QueryInput} from '@mote/agent';
const ready=process.argv[2];if(!ready)throw Error('Private ready file required');
const dataDir=await mkdtemp(join(tmpdir(),'mote-scope-service-')),token=randomUUID()+randomUUID();
const config:Config={dataDir,token,tokenPath:'generated-only',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
const seen:{question:string;evidenceIds?:string[]|null;anchorEvidenceIds?:string[]|null}[]=[];
const answer=()=>({answer:'Generated scope response',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids:[] as string[]}});
const node=await buildApp(config,{webRoot:resolve('apps/web/dist'),backgroundWorker:false,agent:{configured:true,query:async(input:QueryInput)=>{seen.push({question:input.question,evidenceIds:input.evidenceIds,anchorEvidenceIds:input.anchorEvidenceIds});return answer();},close:async()=>{}}});
let failure=0;
node.app.addHook('onRequest',async(request,reply)=>{
 if(request.url.startsWith('/fixture/')){
  if(request.headers.authorization!=='Bearer '+token)return reply.code(403).send({});
  if(request.url==='/fixture/seen')return reply.send(seen);
  if(request.url==='/fixture/fail'){failure=Number((request.headers['x-fixture-status']??403));return reply.send({ok:true});}
 }
 if(failure&&request.url.startsWith('/api/conversations')){const code=failure;failure=0;return reply.code(code).send({error:'Generated unavailable scope'});}
});
const headers={authorization:'Bearer '+token};
const evidenceIds:string[]=[];
for(let i=0;i<2;i++){
 const id=randomUUID();evidenceIds.push(id);
 const response=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-scope',deviceName:'Generated scope',platform:'android',capturedAt:'2026-10-01T00:00:00Z',text:'Generated scope original '+i}});assert.equal(response.statusCode,201,response.body);
}
await node.materialOrganizer.tick(100);
const ids:Record<string,string>={};
for(const kind of ['anchor','strict','plain']){
 const scope=kind==='anchor'?{anchorEvidenceIds:[evidenceIds[0]]}:kind==='strict'?{evidenceIds:[evidenceIds[1]]}:{};
 const response=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated '+kind,...scope}});assert.equal(response.statusCode,200,response.body);
 ids[kind]=response.json().conversationId;
 assert.ok(ids[kind],response.body);
 if(kind==='anchor')for(let i=1;i<21;i++)node.featureServices.conversations.append(node.featureServices.conversations.get(ids[kind]),{question:'Generated anchor older '+i,...scope},answer());
}
await node.app.listen({host:'127.0.0.1',port:0});
const address=node.app.server.address();if(!address||typeof address==='string')throw Error('Missing address');
await writeFile(ready,JSON.stringify({url:'http://127.0.0.1:'+address.port,token,ids,evidenceIds}),{mode:0o600});
async function close(){await node.app.close();await rm(dataDir,{recursive:true,force:true});process.exit(0);}
process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
