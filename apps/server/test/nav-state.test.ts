import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {StatementSync} from 'node:sqlite';
import type {NavRevisionKey,NavState} from '@mote/shared';
import {buildApp,type QueryAgent} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import {EvidenceStore} from '../src/evidence-store.js';
import {registerNavBadge} from '../src/nav-state.js';

const owner='synthetic-owner-for-nav-state-tests';
const headers={authorization:`Bearer ${owner}`};
const inactive:QueryAgent={configured:false,query:async()=>{throw Error('No model calls belong in nav-state tests');},close:async()=>{}};
const revisionKeys:NavRevisionKey[]=['library','cards','commitments','matters','memory','sources','plugins'];

function config(directory:string):ConfigurationPlatformOptions{return {path:join(directory,'mote.yaml'),privateCredential:{token:owner,tokenPath:join(directory,'owner-token')},initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:4*1024*1024},server:{host:'127.0.0.1',port:0,profile:'test',allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',baseUrl:'https://api.deepseek.com',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{enabled:true}}};}

async function fixture(t:TestContext,store?:EvidenceStore){
  const directory=await mkdtemp(join(tmpdir(),'mote-nav-state-')),value=store??new EvidenceStore(directory);
  const result=await buildApp(config(directory),{store:value,agent:inactive,backgroundWorker:false});
  t.after(async()=>{await result.app.close();value.close();await rm(directory,{recursive:true,force:true});});
  return {...result,directory};
}

const read=(app:Awaited<ReturnType<typeof buildApp>>['app'])=>app.inject({url:'/api/nav-state',headers});
const state=(response:{json():unknown})=>response.json() as NavState;

test('NV2-01 a plugin badge count appears and changes the ETag',async t=>{
  const {app}=await fixture(t);
  let count=2;
  const unregister=registerNavBadge('generated.queue',()=>count);
  t.after(unregister);
  const first=await read(app);
  assert.equal(first.statusCode,200);
  assert.equal(state(first).badges['generated.queue'],2);
  assert.equal(typeof first.headers.etag,'string');
  assert.match(String(first.headers.etag),/^"[^"]+"$/);
  count=3;
  const second=await read(app);
  assert.equal(second.statusCode,200);
  assert.equal(state(second).badges['generated.queue'],3);
  assert.notEqual(second.headers.etag,first.headers.etag);
});

test('NV2-02 stopping a plugin removes its badge without touching the others',async t=>{
  const {app}=await fixture(t);
  const unregister=registerNavBadge('generated.queue',()=>4);
  const active=await read(app);
  assert.equal(state(active).badges['generated.queue'],4);
  unregister();
  const stopped=await read(app);
  assert.equal(stopped.statusCode,200);
  assert.equal('generated.queue' in state(stopped).badges,false);
  assert.equal(state(stopped).badges.connections,false);
  assert.equal(state(stopped).badges.ideas,state(active).badges.ideas);
});

test('NV2-03 adding a library item changes only the library revision',async t=>{
  const {app}=await fixture(t);
  const before=state(await read(app));
  assert.deepEqual(Object.keys(before.revisions).sort(),[...revisionKeys].sort());
  const note={id:randomUUID(),deviceId:'generated-device',deviceName:'Generated device',platform:'import',capturedAt:new Date().toISOString(),text:'Generated navigation note'};
  const created=await app.inject({method:'POST',url:'/api/notes',headers,payload:note});
  assert.equal(created.statusCode,201);
  const after=state(await read(app));
  assert.notEqual(after.revisions.library,before.revisions.library);
  for(const key of revisionKeys)if(key!=='library')assert.equal(after.revisions[key],before.revisions[key],`${key} must not change for a library item`);
});

test('NV2-04 an unchanged poll returns 304 without a body',async t=>{
  const {app}=await fixture(t);
  const first=await read(app);
  assert.equal(first.statusCode,200);
  const second=await app.inject({url:'/api/nav-state',headers:{...headers,'if-none-match':String(first.headers.etag)}});
  assert.equal(second.statusCode,304);
  assert.equal(second.body,'');
  assert.equal(second.headers.etag,first.headers.etag);
  assert.equal((await read(app)).statusCode,200);
});

test('NV2-05 one failing badge is omitted, diagnosed, and the rest still answer',async t=>{
  const {app,diagnostics}=await fixture(t);
  const unregisterQueue=registerNavBadge('generated.queue',()=>2);
  const unregisterBroken=registerNavBadge('generated.failing',()=>{throw Error('Generated badge failure');});
  t.after(()=>{unregisterQueue();unregisterBroken();});
  const failures=()=>diagnostics.events(0,500).items.filter(event=>event.event==='request.failed'&&event.category==='internal').length;
  const before=failures();
  const response=await read(app);
  assert.equal(response.statusCode,200);
  const badges=state(response).badges;
  assert.equal(badges['generated.queue'],2);
  assert.equal('generated.failing' in badges,false);
  assert.ok(failures()>before,'the rejected badge is recorded as a diagnostic');
});

test('NV2-06 the connections dot follows existing source health',async t=>{
  const {app,sources}=await fixture(t);
  sources.register({id:'generated-source',name:'Generated source',kind:'local-files',deviceId:'generated-device',platform:'import',retention:'snapshot',enabled:true});
  sources.reportStatus('generated-source',{state:'permission_required',code:'generated_permission_required'});
  const attention=state(await read(app));
  assert.equal(attention.badges.connections,true);
  sources.reportStatus('generated-source',{state:'idle'});
  const settled=state(await read(app));
  assert.equal(settled.badges.connections,false);
});

test('NV2-07 a 100k item library still executes a fixed number of statements',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-nav-state-scale-'));
  const store=new EvidenceStore(directory);
  const executed:string[]=[];
  const original=store.db.prepare.bind(store.db);
  (store.db as unknown as {prepare:(sql:string)=>StatementSync}).prepare=(sql:string)=>{
    const statement=original(sql),get=statement.get.bind(statement);
    statement.get=((...args:Parameters<StatementSync['get']>)=>{executed.push(sql);return get(...args);}) as StatementSync['get'];
    return statement;
  };
  const {app}=await buildApp(config(directory),{store,agent:inactive,backgroundWorker:false});
  t.after(async()=>{await app.close();store.close();await rm(directory,{recursive:true,force:true});});
  for(let start=1;start<=100000;start+=10000)store.db.exec(`WITH RECURSIVE generated(x) AS (SELECT ${start} UNION ALL SELECT x+1 FROM generated WHERE x<${start+9999}) INSERT INTO changes(id,operation,changed_at) SELECT 'generated-library-'||x,'upsert','2026-01-01T00:00:00.000Z' FROM generated`);
  const navSql=new Set([
    'SELECT COALESCE(MAX(seq),0) AS value FROM changes',
    'SELECT COUNT(*) AS count,COALESCE(SUM(revision),0) AS total FROM assistant_cards',
    'SELECT COUNT(*) AS count,COALESCE(SUM(revision),0) AS total FROM assistant_commitments',
    'SELECT COUNT(*) AS count,COALESCE(SUM(revision),0) AS total FROM assistant_matters',
    "SELECT COUNT(*) AS count,COALESCE(SUM(json_extract(json,'$.version')),0) AS total FROM memories",
    "SELECT COUNT(*) AS count,MAX(json_extract(json,'$.updatedAt')) AS latest FROM source_connections",
    'SELECT COALESCE(MAX(revision),0) AS value FROM plugin_center WHERE id=1',
    "SELECT EXISTS(SELECT 1 FROM source_connections WHERE COALESCE(json_extract(json,'$.enabled'),1)=1 AND json_extract(json,'$.status.state') IN ('permission_required','error')) AS value",
  ]);
  executed.length=0;
  const response=await read(app);
  assert.equal(response.statusCode,200);
  assert.equal(Number((store.db.prepare('SELECT COUNT(*) AS count FROM changes').get() as {count:number}).count),100000);
  const navExecutions=executed.filter(sql=>navSql.has(sql));
  assert.equal(navExecutions.length,8,'one aggregate per revision plus the connections flag');
  assert.equal(new Set(navExecutions).size,8,'each navigation aggregate runs once per poll');
});

test('NV2-08 scoped Agent credentials are refused while the owner token succeeds',async t=>{
  const {app,connections}=await fixture(t),mcpConfig={directory:join(tmpdir(),'generated-agent-navigation'),mcpEnabled:true};
  const readToken=(await connections.mintMcp({serverUrl:'https://generated.invalid',label:'Generated read agent',access:'read'},mcpConfig)).config.mcpServers.mote.headers.Authorization;
  const writeToken=(await connections.mintMcp({serverUrl:'https://generated.invalid',label:'Generated write agent',access:'write'},{...mcpConfig,mcpWriteEnabled:true,mcpWriteSourceIds:['generated-source']})).config.mcpServers.mote.headers.Authorization;
  assert.equal((await app.inject({url:'/api/nav-state',headers:{authorization:readToken}})).statusCode,403);
  assert.equal((await app.inject({url:'/api/nav-state',headers:{authorization:writeToken}})).statusCode,403);
  assert.equal((await read(app)).statusCode,200);
});
