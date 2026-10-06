import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import {Store} from '../src/store.js';
import {UsageLedger} from '../src/usage.js';

test('application upgrade retires budget endpoints while queries and actual cost accounting continue',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-continuity-api-')),headers={authorization:'Bearer generated-owner'};
  const config={dataDir:directory,token:'generated-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:10000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelProvider:'custom',modelProtocol:'openai-completions' as const,modelBaseUrl:'https://generated.invalid',apiKey:'generated',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
  const previous=new Store(directory),ledger=new UsageLedger(previous);
  previous.db.prepare('INSERT INTO settings VALUES(?,?)').run('model-budgets',JSON.stringify({revision:1,limits:{dailyTokens:1,operationTokens:1,dailyCost:0.001}}));
  ledger.setPrice({provider:'custom',model:'fixture',currency:'USD',input:1,output:2,cacheRead:1,cacheWrite:1});previous.close();
  let calls=0;
  const node=await buildApp(config,{agent:{configured:true,close:async()=>{},query:async input=>{
    calls++;input.onUsage?.({requests:1,reportedRequests:1,inputTokens:200000,outputTokens:50000,totalTokens:250000,cacheReadTokens:0,cacheWriteTokens:0});
    return {runId:randomUUID(),answer:'Generated response',citations:[],trace:[]};
  }}});t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  for(const method of ['GET','PUT'] as const){const response=await node.app.inject({method,url:'/api/model-budgets',headers,...(method==='PUT'?{payload:{revision:1,limits:{dailyTokens:1}}}:{})});assert.equal(response.statusCode,404,response.body);}
  const processing=(await node.app.inject({url:'/api/processing',headers})).json();assert.equal(processing.usage,undefined);
  for(const policy of Object.values(processing.settings))assert.deepEqual(Object.keys(policy as object).sort(),['concurrency','enabled']);
  const oldPolicy=await node.app.inject({method:'PUT',url:'/api/processing/settings',headers,payload:{...processing.settings,semantic:{...processing.settings.semantic,dailyCalls:1}}});assert.equal(oldPolicy.statusCode,400);
  const query=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated continuity question'}});assert.equal(query.statusCode,200,query.body);assert.equal(calls,1);
  const receipt=JSON.parse(String(node.store.db.prepare("SELECT json FROM model_usage WHERE json_extract(json,'$.operation')='query'").get()!.json));
  assert.equal(receipt.tokens.totalTokens,250000);assert.equal(receipt.estimatedCost,0.3);assert.equal(receipt.status,'completed');
  assert.equal(node.store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'model_budget_%' OR name='processing_usage'").get()!.n,0);
});
