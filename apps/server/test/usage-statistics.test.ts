import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import type {UsageActivity, UsageFailure, UsageStatisticsPage, UsageStatisticsSummary} from '@mote/shared';
import {buildApp} from '../src/app.js';
import {UsageStatistics} from '../src/usage-statistics.js';
import {hostTerminal} from './fixtures/host-run.js';

const token='generated-owner-statistics-token-123456789';
const headers={authorization:`Bearer ${token}`,'x-mote-ingress-version':'2'};
const midnight={from:'2026-10-30',to:'2026-10-30',timeZone:'Asia/Shanghai'};

async function fixture(t:TestContext) {
  const directory=await mkdtemp(join(tmpdir(),'mote-usage-statistics-'));
  const runtime=await buildApp({path:join(directory,'mote.yaml'),privateCredential:{token,tokenPath:'fixture-only'},initialDocument:{
    version:1,revision:0,storage:{dataDir:directory,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},
    execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},
  }},{backgroundWorker:false,webRoot:join(directory,'no-web')});
  t.after(async()=>{await runtime.app.close();await rm(directory,{recursive:true,force:true});});
  const get=async <T>(path:string,args:Record<string,string>,status=200,authorization=headers.authorization)=>{
    const response=await runtime.app.inject({url:`/api/usage-statistics${path}?${new URLSearchParams(args)}`,headers:{...headers,authorization}});
    assert.equal(response.statusCode,status,response.body);return response.json<T>();
  };
  return {...runtime,get};
}

test('owner statistics count retained records and deduplicated turns in the selected civil day',async t=>{
  const node=await fixture(t),at='2026-10-29T16:00:00.000Z',before='2026-10-29T15:59:59.999Z';
  const picture=await sharp({create:{width:8,height:9,channels:3,background:'#806b96'}}).png().toBuffer();
  const sample={deviceId:'generated-phone',deviceName:'Generated phone',platform:'android',durationMs:0,appId:'generated.app',appName:'Generated app',privacy:{mode:'none'}};
  const id=randomUUID(),legacy=randomUUID();
  for(const [captureId,capturedAt,method] of [[id,at,'media_projection'],[legacy,at,undefined],[randomUUID(),before,'media_projection']]){
    const response=await node.app.inject({method:'POST',url:'/api/captures',headers,payload:{...sample,id:captureId,capturedAt,source:'screen',imageMime:'image/png',imageBase64:picture.toString('base64'),ocrText:'Generated screenshot text',...(method?{metadata:{version:1,observedAt:capturedAt,collector:{method}}}:{})}});
    assert.ok([200,201].includes(response.statusCode),response.body);
  }
  const eventId=randomUUID();
  await node.store.ingest({...sample,id:eventId,capturedAt:at,source:'notification',metadata:{version:1,observedAt:at,collector:{method:'notification_listener'},
    observation:{sessionId:randomUUID(),elapsedRealtimeMs:1000},notification:{action:'posted',notificationKey:'a'.repeat(64),postedAt:at,ongoing:false,groupSummary:false,text:'Generated private event'}}});
  const input={question:'Generated question body',clientRequestId:'generated-once'};
  const message=node.conversations.receive(input);
  assert.equal(node.conversations.receive(input).id,message.id);
  node.conversations.fail(message.id,{code:'timeout',message:'Generated private model error'},{expectedVersion:message.version});
  node.store.db.prepare("UPDATE conversation_turns SET json=json_set(json,'$.createdAt',?) WHERE id=?").run(at,message.id);

  const data=await node.get<UsageStatisticsSummary>('',midnight);
  assert.deepEqual(data.total.captures,{projection:1,unknownScreen:1,screen:0,system:1,page:0,other:0});
  assert.equal(data.total.turns,1);assert.equal(data.total.turnFailures,1);
  assert.deepEqual(data.total.toolCalls,{value:null,partial:true});
  assert.deepEqual(data.total.toolFailures,{value:null,partial:true});
  const range={day:midnight.from,timeZone:midnight.timeZone,limit:'1'};
  const activity:UsageActivity[]=[];
  let cursor:string|null=null;
  do {
    const page:UsageStatisticsPage<UsageActivity>=await node.get('/day',{...range,...(cursor?{cursor}:{})});
    activity.push(...page.items);cursor=page.nextCursor;
  } while(cursor);
  assert.deepEqual(new Set(activity.map(item=>item.id)),new Set([id,legacy,eventId,message.id]));
  assert.equal(activity.length,4);
  assert.ok(activity.some(item=>item.kind==='capture'&&item.id===id&&item.hasImage));
  assert.doesNotMatch(JSON.stringify(activity),/private event|question body|screenshot text/);
  const thumb=await node.app.inject({url:`/api/capture-browser/${id}/image?thumbnail=1`,headers});
  assert.equal(thumb.statusCode,200);assert.equal(thumb.headers['content-type'],'image/jpeg');
  const failures=await node.get<UsageStatisticsPage<UsageFailure>>('/failures',{...midnight,kind:'turn'});
  assert.deepEqual(failures.items.map(({reason,retry})=>({reason,retry})),[{reason:'timeout',retry:'unrecorded'}]);
  await node.get('',{...midnight,timeZone:'Invalid/Zone'},400);
  await node.get('',{...midnight,from:'2026-09-01'},400);
  await node.get('/day',{...range,cursor:'invalid'},400);
  const invite=await node.app.inject({method:'POST',url:'/api/connections/collector-invitations',headers,payload:{serverUrl:'https://generated.invalid',label:'Generated device'}});
  assert.equal(invite.statusCode,200,invite.body);
  const collector=await node.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invite.json().invitation.code,deviceId:randomUUID(),deviceName:'Generated collector',platform:'android'}});
  assert.equal(collector.statusCode,200,collector.body);
  for(const [path,args] of [['',midnight],['/day',range],['/failures',{...midnight,kind:'turn'}]] as const)
    await node.get(path,args,403,`Bearer ${collector.json().token}`);
});

