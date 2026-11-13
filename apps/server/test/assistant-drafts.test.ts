import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {QueryResult} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {ModelAgentFactory} from '../src/model-agent.js';

const owner='generated-assistant-draft-owner',headers={authorization:'Bearer '+owner};
const config=(dataDir:string):Config=>({dataDir,token:owner,tokenPath:'fixture-only',host:'127.0.0.1',port:0,
  maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
  model:'generated-model',modelBaseUrl:'https://model.example.invalid/v1',apiKey:'generated-key',modelProvider:'custom',
  modelProtocol:'openai-completions',modelReasoningEffort:'auto',allowUnauthenticatedLocal:false,
  embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false});

async function fixture(t:TestContext,options:{draft?:boolean}={}){
  const directory=await mkdtemp(join(tmpdir(),'mote-assistant-drafts-')),seen:{assistantDraft?:true;evidenceIds?:string[]}[]=[];
  const factory:ModelAgentFactory=async()=>({configured:true,query:async args=>{
    seen.push({...(args.assistantDraft?{assistantDraft:true}:{}),...(args.evidenceIds?{evidenceIds:[...args.evidenceIds]}:{})});
    const id=args.evidenceIds?.[0];
    return {answer:'Generated answer',citations:id?[{id,capturedAt:'2026-11-01T00:00:00Z',appName:'Generated source',excerpt:'Generated excerpt'}]:[],
      trace:[],runId:'generated-'+randomUUID(),...(options.draft===false?{}:{draftProposal:{goal:'Generated follow-up'}})} as QueryResult;
  },close:async()=>{}});
  const node=await buildApp(config(directory),{createModelAgent:factory,backgroundWorker:false});
  t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
  const post=(payload:unknown)=>node.app.inject({method:'POST',url:'/api/assistant/commands',headers,payload:payload as object});
  const query=(payload:unknown)=>node.app.inject({method:'POST',url:'/api/query',headers,payload:payload as object});
  return {...node,seen,post,query};
}

test('a model draft can be previewed without creating a task and unoffered commands remain forbidden',async t=>{
  const f=await fixture(t),response=await f.query({question:'Generated question'});
  assert.equal(response.statusCode,200,response.body);assert.equal(f.seen[0]?.assistantDraft,true);
  const body=response.json(),draft=body.draft;
  assert.equal(draft.revision,1);assert.equal(draft.goal,'Generated follow-up');
  assert.deepEqual(draft.scope,{kind:'all'});
  assert.deepEqual(draft.capabilities,['assistant.task.start','assistant.task.preview']);
  assert.match(draft.requestId,/^[0-9a-f-]{36}$/);
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM task_records').get().count,0);

  const command={conversationId:body.conversationId,turnId:body.turnId,requestId:draft.requestId,expectedRevision:1,
    capability:'assistant.task.preview',goal:draft.goal,scope:draft.scope};
  const first=await f.post(command);assert.equal(first.statusCode,200,first.body);
  assert.equal(first.json().requestId,draft.requestId);assert.equal(first.json().state,'previewed');
  assert.deepEqual((await f.post(command)).json(),first.json(),'a retried command keeps the same request identity');
  // A saved preview-only draft is still a valid capability subset. An owner
  // cannot add start to that stored command merely by changing the request.
  f.store.db.prepare("UPDATE conversation_turns SET json=json_set(json,'$.result.draft.capabilities',json('[\"assistant.task.preview\"]')) WHERE id=?").run(body.turnId);
  assert.equal((await f.post({...command,capability:'assistant.task.start'})).statusCode,403,'an unoffered capability is rejected');
  assert.equal((await f.post({...command,capability:'assistant.task.send'})).statusCode,400,'unknown capabilities are not wire commands');
  assert.equal((await f.post({...command,scope:{kind:'all',after:'2026-01-01T00:00:00Z'}})).statusCode,409,'scope cannot be widened');
  assert.equal((await f.post({...command,expectedRevision:3})).statusCode,409,'a stale draft version is rejected');
  assert.equal((await f.post({...command,goal:'Generated changed goal'})).statusCode,409,'an unchanged version cannot silently change its goal');
  assert.equal((await f.post({...command,requestId:randomUUID()})).statusCode,409,'an unchanged draft keeps its request identity');
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM task_records').get().count,0,'K5 preview has no task side effect');
});

