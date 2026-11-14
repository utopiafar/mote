import test from 'node:test';
import assert from 'node:assert/strict';
import {access,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {LightMyRequestResponse} from 'fastify';
import {buildApp} from '../../src/app.js';
import type {Config} from '../../src/config.js';
import type {ModelAgentFactory} from '../../src/model-agent.js';
import {appCleanup} from './app-cleanup.js';

const [directory,report]=process.argv.slice(2),closed:string[]=[];
test('a generated assertion failure still closes the restarted app and its held query',async t=>{
  const cleanup=appCleanup(t,directory);
  const config:Config={dataDir:directory,token:'generated-cleanup-owner',tokenPath:'fixture-only',host:'127.0.0.1',port:0,
    maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
    model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'https://fixture.invalid/v1',apiKey:'generated-key',
    allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:true};
  let release!:()=>void,started!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{started=resolve;});
  const factory:ModelAgentFactory=async()=>({configured:true,close:async()=>{},query:async()=>{
    started();await held;return {answer:'Generated answer',citations:[],trace:[],runId:'generated-run'};
  }});
  const start=async(label:string)=>{
    const node=cleanup.own(await buildApp(config,{backgroundWorker:false,createModelAgent:factory}));
    node.app.addHook('onClose',async()=>{
      // The profile must remain intact until each app has actually closed.
      await access(join(directory,'mote.yaml'));
      closed.push(label);await writeFile(report,JSON.stringify(closed));
    });
    return node;
  };
  const original=await start('original');await original.app.ready();await original.app.close();
  const restarted=await start('restarted');
  let pending:Promise<LightMyRequestResponse>;
  cleanup.beforeClose(async()=>{
    release();const response=await pending;assert.equal(response.statusCode,200,response.body);
    assert.equal(response.json().answer,'Generated answer');
    closed.push('query-settled');await writeFile(report,JSON.stringify(closed));
  });
  pending=restarted.app.inject({method:'POST',url:'/api/query',headers:{authorization:`Bearer ${config.token}`},payload:{question:'Generated held query'}});
  await began;
  assert.fail('Generated cleanup regression assertion');
});