test('failure details retain known retry outcomes and do not count interrupted deliveries as failures',async t=>{
  const node=await fixture(t),now=Date.now(),date=new Date(now).toISOString(),day=date.slice(0,10);
  const ledger=new UsageStatistics(node.store,()=>now),runId=randomUUID(),id=randomUUID(),interrupted=randomUUID();
  const start={kind:'started' as const,runId,attemptId:'first-attempt',tool:'search_context'};
  ledger.observeTool({...start,id});ledger.observeTool({...start,id});
  ledger.observeTool({kind:'finished',id,result:'failed',reason:'invalid_tool_arguments',durationMs:19});
  ledger.observeTool({kind:'finished',id,result:'completed',durationMs:21});
  hostTerminal({onHostRunEvent:event=>ledger.observeRun(event)},'completed',randomUUID());
  hostTerminal({onHostRunEvent:event=>ledger.observeRun({...event,attemptId:'second-attempt'})},'completed',runId);
  ledger.observeTool({...start,id:interrupted,runId:randomUUID(),tool:'evidence'});
  new UsageStatistics(node.store);

  const captureId=randomUUID();
  await node.store.ingest({id:captureId,deviceId:'generated-device',deviceName:'Generated device',platform:'android',capturedAt:date,durationMs:0,source:'screen',ocrText:'Generated capture'});
  const stepId=randomUUID();
  node.store.db.prepare(`INSERT INTO execution_steps(id,operation_id,kind,pool,input,state,attempts,created_at,updated_at)
    VALUES(?,?,'images.ocr','images.ocr','{}','succeeded',2,?,?)`).run(stepId,`image:${captureId}`,now-20,now);
  node.store.db.prepare('INSERT INTO execution_failures VALUES(?,?)').run(stepId,JSON.stringify({at:date,state:'waiting',category:'transient',code:'worker_offline',attempt:1}));
  const range={from:day,to:day,timeZone:'UTC'};
  const data=await node.get<UsageStatisticsSummary>('',range);
  assert.equal(data.total.toolCalls.value,2);
  assert.deepEqual(data.total.toolFailures,{value:1,partial:true});
  assert.equal(data.total.processingFailures,1);
  const tools=await node.get<UsageStatisticsPage<UsageFailure>>('/failures',{...range,kind:'tool'});
  assert.deepEqual(tools.items.map(({reason,retry})=>({reason,retry})),[{reason:'invalid_tool_arguments',retry:'completed'}]);
  const processing=await node.get<UsageStatisticsPage<UsageFailure>>('/failures',{...range,kind:'processing'});
  assert.deepEqual(processing.items.map(({reason,retry})=>({reason,retry})),[{reason:'worker_offline',retry:'completed'}]);
  const activity=await node.get<UsageStatisticsPage<UsageActivity>>('/day',{day,timeZone:'UTC',kind:'tool'});
  const interruptedActivity=activity.items.find(item=>item.id===interrupted);
  assert.ok(interruptedActivity?.kind==='tool');
  assert.equal(interruptedActivity.state,'unknown');
});
