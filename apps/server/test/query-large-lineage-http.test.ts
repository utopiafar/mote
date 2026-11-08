import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {buildApp} from '../src/app.js';
import {materialId} from '../src/materials.js';
import type {Config} from '../src/config.js';

for(const mutation of ['lease-renewal','delete-during-validation','delete-during-provider'] as const)test(`a large existing conversation completes actual HTTP continuation with ${mutation} and exact private dependencies`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-large-query-lineage-')),token='generated-large-query-owner',headers={authorization:'Bearer '+token};
 let node!:Awaited<ReturnType<typeof buildApp>>,providerStarts=0,victim='',deleted=false;
 const endpoint=createServer(async(req,res)=>{
  let raw='';for await(const bytes of req)raw+=bytes;const body=JSON.parse(raw);providerStarts++;
  assert.ok(!JSON.stringify(body).includes('evidenceDependencies'),'private dependencies never become model evidence');
  if(mutation==='lease-renewal')await delay(31_000);
  if(mutation==='delete-during-provider'){deleted=true;node.store.delete(victim);}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const send=(value:unknown)=>res.write('data: '+JSON.stringify(value)+'\n\n');
  send({id:'generated-large-'+providerStarts,choices:[{index:0,delta:{role:'assistant',content:JSON.stringify({answer:'Generated supported continuation.',citationIds:[]})},finish_reason:null}]});
  send({id:'generated-large-'+providerStarts,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}});res.end('data: [DONE]\n\n');
 });await new Promise<void>(resolve=>endpoint.listen(0,'127.0.0.1',resolve));
 const config:Config={dataDir:directory,token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:60_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-provider',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:`http://127.0.0.1:${(endpoint.address() as {port:number}).port}/v1`,apiKey:'generated-fixture-only',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 node=await buildApp(config,{backgroundWorker:false});await node.app.ready();
 t.after(async()=>{await node.app.close();endpoint.closeAllConnections();await new Promise<void>(resolve=>endpoint.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});});
 const dependencies:string[]=[];
 for(let index=0;index<3;index++){
  const sourceId='generated-large-'+index,id=randomUUID(),texts=Array.from({length:2730},(_,line)=>`Generated ${index} paragraph ${line}.`);if(index===0)victim=id;
  node.sources.register({id:sourceId,name:'Generated large source',kind:'custom',deviceId:'generated',platform:'import'});
  await node.store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:texts.join('\n')});
  const material=node.materials.publish({id:materialId(sourceId,'generated-paragraphs'),kind:'mote.note',schemaVersion:1,title:'Generated long original',origin:{sourceId,externalId:'generated-paragraphs',deviceId:'generated'},members:[{id,kind:'capture',ref:'capture:'+id}],blocks:texts.map((text,line)=>({id:'line-'+line,kind:'text' as const,format:'plain',text,memberIds:[id]})),coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
  dependencies.push(id,...node.materials.evidenceIds(material.ref));
 }
 assert.equal(dependencies.length,8193);
 const saved=node.conversations.append(undefined,{question:'Generated previous overview'},{answer:'Generated previous overview.',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:dependencies}});
 const reader=node.featureServices.evidenceReader,validate=reader.contextDependenciesAllowed.bind(reader);let metadataChecks=0;
 reader.contextDependenciesAllowed=(ids,policy)=>{metadataChecks++;const allowed=validate(ids,policy);
  if(mutation==='delete-during-validation'&&ids.length===256&&!deleted){deleted=true;setImmediate(()=>node.store.delete(victim));}
  return allowed;
 };
 const started=performance.now(),response=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated follow-up',conversationId:saved.conversationId}});
 if(mutation!=='lease-renewal'){assert.equal(response.statusCode,409,response.body);assert.equal(deleted,true);assert.equal(providerStarts,mutation==='delete-during-validation'?0:1);return;}
 assert.equal(response.statusCode,200,response.body);assert.equal(providerStarts,1,'lease renewal never repeats a submitted provider call');
 assert.ok(performance.now()-started>=31_000);assert.ok(metadataChecks>32,'the entire authorization set is processed, with scheduling yields');
 assert.equal(response.json().evidenceDependencies.complete,true);assert.deepEqual(new Set(response.json().evidenceDependencies.ids),new Set(dependencies));
 const execution=node.store.db.prepare("SELECT state,attempts,lease_until-created_at leaseAge FROM execution_steps WHERE kind='delegation.coordinator.query' ORDER BY rowid DESC LIMIT 1").get()!;
 assert.equal(execution.state,'succeeded');assert.equal(execution.attempts,1);assert.ok(Number(execution.leaseAge)>30_000,'the existing 30s lease was renewed through its regular timer');
});
