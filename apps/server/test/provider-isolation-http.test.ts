import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProviderFailure} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

for(const code of ['provider_timeout','provider_network','provider_unavailable'])test(`HTTP question remains available after another question's unsignalled ${code}`,async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-provider-http-'));
 const config:Config={dataDir:directory,token:'generated-provider-http-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-fixture',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'http://127.0.0.1:1234/v1',apiKey:'generated-not-a-live-key',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let calls=0;
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async()=>{
  if(++calls===1)throw new ProviderFailure({category:'transient',code});
  return {answer:'Generated independent answer.',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[]}};
 }}});
 t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
 await node.app.listen({host:'127.0.0.1',port:0});
 const request=(question:string)=>fetch(new URL('/api/query',node.app.listeningOrigin),{method:'POST',headers:{authorization:'Bearer '+config.token,'content-type':'application/json'},body:JSON.stringify({question})});
 const failed=await request('Generated failing question');assert.equal(failed.status,502);assert.equal((await failed.json()).reason,code);assert.equal(calls,1);
 assert.equal(node.featureServices.providerAdmission.snapshot().coolingDown,0);
 const next=await request('Generated independent question');assert.equal(next.status,200);assert.equal((await next.json()).answer,'Generated independent answer.');assert.equal(calls,2);
});
