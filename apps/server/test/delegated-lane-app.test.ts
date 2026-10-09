import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentYieldError} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

const token='generated-lane-owner',headers={authorization:`Bearer ${token}`};
const config=(dataDir:string):Config=>({dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-lane-fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',agentConcurrency:1,llmConcurrency:1,agentTimeoutMs:30000});
async function until<T>(read:()=>T|undefined):Promise<T>{for(let n=0;n<200;n++){const result=read();if(result!==undefined)return result;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Generated lane fixture did not settle');}

test('production app reserves Ask and inherited research capacity while background model work is uncooperative',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-lane-app-'));let release!:()=>void,entered!:()=>void,calls=0;
 const held=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve),order:string[]=[];
 const node=await buildApp(config(directory),{backgroundWorker:true,agent:{configured:true,close:async()=>{},query:async input=>{
  order.push(input.executionLane??'background');
  if(input.executionLane!=='interactive'){calls++;entered();await held;}
  else if(input.hostControlChannel){
   const work=input.taskContext!.delegation as {units:{artifactId?:string}[]};
   if(!work.units.length){await input.hostControlChannel.execute('delegation_submit',{units:[{id:'research',capabilityId:'context.research',title:'Generated independent research',goal:'Inspect generated context',input:{question:'Generated research'}}]});await input.hostControlChannel.execute('delegation_yield',{});throw new AgentYieldError();}
   await input.hostControlChannel.execute('delegation_read',{artifactId:work.units[0].artifactId});
  }
  return {answer:'Generated scoped answer',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[]}};
 }}});
 t.after(async()=>{release();await node.app.close();rmSync(directory,{recursive:true,force:true});});
 await node.app.ready();
 node.featureServices.delegation.registerCoordinator({id:'generated.background',execute:async({signal})=>node.featureServices.queryAgent({question:'Generated background task',executionLane:'background',signal})});
 node.featureServices.delegation.start({id:'generated-background',profileId:'generated.background',goal:'Generated background workload',input:{executionLane:'interactive'},allowedCapabilities:[]});
 await started;
 const id=randomUUID(),accepted=await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'Generated Ask research'}}});assert.equal(accepted.statusCode,202,accepted.body);
 await until(()=>node.featureServices.queryRuns.get(id).status==='completed'?true:undefined);
 assert.equal(calls,1);assert.deepEqual(order,['background','interactive','interactive','interactive']);
 assert.equal(node.featureServices.delegation.get('generated-background').status,'running','Ask does not preempt background');
 assert.deepEqual(node.executor.poolSnapshot('delegated-agents'),{background:{limit:1,running:1,waiting:0},interactive:{limit:2,running:0,waiting:0}});
 node.featureServices.delegation.cancel('generated-background');release();
 await until(()=>node.featureServices.agentGate.snapshot().active===0?true:undefined);
 assert.equal(node.featureServices.delegation.get('generated-background').status,'cancelled');assert.equal(node.featureServices.delegation.result('generated-background'),undefined);
});
