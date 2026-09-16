import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { buildApp } from '../apps/server/src/app.js';
import type { Config } from '../apps/server/src/config.js';

const dir=await mkdtemp(join(tmpdir(),'mote-e2e-'));const id=randomUUID();const noteId=randomUUID();let rounds=0;
const fixtureModel=createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;
  const body=JSON.parse(raw);assert.deepEqual(body.tools.map((t:any)=>t.function.name).sort(),['activity','devices','evidence','file_chunks','media_activity','memories','progress_update','search_context','skill','source_history','source_items','sources','timeline']);
  const stage=(body.messages??[]).filter((message:any)=>message.role==='tool').length;rounds++;
  const tool=stage===0?{name:'search_context',arguments:JSON.stringify({query:'orbital observatory'})}:stage===1?{name:'evidence',arguments:JSON.stringify({ids:[id,noteId]})}:null;
  const delta=tool?{role:'assistant',tool_calls:[{index:0,id:`tool-${stage}`,type:'function',function:tool}]}:{role:'assistant',content:JSON.stringify({answer:`这是合成测试：阅读了 orbital observatory 的资料。[${id}] 也主动记录了复盘笔记。[${noteId}]`,citationIds:[id,noteId]})};
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.write(`data: ${JSON.stringify({id:`fixture-${stage}`,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
  res.write(`data: ${JSON.stringify({id:`fixture-${stage}`,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}]})}\n\n`);res.end('data: [DONE]\n\n');
});
await new Promise<void>(r=>fixtureModel.listen(0,'127.0.0.1',r));
const config:Config={dataDir:dir,token:'synthetic-e2e-not-a-real-secret',tokenPath:'unused',host:'127.0.0.1',port:0,contentEncryptionEnabled:true,dataKey:'3c'.repeat(32),maxStorageBytes:10000000,maxExportBytes:10000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'synthetic-fixture',modelBaseUrl:`http://127.0.0.1:${(fixtureModel.address() as AddressInfo).port}/v1`,apiKey:'synthetic-fixture',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
const {app}=await buildApp(config);await app.listen({port:process.argv.includes('--serve')?47835:0,host:'127.0.0.1'});const base=`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
const headers={Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'};
async function call(path:string,body?:unknown,method=body?'POST':'GET') {const res=await fetch(base+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});assert.ok(res.ok,`${path} returned ${res.status}: ${res.ok?'':await res.text()}`);return res.json();}
try {
  const image=await sharp({create:{width:128,height:80,channels:3,background:'#365c4e'}}).webp().toBuffer();
  const capture={id,deviceId:'synthetic-mac',deviceName:'Synthetic Mac',platform:'macos',capturedAt:new Date(Date.now()-30000).toISOString(),durationMs:15000,appId:'synthetic.reader',appName:'Synthetic Reader',ocrText:'orbital observatory: synthetic context collection evidence',source:'screen',imageBase64:image.toString('base64'),imageMime:'image/webp',privacy:{excluded:false,redacted:false,mode:'local'}};
  assert.equal((await fetch(base+'/api/captures')).status,401);
  assert.equal((await call('/api/captures',capture)).duplicate,false);assert.equal((await call('/api/captures',capture)).duplicate,true);
  await call('/api/captures',{...capture,id:randomUUID(),deviceId:'synthetic-android',deviceName:'Synthetic Android',platform:'android',capturedAt:new Date().toISOString()});
  const note={id:noteId,deviceId:'synthetic-android',deviceName:'Synthetic Android',platform:'android',capturedAt:new Date().toISOString(),text:'orbital observatory: 我主动记录的合成复盘，原文保留。',mood:'用户显式标注：期待'};
  assert.equal((await call('/api/notes',note)).id,noteId);
  const savedNote=await call(`/api/notes/${noteId}`);assert.equal(savedNote.ocrText,note.text);assert.equal(savedNote.mood,note.mood);assert.equal(savedNote.source,'note');assert.equal(savedNote.blobHash,null);
  const status=await call('/api/status');assert.equal(status.storage.captures,3);assert.equal(status.storage.blobs,1);
  const result=await call('/api/query',{question:'What were the synthetic devices reading?'});assert.equal(result.citations[0].id,id);assert.ok(result.citations.some((c:any)=>c.id===noteId));assert.equal(rounds,3);assert.deepEqual(result.trace.map((t:any)=>t.tool),['search_context','evidence']);
  const recovered=await fetch(base+`/api/captures/${id}/image`,{headers});assert.deepEqual(Buffer.from(await recovered.arrayBuffer()),image);
  const archive=await call('/api/export');assert.equal((await call('/api/import',archive)).duplicates,3);
  assert.equal((await call('/api/activity')).totalDurationMs,30000);
  console.info('PASS: synthetic Mac + Android screenshots + explicit mood note → encrypted deduplicated vault → real DeepSeek Harness tool loop + fixture model → evidence → image → portable archive round trip. No real device screenshot or live-model quality was tested.');
  if(process.argv.includes('--serve')) {console.info(`Synthetic-only UI test node: ${base}; fixture token: ${config.token}; Ctrl+C stops and removes this disposable test vault.`);await new Promise<void>(r=>process.once('SIGINT',()=>r()));}
}finally{await app.close();fixtureModel.closeAllConnections();await new Promise<void>(r=>fixtureModel.close(()=>r()));await rm(dir,{recursive:true,force:true});}
