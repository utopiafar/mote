import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {originalEvidenceReceipt,parseAnswer,type QueryInput} from '@mote/agent';
import type {SourceContextDeclaration} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {SourceContextStore} from '../src/source-context.js';
import {withFixtureOwnerModelWork} from './fixtures/model-authorization.js';

const token='generated-query-plugin-owner',headers={authorization:`Bearer ${token}`};
const config=(dataDir:string):Config=>({dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''});
const original={id:'00000000-0000-4000-8000-000000000301',deviceId:'generated-query-plugin-device',deviceName:'Generated fixture',platform:'import' as const,source:'note' as const,capturedAt:'2026-09-20T01:00:00Z',durationMs:0,ocrText:'Generated original: the sample project selected a durable query plugin.'};

test('HTTP preparation feeds context, attachments and source pins through the Agent runtime into the conversation receipt',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'mote-query-plugin-')),seen:QueryInput[]=[];
  let pin:SourceContextDeclaration;
  const node=await buildApp(config(dataDir),{backgroundWorker:false,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
    seen.push(input);
    const citationId=input.evidenceIds?.[0];
    const receipt=citationId?originalEvidenceReceipt((await reader.evidence({ids:[citationId]}))[0],0,original.ocrText.length):undefined;
    const citations=receipt?[receipt]:[];
    return {...parseAnswer(JSON.stringify({answer:receipt?`Generated answer grounded in the original [${receipt.id}]`:'Generated follow-up answer',citationIds:receipt?[receipt.id]:[]}),new Map(receipt?[[receipt.id,receipt]]:[])),trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids:receipt?[receipt.id]:[]},...(seen.length===1?{sourceContextDependencies:[pin]}:{})};
  }})});
  t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  await node.store.ingest(original);
  node.sources.register({id:'generated-query-plugin-source',name:'Generated source',kind:'local-files',deviceId:'generated-query-plugin-device',platform:'android'});
  node.sources.updateContext('generated-query-plugin-source',{expectedVersion:0,description:'Generated phone calls; I am one participant.'});
  pin=new SourceContextStore(node.store).identity('generated-query-plugin-source')!;
  const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#224466'}}).png().toBuffer(),hash=createHash('sha256').update(bytes).digest('hex');
  node.sources.register({id:'generated-query-plugin-upload',name:'Generated upload',kind:'upload',deviceId:'generated-query-plugin-device',platform:'import',retention:'archive'});
  const upload=node.files.begin({sourceId:'generated-query-plugin-upload',item:{externalId:'generated-image',revision:'1',observedAt:'2026-09-24T01:00:00Z',title:'Generated image',kind:'file',layer:'original',text:'',mimeType:'image/png'},sha256:hash,sizeBytes:bytes.length},()=>{});
  node.files.part(upload.uploadId,0,bytes,()=>{});const attachmentId=(await node.files.commit(upload.uploadId,()=>{})).captureId;

  const first=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Inspect the generated original and image',evidenceIds:[original.id],attachmentIds:[attachmentId]}});
  assert.equal(first.statusCode,200,first.body);const conversationId=first.json().conversationId as string;
  assert.equal(seen.length,1);
  assert.deepEqual(seen[0].evidenceIds,[original.id]);
  assert.deepEqual(seen[0].directImages?.map(image=>image.id),[attachmentId]);
  assert.ok(seen[0].contextEvidenceDependencies?.ids.includes(original.id));
  const page=(await node.app.inject({url:`/api/conversations/${conversationId}`,headers})).json() as {turns:{question:string;answer:string;attachments:{id:string}[];result:{citations:{id:string;excerpt:string}[];sourceContextDependencies?:SourceContextDeclaration[];evidenceDependencies?:{ids:string[]}}}[]};
  assert.equal(page.turns[0]!.question,'Inspect the generated original and image');
  assert.equal(page.turns[0]!.attachments[0]!.id,attachmentId);
  assert.equal(page.turns[0]!.result.citations[0]!.id,original.id);
  assert.match(page.turns[0]!.result.citations[0]!.excerpt,/Generated original/);
  assert.deepEqual(page.turns[0]!.result.sourceContextDependencies,[pin]);
  assert.ok(page.turns[0]!.result.evidenceDependencies!.ids.includes(original.id));
  assert.equal((await node.app.inject({url:`/api/conversations/${conversationId}/references/${original.id}`,headers})).statusCode,200);

  const followup=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Continue with the generated context',conversationId,attachmentIds:[attachmentId]}});
  assert.equal(followup.statusCode,200,followup.body);
  assert.equal(seen.length,2);
  assert.equal(seen[1]!.conversation?.turns[0]?.answer,'Generated answer grounded in the original [00000000-0000-4000-8000-000000000301]');
  assert.deepEqual(seen[1]!.contextSourceContextDependencies,[pin]);
  assert.deepEqual(seen[1]!.directImages?.map(image=>image.id),[attachmentId]);

  const malformed=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated malformed attachment',attachmentIds:['not-a-uuid']}});
  assert.equal(malformed.statusCode,400,malformed.body);
});


test('the query runtime quiesces, stops and reopens the same profile without restarting',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'mote-query-runtime-lifecycle-'));let calls=0;
  const result=()=>({answer:'Generated lifecycle answer',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids:[] as string[]}});
  let node=await buildApp(config(dataDir),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async()=>{calls++;return result();}}});
  t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  const run=()=>withFixtureOwnerModelWork(node,()=>node.query.queryAgent({question:'Generated runtime lifecycle question'}));
  await run();assert.equal(calls,1);
  node.queryServices.quiesce('disabled');
  await assert.rejects(run(),{statusCode:503});
  await node.queryServices.stop('disabled');
  await assert.rejects(run(),{statusCode:503});
  await node.queryServices.start();
  await run();assert.equal(calls,2);
  await node.app.close();
  node=await buildApp(config(dataDir),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async()=>{calls++;return result();}}});
  await run();assert.equal(calls,3);
});
