/** Explicit live test. Only generated records enter the user's local Codex App Server. */
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {buildApp} from '../apps/server/dist/app.js';

const root=await mkdtemp(join(tmpdir(),'mote-issue-2-live-'));
const token=randomUUID();let node;
try {
  node=await buildApp({dataDir:root,token,tokenPath:join(root,'token'),host:'127.0.0.1',port:0,
    maxStorageBytes:10000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
    codexBin:process.env.MOTE_CODEX_BIN??'/Applications/ChatGPT.app/Contents/Resources/codex',modelProvider:'codex',modelProtocol:'codex-app-server',model:'gpt-5.6-luna',modelReasoningEffort:'max',modelTimeoutMs:300000,
    modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'});
  const headers={authorization:'Bearer '+token},id=randomUUID();
  const note=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-live-fixture',deviceName:'Generated fixture',platform:'import',capturedAt:new Date().toISOString(),text:'完全虚构的验收资料：纸风车项目的发布检查码是 LUNA-5729，演示地点是蓝色观测室。'}});
  assert.equal(note.statusCode,201,note.body);
  const started=Date.now();
  const response=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'查找我的随手记，纸风车项目发布检查码和演示地点是什么？请依据原记录引用回答。',modelProfileId:'default',modelOverride:'gpt-5.6-luna',timeZone:'Asia/Shanghai'}});
  const result=response.json();assert.equal(response.statusCode,200,response.body);
  assert.match(result.answer,/LUNA-5729/);assert.match(result.answer,/蓝色观测室/);assert.ok(result.citations.length>0);
  assert.equal(result.modelSelection.model,'gpt-5.6-luna');
  console.log(JSON.stringify({fixtureOnly:true,model:'gpt-5.6-luna',effort:'max',durationMs:Date.now()-started,citations:result.citations.length,tools:result.trace.length,passed:true}));
} finally {await node?.app.close();await rm(root,{recursive:true,force:true});}
