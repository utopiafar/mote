import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {staticReportHtml} from '../src/insights.js';
import type {Config} from '../src/config.js';
import type {QueryInput} from '@mote/agent';

const config=(dataDir:string):Config=>({dataDir,token:'synthetic-central-workflow-token',tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false});
const original='合成记录：我准备下周验证观测方案。';
async function until<T>(read:()=>Promise<T>,done:(value:T)=>boolean):Promise<T>{for(let index=0;index<100;index++){const value=await read();if(done(value))return value;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Fixture workflow did not finish');}

test('central UI APIs complete original import → exact Memory → cited static insight with recoverable jobs',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-central-workflow-')),cfg=config(directory),queries:QueryInput[]=[];
  let failMemory=true,evidenceId='';
  const node=await buildApp(cfg,{prepareImport:async({workspace,inputPaths})=>{
    writeFileSync(join(workspace,'records.jsonl'),JSON.stringify({item:{externalId:'journal:42',revision:'fixture-revision',observedAt:'2026-09-16T00:00:00Z',title:'观测计划',text:original,kind:'file',layer:'original',document:{recordedAt:'2020-02-03T04:05:00Z',timeBasis:'recorded',contentRole:'authored',originalMetadata:{providerId:42,tags:['合成资料']}}},evidencePaths:inputPaths}));
    writeFileSync(join(workspace,'dispositions.json'),JSON.stringify({items:inputPaths.map(path=>({path,status:'parsed',reason:'synthetic plain text'}))}));
    return {summary:'识别到一条合成原始日记；记录时间来自原始字段。'};
  },agent:{configured:true,close:async()=>{},query:async input=>{
    queries.push(input);
    if(input.skill==='memory-extraction'){
      if(failMemory){failMemory=false;throw Error('Synthetic transient failure');}
      evidenceId=input.evidenceIds![0];assert.deepEqual(input.evidenceRanges,[{id:evidenceId,offset:0,length:original.length}]);
      return {answer:JSON.stringify({memories:[{title:'计划验证观测方案',statement:`作者计划下周验证观测方案。[${evidenceId}]`,uncertainty:'是否完成未知。',evidenceIds:[evidenceId],evidence:[{id:evidenceId,offset:0,quote:original}]}]}),citations:[{id:evidenceId,capturedAt:'2026-09-16T00:00:00Z',appName:'合成导入',excerpt:original}],trace:[],runId:randomUUID()};
    }
    assert.equal(input.skill,'personal-insight');assert.equal(input.question,'回顾我的观测计划');
    return {answer:JSON.stringify({title:'观测计划回顾',markdown:`有一条计划记录，完成情况未知。[${evidenceId}]`,html:`<!doctype html><html><head><style>body{color:#234;font-family:system-ui}.card{padding:24px}</style></head><body><section class="card"><h1>观测计划</h1><p>完成情况未知。[${evidenceId}]</p></section><script>top.fixtureUnsafe=true</script><img src="https://untrusted.invalid/tracker"><a href="https://untrusted.invalid">bad link</a><meta http-equiv="refresh" content="0;url=https://untrusted.invalid"></body></html>`}),citations:[{id:evidenceId,capturedAt:'2026-09-16T00:00:00Z',appName:'合成导入',excerpt:original}],trace:[],runId:randomUUID()};
  }}});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${cfg.token}`},request=(method:'GET'|'POST',url:string,payload?:unknown)=>node.app.inject({method,url,headers,payload:payload as any});
  assert.equal((await node.app.inject('/api/imports')).statusCode,401);
  assert.equal((await request('GET','/api/skills')).json().items.length,3);
  const uploaded=await request('POST','/api/imports',{name:'合成通用资料',instruction:'导入原始日记',files:[{name:'journal.custom',dataBase64:Buffer.from(original).toString('base64')}]});
  assert.equal(uploaded.statusCode,202,uploaded.body);const id=uploaded.json().id;
  const preview=await until(async()=>(await request('GET',`/api/imports/${id}`)).json(),job=>job.status==='awaiting_confirmation');
  assert.equal(node.store.list().items.length,0);assert.equal(preview.preview.count,1);assert.equal(preview.dispositions.counts.parsed,1);
  assert.equal((await request('POST',`/api/imports/${id}/confirm`)).statusCode,202);
  const imported=await until(async()=>(await request('GET',`/api/imports/${id}`)).json(),job=>job.status==='completed');
  assert.equal(imported.progress.imported,1);assert.equal(imported.captureIds.length,1);
  const memory=await until(async()=>(await request('GET',`/api/memory-jobs/${imported.memoryJobId}`)).json(),job=>job.status==='failed');
  assert.equal(memory.failedBatches,1);assert.equal(node.store.list().items.length,1);
  assert.equal((await request('POST',`/api/memory-jobs/${memory.id}/retry`)).statusCode,202);
  const completed=await until(async()=>(await request('GET',`/api/memory-jobs/${memory.id}`)).json(),job=>job.status==='completed');
  assert.equal(completed.memoryIds.length,1);assert.equal(node.store.list().items.length,1);
  const detail=(await request('GET',`/api/memories/${completed.memoryIds[0]}`)).json();
  assert.equal(detail.status,'proposed');assert.equal(detail.evidence[0].quote,original);assert.equal(detail.evidence[0].recordedAt,'2020-02-03T04:05:00Z');assert.equal(detail.evidence[0].fileId,imported.files[0].id);
  const download=await request('GET',`/api/archived-files/${detail.evidence[0].fileId}/content`);assert.equal(download.body,original);assert.match(download.headers['content-disposition'] as string,/attachment/);
  assert.equal(node.store.list({after:'2020-02-01T00:00:00Z',before:'2020-03-01T00:00:00Z'}).items.length,1);
  const generated=await request('POST','/api/insights',{prompt:'回顾我的观测计划',timeZone:'Asia/Shanghai'});assert.equal(generated.statusCode,200,generated.body);
  const report=generated.json();assert.equal(report.artifact.skillId,'personal-insight');assert.equal(report.artifact.title,'观测计划回顾');assert.match(report.answer,/完成情况未知/);
  assert.doesNotMatch(report.artifact.html,/<script|<img|http-equiv="refresh"|href="https:/i);assert.match(report.artifact.html,/Content-Security-Policy/);
  assert.equal((await request('GET','/api/insights')).json().items[0].artifact.id,report.runId);
  assert.equal(queries.filter(q=>q.skill==='memory-extraction').length,2);
});

test('static reports retain layout and only approved evidence links',()=>{
  const id=randomUUID(),html=staticReportHtml(`<style>p{color:green}</style><p onclick="evil()" style="font-weight:600">safe</p><a href="#evidence-${id}">source</a><a href="#evidence-missing">unknown</a><iframe srcdoc="bad"></iframe><base href="https://bad.invalid"><form action="https://bad.invalid">submit</form>`,[id]);
  assert.match(html,/color:green/);assert.match(html,new RegExp(`href="#evidence-${id}"`));assert.doesNotMatch(html,/onclick|<iframe|<base|<form|href="#evidence-missing"/);
});

test('an import with historical revisions completes and extracts only the newly current version',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-import-history-')),cfg=config(directory),seen:QueryInput[]=[];
  const node=await buildApp(cfg,{prepareImport:async({workspace,inputPaths})=>{
    writeFileSync(join(workspace,'records.jsonl'),[1,2].map(revision=>JSON.stringify({item:{externalId:'same-object',revision:String(revision),observedAt:`2020-01-0${revision}T00:00:00Z`,kind:'file',layer:'original',text:`合成资料版本 ${revision}`},evidencePaths:inputPaths})).join('\n'));
    return {summary:'同一原始对象的两个历史版本。'};
  },agent:{configured:true,close:async()=>{},query:async input=>{seen.push(input);return {answer:'{"memories":[]}',citations:[],trace:[],runId:randomUUID()};}}});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${cfg.token}`};
  const uploaded=await node.app.inject({method:'POST',url:'/api/imports',headers,payload:{files:[{name:'history.json',dataBase64:Buffer.from('synthetic history').toString('base64')}]}});
  const id=uploaded.json().id;await until(async()=>node.imports.get(id),job=>job.status==='awaiting_confirmation');
  assert.equal((await node.app.inject({method:'POST',url:`/api/imports/${id}/confirm`,headers})).statusCode,202);
  const imported=await until(async()=>node.imports.get(id),job=>job.status==='completed');
  assert.equal(imported.captureIds.length,2);assert.equal(node.sources.history(imported.sourceId,'same-object').length,2);
  await until(async()=>node.memoryPipeline.get(imported.memoryJobId!),job=>job.status==='completed');
  assert.equal(seen.length,1);assert.deepEqual(seen[0].evidenceIds,[imported.captureIds[1]]);
});
