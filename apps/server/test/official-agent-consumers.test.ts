import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {uiPageText,type UiPageV3} from '@mote/shared';
import {DEPLOYMENT_MODEL_PROFILE_ID} from '@mote/shared/models';
import type {ModelSettings} from '@mote/shared/models';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {testModelConnection} from '../src/model-agent.js';
import {authorizeFixtureModels} from './fixtures/model-authorization.js';
import {TOPIC_CLASSIFICATION_INSTRUCTION} from '../src/automatic-topics.js';

const token='generated-official-consumers-owner',headers={authorization:`Bearer ${token}`};
const probeId='7a8f56d1-45de-47b7-90bb-5e84d411c3d6';

function config(dataDir:string,baseUrl:string):Config {
  return {dataDir,token,tokenPath:join(dataDir,'token'),host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,
    retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-official-model',modelProvider:'custom',
    modelProtocol:'openai-completions',modelBaseUrl:baseUrl,apiKey:'generated-official-key',allowUnauthenticatedLocal:false,
    embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,agentTimeoutMs:20_000};
}

function settingsFor(baseUrl:string):ModelSettings {
  return {provider:'custom',protocol:'openai-completions',model:'generated-official-model',baseUrl:baseUrl+'/v1',apiKey:'generated-official-key',
    headers:{},extraBody:{},reasoningEffort:'auto',maxTokens:2048,modelRequestTimeoutMs:20_000,agentTimeoutMs:20_000,allowUnauthenticatedLocal:false};
}

function envelope(body:any):any {
  const candidates:string[]=[];
  for(const message of body.messages??[]){
    if(typeof message.content==='string')candidates.push(message.content);
    else if(Array.isArray(message.content))for(const part of message.content)if(part?.type==='text'&&typeof part.text==='string')candidates.push(part.text);
  }
  for(const value of candidates){
    const text=value.trim();if(!text.startsWith('{'))continue;
    try{const parsed=JSON.parse(text);if(parsed&&typeof parsed==='object'&&(typeof parsed.request==='string'||typeof parsed.question==='string'))return parsed;}catch{}
  }
  return {};
}

function activity(quote:string,id:string){
  return {activities:[{existingActivityId:null,title:'Generated activity',statement:quote,uncertainty:'Generated fixture only.',
    evidence:[{id,quote,offset:0,source:'text'}]}],coverage:'complete',limitation:'Generated fixture observation.'};
}

function responseFor(envelopeValue:any,probeStage:number){
  const question=String(envelopeValue.request??envelopeValue.question??'');
  if(question.startsWith(TOPIC_CLASSIFICATION_INSTRUCTION))return {json:{answer:JSON.stringify({trees:[]}),citationIds:[]},usage:true};
  if(question.startsWith('Run a connection test')){
    if(probeStage===0)return {tool:{name:'search_context',arguments:JSON.stringify({query:'generated connection test record'})}};
    if(probeStage===1)return {tool:{name:'evidence',arguments:JSON.stringify({ids:[probeId]})}};
    return {json:{answer:`Generated probe answer [${probeId}]`,citationIds:[probeId]},usage:true};
  }
  const records=envelopeValue.untrustedEvidence??[];
  const first=records[0];
  if(envelopeValue.responseMode==='memory-extraction')return {json:{answer:JSON.stringify({memories:[]}),citationIds:[]},usage:true};
  if(envelopeValue.responseMode==='personal-insight')return {json:{answer:JSON.stringify({title:'Generated insight',markdown:'Generated insight',html:'<p>Generated insight</p>'}),citationIds:[]},usage:true};
  if(envelopeValue.responseMode==='calendar-extraction'){
    assert.ok(first,'calendar extraction needs a supplied original');
    const text=String(first.ocrText);
    return {json:{answer:JSON.stringify({actions:[{kind:'calendar.create',event:{title:'Generated official review',start:'2099-09-18T15:00:00+08:00',end:'2099-09-18T16:00:00+08:00',allDay:false,timeZone:'Asia/Shanghai',location:'',description:'Generated fixture event'},uncertainty:'Generated fixture only.',sameAs:null,evidence:[{id:first.id,quote:text}]}]}),citationIds:[first.id]},usage:true};
  }
  if(envelopeValue.untrustedTaskContext?.untrustedInterpretations){
    assert.ok(first,'activity needs a supplied original');
    return {json:{answer:JSON.stringify(activity(String(first.ocrText),first.id)),citationIds:[first.id]},usage:true};
  }
  if(first)return {json:{answer:`Generated answer [${first.id}]`,citationIds:[first.id]},usage:true};
  return {json:{answer:'Generated answer',citationIds:[]},usage:true};
}

let generatedCall=0;
function writeResponse(res:any,value:any){
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
  if(value.tool){
    const id='generated-call-'+(++generatedCall);
    res.write(`data: ${JSON.stringify({id,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id,type:'function',function:value.tool}]},finish_reason:null}]})}\n\n`);
    res.end(`data: ${JSON.stringify({id,choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\ndata: [DONE]\n\n`);
    return;
  }
  const text=JSON.stringify(value.json);
  res.write(`data: ${JSON.stringify({id:'generated-message',choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})}\n\n`);
  res.end(`data: ${JSON.stringify({id:'generated-message',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}})}\n\ndata: [DONE]\n\n`);
}

