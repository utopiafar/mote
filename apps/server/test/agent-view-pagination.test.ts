import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

test('owner Agent inspector reads long segments page by page through the scoped Agent guard',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-agent-pagination-'));
 const config:Config={dataDir:directory,token:'generated-fixture-token',tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxExportBytes:1_000_000,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 const node=await buildApp(config,{backgroundWorker:false});t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const captureId=randomUUID(),deviceId='generated-device',at='2026-10-12T00:00:00.000Z';
 await node.store.ingest({id:captureId,deviceId,deviceName:'Generated device',platform:'import',source:'note',capturedAt:at,durationMs:0,appId:'generated.note',appName:'Generated note',ocrText:'Generated original evidence'});
 const text='A'.repeat(4000)+'B'.repeat(4000)+'C'.repeat(4000),id='a'.repeat(64),revision='b'.repeat(64);
 node.store.archive.save(id,id,revision,{kind:'segment',text,metadata:{complete:true}},[{id:captureId,fingerprint:node.store.archive.fingerprint(captureId)!}],'generated','1','generated');
 const ref=`artifact:${id}:${revision}`,url='/api/agent-view/segments?id='+encodeURIComponent(ref),headers={authorization:'Bearer '+config.token};
 assert.equal((await node.app.inject(url)).statusCode,401);
 for(const offset of [0,4000,8000,12000]){
  const response=await node.app.inject({url:url+'&deviceId='+deviceId+'&offset='+offset,headers});assert.equal(response.statusCode,200,response.body);
  const item=response.json().items[0];assert.equal(item.text,text.slice(offset,offset+4000));
  assert.deepEqual(item.textRange,{offset,total:12000,nextOffset:offset<8000?offset+4000:null});
  assert.deepEqual(item.members,[captureId]);
 }
 for(const suffix of ['&deviceId=unrelated','&after=2026-10-13T00%3A00%3A00.000Z'])assert.deepEqual((await node.app.inject({url:url+suffix,headers})).json().items,[]);
 assert.equal((await node.app.inject({url:url+'&offset=-1',headers})).statusCode,400);
 assert.equal((await node.app.inject({url:url+'&length=4001',headers})).statusCode,400);
 const old=url.replace(encodeURIComponent(revision),encodeURIComponent('c'.repeat(64)));
 assert.deepEqual((await node.app.inject({url:old,headers})).json().items,[]);
 node.store.delete(captureId);assert.deepEqual((await node.app.inject({url,headers})).json().items,[]);
 await node.diagnostics.configure({enabled:true,debug:false,traceEnabled:true,level:'info'});
 node.diagnostics.agentTrace({type:'context.assembled',runId:'generated-retained-run',payload:{generatedOnly:true,modelCalled:false}});
 const traceSeq=node.diagnostics.snapshot().lastSeq;
 for(let i=0;i<600;i++)node.diagnostics.record('queue.snapshot');
 assert.ok(node.diagnostics.snapshot().lastSeq-traceSeq>=600,'use actual accepted diagnostics events');
 assert.ok(node.diagnostics.snapshot().retainedEvents>=601,'trace and background diagnostics are really retained');
 const runs=await node.app.inject({url:'/api/agent-view/runs',headers});assert.equal(runs.statusCode,200,runs.body);
 assert.ok(runs.json().items.some((run:{runId:string})=>run.runId==='generated-retained-run'),'an older retained run is still selectable after600ordinary diagnostics');
});
