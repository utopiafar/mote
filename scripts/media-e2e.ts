import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {buildApp} from '../apps/server/src/app.js';
import type {Config} from '../apps/server/src/config.js';

// Deterministic generated provider replies exercise real Harness tools, not model quality.
const directory=await mkdtemp(join(tmpdir(),'mote-media-e2e-'));
const id=randomUUID(),at='2026-09-15T02:00:30.000Z';let rounds=0;
const fixture=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw),responses=body.messages.filter((message:{role:string})=>message.role==='tool');
  assert.ok(body.tools.some((tool:{function:{name:string}})=>tool.function.name==='media_activity'));
  const steps=[{name:'timeline',arguments:JSON.stringify({source:'media'})},
    {name:'media_activity',arguments:JSON.stringify({screenLocked:true,appVisibility:'background'})},
    {name:'evidence',arguments:JSON.stringify({ids:[id]})}];
  if(responses.length===1){const page=JSON.parse(responses[0].content);assert.equal(page.data[0].metadata.media.sessions[0].title,'Generated chapter 7');}
  if(responses.length===2){const stats=JSON.parse(responses[1].content);assert.equal(stats.data.totalDurationMs,30000);}
  const tool=steps[responses.length];rounds++;
  const delta=tool?{role:'assistant',tool_calls:[{index:0,id:`generated-${responses.length}`,type:'function',function:tool}]}:
    {role:'assistant',content:JSON.stringify({answer:`合成记录显示锁屏后台播放 Generated chapter 7，观察到的播放区间为 30 秒；不代表已经听完。[${id}]`,citationIds:[id]})};
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  for(const [payload,finish_reason] of [[delta,null],[{},tool?'tool_calls':'stop']])res.write(`data: ${JSON.stringify({id:'generated-media',object:'chat.completion.chunk',choices:[{index:0,delta:payload,finish_reason}]})}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise<void>(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const config:Config={dataDir:directory,token:'generated-fixture-only-credential',tokenPath:'unused',host:'127.0.0.1',port:0,dataKey:'4a'.repeat(32),maxStorageBytes:10000000,maxExportBytes:10000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-provider',modelBaseUrl:`http://127.0.0.1:${(fixture.address() as AddressInfo).port}/v1`,apiKey:'generated-fixture',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
const {app}=await buildApp(config);
const headers={authorization:`Bearer ${config.token}`};
try {
  const session={sessionId:'generated-session',appId:'fixture.audio',appName:'Generated Audio',playbackState:'playing',appVisibility:'background',playbackType:'local',title:'Generated chapter 7',artist:'Generated narrator'};
  const event={id,deviceId:'generated-phone',deviceName:'Generated Phone',platform:'android',capturedAt:at,durationMs:30000,appId:session.appId,appName:session.appName,source:'media',privacy:{collection:'content',mode:'none'},metadata:{version:1,observedAt:at,collector:{method:'media_session'},state:{screenLocked:true,screenInteractive:false},media:{status:'available',sessions:[session]}}};
  for(const expected of [201,200])assert.equal((await app.inject({method:'POST',url:'/api/captures',headers,payload:event})).statusCode,expected);
  assert.equal((await app.inject({url:'/api/activity',headers})).json().totalDurationMs,0);
  const result=await app.inject({method:'POST',url:'/api/query',headers,payload:{question:'解释这段合成锁屏音频记录',deviceId:'generated-phone',after:'2026-09-15T02:00:00Z',before:'2026-09-15T02:01:00Z',timeZone:'Asia/Shanghai'}});
  assert.equal(result.statusCode,200,result.body);const answer=result.json();
  assert.deepEqual(answer.trace.map((entry:{tool:string})=>entry.tool),['timeline','media_activity','evidence']);
  assert.equal(answer.citations[0].id,id);assert.match(answer.citations[0].excerpt,/Generated chapter 7/);assert.equal(rounds,4);
  const archive=(await app.inject({url:'/api/export',headers})).json();
  assert.equal((await app.inject({method:'POST',url:'/api/import',headers,payload:archive})).json().duplicates,1);
  console.info('PASS: generated locked-screen media → idempotent archive → real Harness with fixture provider → scoped media accounting → cited provider metadata → archive round trip. No physical-device capture or live-model quality tested.');
} finally {
  await app.close();fixture.closeAllConnections();await new Promise<void>(resolve=>fixture.close(()=>resolve()));await rm(directory,{recursive:true,force:true});
}
