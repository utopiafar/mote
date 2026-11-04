import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ModelSettings,ModelSettingsView} from '@mote/shared/models';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {ExecutionFailure} from '../src/execution-engine.js';
import type {ModelAgentFactory} from '../src/model-agent.js';
import {authorizeFixtureModels} from './fixtures/model-authorization.js';

const token='generated-agent-runtime-generation',headers={authorization:`Bearer ${token}`};
const config=(dataDir:string):Config=>({dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,
  retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'original-fixture',modelBaseUrl:'https://model.example.invalid/v1',apiKey:'synthetic-original-key',
  modelProvider:'custom',modelProtocol:'openai-completions',modelReasoningEffort:'auto',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',
  agentConcurrency:1,llmConcurrency:1,agentTimeoutMs:30000});
type Node=Awaited<ReturnType<typeof buildApp>>;
const settingsInput=(view:ModelSettingsView['settings']):Omit<ModelSettings,'apiKey'|'headers'|'extraBody'>=>{
  const {apiKeyConfigured:_key,headersConfigured:_headers,extraBodyConfigured:_body,...settings}=view;
  return settings;
};
const until=async<T>(read:()=>T|undefined,describe?:()=>unknown):Promise<T>=>{
  for(let attempt=0;attempt<240;attempt++){const value=read();if(value!==undefined)return value;await new Promise(resolve=>setTimeout(resolve,25));}
  throw Error('Generated fixture did not settle'+(describe?': '+JSON.stringify(describe()):''));
};
const step=(node:Node,id:string)=>node.store.db.prepare('SELECT state,error,attempts,available_at FROM execution_steps WHERE operation_id=?').get('query:'+id) as {state:string;error:string|null;attempts:number;available_at:number}|undefined;
const workStatus=(node:Node,id:string)=>node.store.db.prepare("SELECT json_extract(json,'$.status') status,json_extract(json,'$.error') error FROM delegation_works WHERE id=?").get('query:'+id) as {status:string;error:string|null}|undefined;
const conversationTurns=(node:Node,status?:string)=>Number(node.store.db.prepare(`SELECT count(*) n FROM conversation_turns${status?" WHERE json_extract(json,'$.status')=?":''}`).get(...(status?[status]:[]))!.n);

function fixture(){
  const attempts:{settings:ModelSettings;question:string}[]=[];
  const factory:ModelAgentFactory=async settings=>({configured:true,close:async()=>{},query:async input=>{
    attempts.push({settings,question:input.question});
    if(attempts.length===1)throw new ExecutionFailure('waiting','rate_limited',3_600_000);
    return {answer:'Generated recovered answer',citations:[],trace:[],runId:randomUUID()};
  }});
  return {attempts,factory};
}

async function profileA(node:Node,model:string){
  const view=(await node.app.inject({url:'/api/model-settings',headers})).json<ModelSettingsView>();
  const created=await node.app.inject({method:'PUT',url:'/api/model-settings/profiles/profile-a',headers,payload:{revision:view.revision,name:'Profile A',
    settings:{...settingsInput(view.settings),model,apiKey:'synthetic-profile-a-key'}}});
  assert.equal(created.statusCode,200,created.body);
}
async function editProfileA(node:Node,model:string){
  const view=(await node.app.inject({url:'/api/model-settings',headers})).json<ModelSettingsView>();
  const profile=view.profiles.find(value=>value.id==='profile-a')!;
  const updated=await node.app.inject({method:'PUT',url:'/api/model-settings/profiles/profile-a',headers,payload:{revision:view.revision,name:profile.name,
    settings:{...settingsInput(profile.settings),model,maxTokens:4096}}});
  assert.equal(updated.statusCode,200,updated.body);
}
async function startRun(node:Node,question:string){
  const note={id:randomUUID(),deviceId:'generated-agent-runtime-device',deviceName:'Generated fixture',platform:'import' as const,source:'note' as const,
    capturedAt:'2026-09-20T01:00:00Z',durationMs:0,ocrText:'Generated original for pinned model recovery.'};
  await authorizeFixtureModels(node);
  await node.store.ingest(note);
  const id=randomUUID();
  const accepted=await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question,modelProfileId:'profile-a',evidenceIds:[note.id]}}});
  assert.equal(accepted.statusCode,202,accepted.body);
  await until(()=>step(node,id)?.state==='waiting'&&step(node,id)?.error==='rate_limited'?true:undefined,()=>step(node,id));
  return {id,noteId:note.id};
}
async function restart(node:Node,dataDir:string,factory:ModelAgentFactory){
  await node.app.close();
  const restarted=await buildApp(config(dataDir),{backgroundWorker:false,createModelAgent:factory});
  await restarted.app.ready();
  return restarted;
}
async function revoke(node:Node){
  node.modelAuthorization.command({revision:node.modelAuthorization.view().revision,operationId:randomUUID(),action:'stop'});
}
const due=(node:Node,id:string)=>node.store.db.prepare('UPDATE execution_steps SET available_at=0 WHERE operation_id=?').run('query:'+id);