test('an explicit edit starts a distinct immutable task and retries keep their identity',async t=>{
  const f=await fixture(t);
  const response=await f.query({question:'Generated question'}),body=response.json(),draft=body.draft;
  assert.deepEqual(draft.capabilities,['assistant.task.start','assistant.task.preview']);
  const command={conversationId:body.conversationId,turnId:body.turnId,requestId:draft.requestId,expectedRevision:draft.revision,
    capability:'assistant.task.start',goal:draft.goal,scope:draft.scope};
  const started=await f.post(command);assert.equal(started.statusCode,200,started.body);
  assert.equal(started.json().requestId,draft.requestId);assert.equal(started.json().revision,1);
  assert.equal((await f.post(command)).json().taskId,started.json().taskId,'retries return the same task');

  const editedId=randomUUID();
  const edited=await f.post({...command,requestId:editedId,expectedRevision:draft.revision+1,goal:'Generated edited goal'});
  assert.equal(edited.statusCode,200,edited.body);assert.equal(edited.json().requestId,editedId);
  assert.equal(edited.json().revision,2);assert.notEqual(edited.json().taskId,started.json().taskId);
  const editedRetry=await f.post({...command,requestId:editedId,expectedRevision:draft.revision+1,goal:'Generated edited goal'});
  assert.equal(editedRetry.statusCode,200,'an exact edited retry stays idempotent');assert.equal(editedRetry.json().requestId,editedId);assert.equal(editedRetry.json().taskId,edited.json().taskId);
  assert.equal((await f.post({...command,expectedRevision:draft.revision+1,goal:'Generated edited goal'})).statusCode,409,'an edited version cannot reuse the original requestId');
  assert.equal((await f.post({...command,requestId:randomUUID(),expectedRevision:draft.revision+1,goal:draft.goal})).statusCode,409,'a revision bump must contain an edit');
  assert.equal((await f.post({...command,requestId:editedId,expectedRevision:2,goal:'Generated different edit'})).statusCode,409,'a saved command identity cannot overwrite its goal');
  assert.equal((await f.post({...command,requestId:randomUUID(),expectedRevision:3,goal:'Generated edited goal'})).statusCode,409,'a new version must change the last accepted goal');
  const thirdCommand={...command,requestId:randomUUID(),expectedRevision:3,goal:'Generated second edit'};
  const third=await f.post(thirdCommand);assert.equal(third.statusCode,200,third.body);assert.equal(third.json().revision,3);
  assert.equal((await f.post(thirdCommand)).json().taskId,third.json().taskId,'a later version remains idempotent');
  assert.equal((await f.post({...thirdCommand,requestId:randomUUID(),goal:'Generated conflicting edit'})).statusCode,409,'two commands cannot occupy the same revision');
  const reverted=await f.post({...command,requestId:randomUUID(),expectedRevision:4,goal:draft.goal});assert.equal(reverted.statusCode,200,reverted.body);
  const path=`/api/conversations/${body.conversationId}/messages/${body.turnId}/assistant-tasks?`+new URLSearchParams({scope:JSON.stringify(draft.scope)});
  const saved=await f.app.inject({url:path,headers});assert.equal(saved.statusCode,200,saved.body);
  assert.deepEqual(saved.json().items.map((item:any)=>[item.expectedRevision,item.task.goal]),[[1,'Generated follow-up'],[2,'Generated edited goal'],[3,'Generated second edit'],[4,'Generated follow-up']]);
  assert.equal(f.store.db.prepare("SELECT count(*) AS count FROM task_records WHERE kind='assistant.task'").get().count,4);
});

test('selected-evidence drafts keep their exact source scope and fail after evidence deletion',async t=>{
  const f=await fixture(t),id=randomUUID();
  await f.store.ingest({id,deviceId:'generated-device',deviceName:'Generated device',platform:'import',source:'note',
    capturedAt:'2026-11-01T00:00:00Z',durationMs:0,ocrText:'Generated evidence'});
  const response=await f.query({question:'Generated selected question',evidenceIds:[id]});
  assert.equal(response.statusCode,200,response.body);
  const body=response.json(),draft=body.draft;
  assert.deepEqual(draft.scope,{kind:'selection',evidenceIds:[id]});
  const command={conversationId:body.conversationId,turnId:body.turnId,requestId:draft.requestId,expectedRevision:1,
    capability:'assistant.task.preview',goal:draft.goal,scope:draft.scope};
  assert.equal((await f.post(command)).statusCode,200);
  assert.equal((await f.post({...command,scope:{kind:'selection',evidenceIds:[]}})).statusCode,409,'an empty selection is not the stored scope');
  const anchored=await f.query({question:'Generated anchored question',anchorEvidenceIds:[id]});
  assert.equal(anchored.statusCode,200,anchored.body);
  assert.equal(anchored.json().draft,undefined,'an anchored query has no representable free-standing task scope');
  assert.equal(f.seen.at(-1)?.assistantDraft,undefined);
  const deleted=await f.app.inject({method:'DELETE',url:'/api/captures/'+id,headers});assert.equal(deleted.statusCode,200,deleted.body);
  const after=(await f.post(command)).statusCode;assert.ok([404,409].includes(after),'deleted evidence invalidates the draft');
});
