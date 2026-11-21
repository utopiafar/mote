import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import {buildApp} from '../../server/src/app.js';
import type {ConfigurationPlatformOptions} from '../../server/src/config.js';
import {Conversations} from '../../server/src/conversations.js';

// Generated main/wire-1 host for the real Android ASK and Activity readers.
// A generated agent adapter supplies answers; stored turns, operations, paging
// and evidence invalidation/deletion use the production application lifecycle.
const output=resolve(process.argv[2]??join(tmpdir(),'mote-main-history-fixture.json'));
const directory=await mkdtemp(join(tmpdir(),'mote-main-history-'));
const token=randomBytes(32).toString('hex'),observedAt=new Date().toISOString();
let original='',artifactId='',generation=0,modelCalls=0,conversationId='',workId='',closing=false;
const agent={configured:true,close:async()=>{},query:async(_input:QueryInput)=>{
 modelCalls++;const index=(modelCalls-1)%21+1,number=String(index).padStart(2,'0');
 return {answer:`GENERATED_HISTORY_ANSWER_${generation}_${number}`,citations:[{id:original,capturedAt:observedAt,appName:'Generated Android history source',excerpt:`GENERATED_HISTORY_CITATION_${number}`}],trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids:[artifactId,original]}};
}};
const config:ConfigurationPlatformOptions={path:(directory)+'/mote.yaml',privateCredential:{token:token,tokenPath:'generated-fixture'},initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}}}};
const node=await buildApp(config,{backgroundWorker:false,agent});
const storedConversations=new Conversations(node.store);
const address=await node.app.listen({host:'127.0.0.1',port:0});
const headers={authorization:'Bearer '+token,'content-type':'application/json'};
async function request(path:string,body?:unknown){const response=await fetch(address+path,{headers,...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});const value=await response.json() as any;assert.equal(response.status,200,JSON.stringify({path,status:response.status,error:value.error}));return value;}
const history=()=>request('/api/conversations/'+conversationId+'?limit=20');
async function metadata(){
 const current=await history(),older=current.nextCursor?await request('/api/conversations/'+conversationId+'?limit=20&cursor='+encodeURIComponent(current.nextCursor)):current;
 const latest=current.turns.at(-1),first=older.turns[0],work=await request('/api/work-activity/'+encodeURIComponent(workId));
 return {address,token,controlAddress,conversationId,workId,title:current.title,workTitle:work.goal,answer:latest.result?.answer??'',excerpt:latest.result?.citations[0]?.excerpt??'',olderQuestion:first.question,olderAnswer:first.result?.answer??'',olderExcerpt:first.result?.citations[0]?.excerpt??'',evidenceStale:latest.evidenceStale===true,evidenceDeleted:latest.evidenceDeleted===true,turnCount:current.turnCount,workArtifacts:work.artifacts.length,modelCalls};
}
async function reset(){
 generation++;modelCalls=0;original=randomUUID();artifactId=createHash('sha256').update('generated-history-'+generation).digest('hex');
 if(conversationId)storedConversations.delete(conversationId);
 conversationId=(await request('/api/conversations/main')).id;
 await node.store.ingest({id:original,deviceId:'generated-android-history',deviceName:'Generated Android history',platform:'import',source:'note',capturedAt:observedAt,durationMs:0,ocrText:Array.from({length:21},(_,i)=>'GENERATED_HISTORY_CITATION_'+String(i+1).padStart(2,'0')).join('\n')});
 save();
 for(let index=1;index<=21;index++){
  const response=await request('/api/query',{question:'Generated Android history '+generation+' turn '+String(index).padStart(2,'0'),conversationId});conversationId=response.conversationId;
 }
 const runs=(await request('/api/query-runs')).items.filter((run:any)=>run.conversationId===conversationId);assert.ok(runs.length);workId='query:'+runs[0].id;
 const value=await metadata();assert.equal(value.turnCount,21);assert.ok(value.answer&&value.excerpt&&value.olderAnswer&&value.olderExcerpt);assert.ok(value.workArtifacts>0);await writeFile(output,JSON.stringify(value,null,2),{mode:0o600});return value;
}
function save(revision='1'.repeat(64)){
 return node.store.archive.save(artifactId,'generated-history-'+generation,revision,{kind:'semantic',text:'Generated historical interpretation '+revision[0],metadata:{}},[{id:original,fingerprint:node.store.archive.fingerprint(original)!}],'generated-history-fixture','1','generated');
}
const control=createServer((req,res)=>{void(async()=>{
 for await(const _ of req){}
 if(req.method!=='POST'){res.writeHead(405).end();return;}
 if(req.url==='/reset'){const value=await reset();res.setHeader('content-type','application/json');res.end(JSON.stringify(value));return;}
 if(req.url==='/stale'){save('2'.repeat(64));const value=await history();assert.ok(value.turns.every((turn:any)=>turn.evidenceStale&&!turn.evidenceDeleted));}
 else if(req.url==='/deleted'){node.store.delete(original);const value=await history();assert.ok(value.turns.every((turn:any)=>turn.evidenceDeleted&&!turn.evidenceStale));assert.doesNotMatch(JSON.stringify(value),/GENERATED_HISTORY_(?:ANSWER|CITATION)/);}
 else if(req.url!=='/state'){res.writeHead(404).end();return;}
 res.setHeader('content-type','application/json');res.end(JSON.stringify(await metadata()));
})().catch(error=>{process.stderr.write(String(error.stack??error)+'\n');res.writeHead(500,{'content-type':'application/json'}).end('{"error":"generated_history_fixture_failed"}');});});
await new Promise<void>(done=>control.listen(0,'127.0.0.1',done));
const bound=control.address();assert.ok(bound&&typeof bound!=='string');const controlAddress='http://127.0.0.1:'+bound.port;
const initial=await reset();
const self=await request('/api/connections/self');assert.equal(self.credential.scope,'owner');
process.stdout.write(JSON.stringify({address,controlAddress,fixtureFile:output,pid:process.pid,conversationId,workId,turnCount:initial.turnCount,generatedOnly:true})+'\n');
async function close(){if(closing)return;closing=true;control.closeAllConnections();await new Promise<void>(done=>control.close(()=>done()));await node.app.close();await rm(directory,{recursive:true,force:true});process.stdout.write('{"generatedOnly":true,"closed":true}\n');process.exit(0);}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