test('an interrupted run resumes its exact profile after restart',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-agent-runtime-generation-exact-'));
  const {attempts,factory}=fixture();
  let node=await buildApp(config(directory),{backgroundWorker:false,createModelAgent:factory});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  await profileA(node,'profile-a-model');
  const {id}=await startRun(node,'Generated exact recovery question');
  const original=structuredClone(attempts[0]!.settings);

  node=await restart(node,directory,factory);
  assert.equal(workStatus(node,id)?.status,'waiting','an exact pinned profile is resumable after restart');
  due(node,id);
  await node.delegation.tick();
  const settled=await until(()=>{const run=node.queryRuns.get(id);return run.status!=='running'?run:undefined;},()=>node.queryRuns.get(id));
  assert.equal(settled.status,'completed');
  assert.equal(attempts.length,2,'restart makes one recovered attempt');
  assert.deepEqual(attempts[1]!.settings,original,'the recovered attempt uses the exact pinned profile');
  assert.ok(settled.turnId);
  assert.equal(conversationTurns(node,'completed'),1);
});

test('restart blocks an interrupted run when its pinned profile changed instead of mixing the new generation',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-agent-runtime-generation-blocked-'));
  const {attempts,factory}=fixture();
  let node=await buildApp(config(directory),{backgroundWorker:false,createModelAgent:factory});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  await profileA(node,'profile-a-model');
  const {id}=await startRun(node,'Generated changed profile question');
  await editProfileA(node,'changed-profile-model');

  node=await restart(node,directory,factory);
  assert.equal(workStatus(node,id)?.status,'blocked','a changed pinned profile is explicitly blocked after restart');
  assert.equal(workStatus(node,id)?.error,'model_snapshot_unavailable');
  const blocked=node.queryRuns.get(id);
  assert.equal(blocked.status,'failed');
  assert.equal(blocked.error?.code,'model_snapshot_unavailable');
  assert.equal(blocked.turnId,undefined);
  assert.equal(attempts.length,1,'blocked recovery makes no new model attempt');
  assert.equal(conversationTurns(node),0,'blocked recovery writes no final answer');

  await revoke(node);
  due(node,id);
  await node.delegation.tick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(attempts.length,1,'revocation after the block starts no model attempt');
  assert.equal(conversationTurns(node),0,'revocation after the block writes no final answer');
});

test('revoking the run data after restart starts no new model attempt or final write',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-agent-runtime-generation-revoked-'));
  const {attempts,factory}=fixture();
  let node=await buildApp(config(directory),{backgroundWorker:false,createModelAgent:factory});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  await profileA(node,'profile-a-model');
  const {id,noteId}=await startRun(node,'Generated revoked recovery question');

  node=await restart(node,directory,factory);
  assert.equal(workStatus(node,id)?.status,'waiting');
  await revoke(node);
  node.store.delete(noteId);
  due(node,id);
  await node.delegation.tick();
  const settled=await until(()=>{const run=node.queryRuns.get(id);return run.status!=='running'?run:undefined;},()=>node.queryRuns.get(id));
  assert.notEqual(settled.status,'completed');
  assert.equal(settled.turnId,undefined,'revocation publishes no final conversation turn');
  assert.equal(attempts.length,1,'revocation starts no new model attempt');
  assert.equal(conversationTurns(node,'completed'),0,'revocation writes no completed answer');
});