async function startFixture(t:import('node:test').TestContext){
  const requests:any[]=[];
  const server:Server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);requests.push(body);
    const value=envelope(body),probeStage=(body.messages??[]).filter((message:any)=>message.role==='tool').length;
    writeResponse(res,responseFor(value,probeStage));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const {port}=server.address() as AddressInfo;
  return {baseUrl:`http://127.0.0.1:${port}`,requests};
}

function observation(second=0):any{
  const at=new Date(Date.parse('2026-10-10T00:00:00Z')+1000*second).toISOString();
  const page:UiPageV3={version:3,scope:'visible_window',adapterId:'generated.official',adapterVersion:'1',appVersion:'1',activity:'generated.Official',status:'ok',truncated:false,
    observations:{firstAt:at,lastAt:at,count:1},objects:[{kind:'item',fields:[{name:'item_id',values:[{text:'GENERATED-OFFICIAL-41',source:'text'}]},{name:'state',values:[{text:'Generated state',source:'state'}]}]}]};
  return {id:randomUUID(),deviceId:'generated-official-device',deviceName:'Generated official device',platform:'android',capturedAt:at,source:'ui_page',
    appId:'generated.official',appName:'Generated official app',durationMs:0,windowTitle:'',ocrText:uiPageText(page),
    metadata:{version:1,observedAt:at,collector:{method:'accessibility'},uiPage:page},
    privacy:{excluded:false,redacted:true,mode:'local',collection:'content'}};
}

test('the official Agent composition feeds Query, Memory, Insight, Activity, Actions, Probe and usage consumers',{timeout:90_000},async t=>{
  const fixture=await startFixture(t),directory=mkdtempSync(join(tmpdir(),'mote-official-consumers-'));
  const node=await buildApp(config(directory,fixture.baseUrl),{backgroundWorker:false});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  await node.app.ready();
  await authorizeFixtureModels(node);
  const modeCount=(mode:string)=>fixture.requests.filter(body=>envelope(body).responseMode===mode).length;

  const query=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated official query'}});
  assert.equal(query.statusCode,200,query.body);
  assert.equal(query.json().answer,'Generated answer');
  assert.equal(query.json().runId===undefined,false);

  const note=observation();
  await node.store.ingest({...note,id:randomUUID(),source:'note',appId:'generated.note',appName:'Generated note',metadata:{version:1,observedAt:note.capturedAt}});
  const memory=await node.app.inject({method:'POST',url:'/api/memories/extract',headers,payload:{}});
  assert.equal(memory.statusCode,200,memory.body);
  assert.ok(modeCount('memory-extraction')>=1,'Memory extraction consumed the official Agent output');

  const insight=await node.app.inject({method:'POST',url:'/api/insights',headers,payload:{}});
  assert.equal(insight.statusCode,200,insight.body);
  assert.equal(insight.json().artifact?.title,'Generated insight');
  assert.ok(modeCount('personal-insight')>=1);

  const activityView=node.automaticActivity.view();
  const savedActivity=await node.automaticActivity.save({revision:activityView.revision,settings:{enabled:true,modelProfileId:DEPLOYMENT_MODEL_PROFILE_ID}});
  assert.equal(savedActivity.settings.enabled,true);
  const page=observation(1);
  await node.store.ingest(page);
  await node.automaticActivity.tick();
  const activities=node.materials.list({kind:'mote.activity'}).items;
  assert.equal(activities.length,1,JSON.stringify({view:node.automaticActivity.view(),requests:fixture.requests.length}));
  assert.match(node.materials.read(activities[0]!.ref).text,/GENERATED-OFFICIAL-41/);

  await node.actions.saveSettings({revision:node.configService.revision,authorizationRevision:node.actions.authorizationRevision(),settings:{enabled:true,timeZone:'Asia/Shanghai',reviewDeviceIds:[]}});
  node.sources.register({id:'generated-official-source',name:'Generated official source',kind:'custom',deviceId:'generated-official-device',platform:'import'});
  await node.sources.upsert('generated-official-source',{externalId:'generated-calendar',revision:'1',kind:'file',layer:'original',
    title:'Generated calendar note',text:'Generated calendar review is due on 2099-09-18.',observedAt:'2026-09-16T01:00:00Z'});
  await node.actions.tick();
  assert.equal(node.actions.list().length,1,JSON.stringify({progress:node.actions.progress(),requests:fixture.requests.length}));
  assert.ok(modeCount('calendar-extraction')>=1);

  const probe=await testModelConnection(settingsFor(fixture.baseUrl));
  assert.equal(probe.ok,true,JSON.stringify(probe));
  assert.equal(probe.code,'ok');

  const today=new Date().toISOString().slice(0,10);
  const usage=await node.app.inject({url:`/api/usage?from=${today}&to=${today}&groupBy=module`,headers});
  assert.equal(usage.statusCode,200,usage.body);
  assert.ok(usage.json().total.runs>=4,'all official Agent consumers share the Host usage ledger');
  assert.ok(usage.json().total.totalTokens>0);
});
