import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {execFile,execFileSync,type ExecFileException} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {profilePaths,initialize} from '../../../scripts/profile-lib.mjs';
import {configFromFile} from '../src/config.js';
import {buildApp} from '../src/app.js';
import {createModelAgent as productionCreateModelAgent,type ModelAgentFactory} from '../src/model-agent.js';
import {appCleanup} from './fixtures/app-cleanup.js';

type Counters={queries:number};

function countingFactory(counters:Counters):ModelAgentFactory{
  return async(settings,reader,host)=>{
    const inner=await productionCreateModelAgent(settings,reader,undefined,host?.runModel,host?.authorizeModelRequest);
    return {
      get configured(){return inner.configured;},
      close:()=>inner.close(),
      query:(input,lease)=>{counters.queries++;return inner.query(input,lease);},
    };
  };
}

async function profile(t:TestContext){
  const root=await mkdtemp(join(tmpdir(),'mote-a3-unconfigured-'));
  const cleanup=appCleanup(t,root);
  const paths=profilePaths('test',root);
  await initialize(paths);
  const config=configFromFile(paths.configFile,{initializeCredentials:false});
  assert.equal(config.model,'');
  assert.equal(config.embeddingModel,'');
  return {root,config,cleanup};
}

async function codexSpy(t:TestContext,root:string){
  const home=join(root,'generated-codex-home'),marker=join(root,'generated-codex-invoked'),executable=join(root,'generated-codex');
  await mkdir(home,{recursive:true,mode:0o700});
  await writeFile(join(home,'auth.json'),'{"generated":true}\n',{mode:0o600});
  await writeFile(executable,`#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(marker)}\nexit 0\n`,{mode:0o700});
  const previous={bin:process.env.MOTE_CODEX_BIN,home:process.env.MOTE_CODEX_HOME};
  process.env.MOTE_CODEX_BIN=executable;process.env.MOTE_CODEX_HOME=home;
  t.after(()=>{if(previous.bin===undefined)delete process.env.MOTE_CODEX_BIN;else process.env.MOTE_CODEX_BIN=previous.bin;if(previous.home===undefined)delete process.env.MOTE_CODEX_HOME;else process.env.MOTE_CODEX_HOME=previous.home;});
  // The guard is not a tautology: running the generated transport writes the marker.
  execFileSync(executable,['generated-probe']);
  assert.equal(await readFile(marker,'utf8'),'generated-probe\n');
  await rm(marker,{force:true});
  return {invoked:async()=>readFile(marker,'utf8').then(()=>true,()=>false)};
}

function fetchSpy(t:TestContext){
  const original=globalThis.fetch,requests:string[]=[];
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{requests.push(input instanceof Request?input.url:String(input));return original(input,init);}) as typeof fetch;
  t.after(()=>{globalThis.fetch=original;});
  return requests;
}

test('a generated unconfigured profile starts, stores and reads a note, and drains a tick without a model, Codex login or embedding request',async t=>{
  const {root,config,cleanup}=await profile(t),counters={queries:0},requests=fetchSpy(t),codex=await codexSpy(t,root);
  let node=cleanup.own(await buildApp(config,{backgroundWorker:false,createModelAgent:countingFactory(counters)}));
  const headers={authorization:`Bearer ${config.token}`},id=randomUUID();
  const created=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-a3-device',deviceName:'Generated A3',platform:'android',capturedAt:'2026-11-01T00:00:00.000Z',text:'Generated note from an unconfigured profile.'}});
  assert.equal(created.statusCode,201,created.body);
  await node.executor.tick();
  const read=await node.app.inject({url:`/api/notes/${id}`,headers});
  assert.equal(read.statusCode,200,read.body);
  assert.equal(read.json().ocrText,'Generated note from an unconfigured profile.');
  assert.equal(counters.queries,0,'no model query may be attempted');
  assert.equal((node.store.db.prepare('SELECT count(*) AS n FROM model_usage').get() as {n:number}).n,0,'no model usage receipt may be written');
  assert.deepEqual(requests,[],'no model or embedding transport request may leave the process');
  assert.equal(await codex.invoked(),false,'Codex login must not be started');
  await node.app.close();
  node=cleanup.own(await buildApp(config,{backgroundWorker:false,createModelAgent:countingFactory(counters)}));
  const reopened=await node.app.inject({url:`/api/notes/${id}`,headers});
  assert.equal(reopened.statusCode,200,reopened.body);
  assert.equal(counters.queries,0);
  assert.equal((node.store.db.prepare('SELECT count(*) AS n FROM model_usage').get() as {n:number}).n,0);
  assert.deepEqual(requests,[]);
  assert.equal(await codex.invoked(),false);
});

test('a generated unconfigured profile keeps the existing 503 model_not_configured query state',async t=>{
  const {config,cleanup}=await profile(t),counters={queries:0},requests=fetchSpy(t);
  const node=cleanup.own(await buildApp(config,{backgroundWorker:false,createModelAgent:countingFactory(counters)}));
  const headers={authorization:`Bearer ${config.token}`};
  const status=(await node.app.inject({url:'/api/status',headers})).json();
  assert.equal(status.agent.configured,false,'the existing unconfigured state feeds Ask');
  assert.equal(status.agent.model,null);
  const response=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated query against an unconfigured profile'}});
  // Recorded before this change with the same models:{} configuration: 503/model_not_configured.
  assert.equal(response.statusCode,503,response.body);
  assert.equal(response.json().error,'model_not_configured');
  assert.equal(counters.queries,0);
  assert.deepEqual(requests,[]);
  assert.equal((node.store.db.prepare('SELECT count(*) AS n FROM model_usage').get() as {n:number}).n,0);
});

test('a failed assertion releases held requests and closes every app before deleting its temporary profile',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mote-app-cleanup-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'profile'),report=join(root,'closed.json');
  await mkdir(directory,{mode:0o700});
  const result=await new Promise<{error:ExecFileException|null;stdout:string;stderr:string}>(resolve=>{
    execFile(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/app-cleanup-worker.ts',import.meta.url)),directory,report],
      {timeout:30000,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR}},(error,stdout,stderr)=>resolve({error,stdout,stderr}));
  });
  assert.equal(result.error?.signal??null,null,result.stderr+'\n'+result.stdout);
  assert.equal(result.error?.code,1,'the original assertion must remain a failure');
  assert.match(result.stdout,/Generated cleanup regression assertion/);
  assert.deepEqual(JSON.parse(await readFile(report,'utf8')),['original','query-settled','restarted']);
  await assert.rejects(access(directory),{code:'ENOENT'},'the temporary profile is removed after all apps close');
});
