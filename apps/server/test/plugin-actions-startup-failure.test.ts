import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import {defaultDistribution,storageProvider} from '../src/distribution/default.js';
import type {CentralDomainPlugin} from '../src/domain-activation.js';
import type {CentralDistribution} from '../src/bootstrap.js';
import {actionsServicesContract} from '../src/plugins/actions-services.js';
import {insightServicesContract} from '../src/plugins/insight-services.js';
import {authorizeFixtureModels} from './fixtures/model-authorization.js';
import {hostRun} from './fixtures/host-run.js';
import type {Store} from '../src/store.js';

const contains=(error:unknown,wanted:unknown):boolean=>error===wanted||error instanceof AggregateError&&error.errors.some(child=>contains(child,wanted));
async function bounded<T>(promise:Promise<T>,label:string):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_done,reject)=>{timer=setTimeout(()=>reject(Error('Timed out waiting for '+label)),5000);})]);}
  finally{clearTimeout(timer);}
}

test('failed consumer startup fences its old Actions response, preserves both failures and lets authorized work recover under a new owner and grant',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mote-gov-actions-independent-'));
  const token='generated-actions-independent-owner',headers={authorization:'Bearer '+token};
  const config:ConfigurationPlatformOptions={path:(dataDir)+'/mote.yaml',privateCredential:{token:token,tokenPath:join(dataDir,'token')},initialDocument:{version:1,revision:0,storage:{dataDir:dataDir,dataKey:'79'.repeat(32),contentEncryptionEnabled:true,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'fixture-model',baseUrl:'https://generated.invalid',apiKey:'generated-unused',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'}}};
  const text='Generated appointment is scheduled on 18 September 2099.';
  const event={title:'Generated appointment',start:'2099-09-18T15:00:00Z',end:'2099-09-18T16:00:00Z',timeZone:'UTC',allDay:false,location:'Generated room',description:''};
  const startupFailure=Error('Generated later declared plugin start failure'),cleanupFailure=Error('Generated later declared plugin cleanup failure');
  let entered!:()=>void,release!:()=>void,signal:AbortSignal|undefined,extractions=0,releases=0;
  let currentStore:Store|undefined,preparedStore:Store|undefined,activeOwner='';
  const executions:{owner:string;stepId:string;operationId:string;fence:string;attempt:number;responseAfterAbort:boolean}[]=[];
  let rollback:{proposals:number;steps:{id:string;state:string;error:string|null;attempts:number}[]}|undefined;
  const observe=(distribution:CentralDistribution,captureRollback=false):CentralDistribution=>({...distribution,
    plugins:distribution.plugins.map(plugin=>{
      const activation=plugin.activation;
      if(plugin.contribution.id!=='actions-services'||!activation)return plugin;
      return {...plugin,activation:{...activation,create(context,bindings){activeOwner=context.scope.identity.activationId;return activation.create(context,bindings);}}};
    }),
    foundations:distribution.foundations.map(provider=>provider.kind==='storage'?{...provider,async create(context,options){
      const value=await storageProvider.create(context,options);currentStore=value.store;
      if(captureRollback){
        preparedStore=value.store;const close=value.store.close.bind(value.store);let captured=false;
        value.store.close=()=>{
          if(!captured){captured=true;rollback={proposals:Number(value.store.db.prepare('SELECT count(*) n FROM action_proposals').get()!.n),
            steps:value.store.db.prepare("SELECT id,state,error,attempts FROM execution_steps WHERE kind='actions.extract'").all() as {id:string;state:string;error:string|null;attempts:number}[]};}
          return close();
        };
      }
      return value;
    }}:provider),
  });
  const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
  const nodes:Awaited<ReturnType<typeof buildApp>>[]=[],polls:Promise<unknown>[]=[];
  const timers=new Set<ReturnType<typeof setInterval>>(),interval=globalThis.setInterval,clear=globalThis.clearInterval;
  t.mock.method(globalThis,'setInterval',(callback,delay,...args)=>{const timer=interval(callback,delay,...args);if(delay===15000)timers.add(timer);return timer;});
  t.mock.method(globalThis,'clearInterval',timer=>{timers.delete(timer as ReturnType<typeof setInterval>);return clear(timer);});
  t.after(async()=>{release();for(const node of nodes.reverse())await node.app.close();await rm(dataDir,{recursive:true,force:true});});
  const agent={configured:true,close:async()=>{},async query(input:QueryInput,lease?:{onFinalizer?:(owner:'host')=>void}){
    lease?.onFinalizer?.('host');
    if(input.skill==='calendar-extraction'){
      extractions++;
      const stepId='actions:'+input.traceContext!.jobId,row=currentStore!.db.prepare('SELECT operation_id,fence,attempts FROM execution_steps WHERE id=?').get(stepId)!;
      const execution={owner:activeOwner,stepId,operationId:String(row.operation_id),fence:String(row.fence),attempt:Number(row.attempts),responseAfterAbort:false};executions.push(execution);
      if(extractions===1){signal=input.signal;input.signal?.addEventListener('abort',release,{once:true});entered();await held;}
      execution.responseAfterAbort=input.signal!.aborted;
    }
    hostRun(input);const id=input.evidenceIds![0],evidence=[{id,quote:text}];
    const answer=input.skill==='calendar-extraction'?{actions:[{kind:'calendar.create',event,uncertainty:'Generated independent proposal',sameAs:null,evidence}]}:
      {summary:'Generated appointment',evidence,events:[],memoryCandidates:[],actionCues:[{kind:'calendar.create',event,uncertainty:'Generated independent proposal',evidence}]};
    return {answer:JSON.stringify(answer),citations:[{id,capturedAt:'2026-01-01T00:00:00Z',appName:'Generated',excerpt:text}],trace:[],runId:randomUUID()};
  }};
  async function request(node:Awaited<ReturnType<typeof buildApp>>,url:string,payload?:unknown,method=payload===undefined?'GET':'POST',expected=200){
    const response=await node.app.inject({url,headers,method:method as 'GET'|'POST'|'PUT',...(payload===undefined?{}:{payload})});
    assert.equal(response.statusCode,expected,response.body);return response.json();
  }
  const seed=await buildApp(config,{agent,backgroundWorker:false});nodes.push(seed);await seed.app.ready();
  await authorizeFixtureModels(seed);
  await request(seed,'/api/actions/settings',{revision:seed.configService.revision,authorizationRevision:seed.actions.authorizationRevision(),settings:{enabled:true,timeZone:'UTC',reviewDeviceIds:['generated-input']}},'PUT');
  await seed.actionsServices.poll();assert.equal(extractions,0);
  seed.sources.register({id:'generated-independent-actions-source',kind:'custom',name:'Generated source',deviceId:'generated-input',platform:'import'});
  await seed.sources.upsert('generated-independent-actions-source',{externalId:'one',revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'message',layer:'original',text});
  const note={id:randomUUID(),deviceId:'generated-independent-note',deviceName:'Generated',platform:'android',capturedAt:'2026-11-17T00:00:00Z',text:'Generated note retained through a later domain startup failure'};
  await request(seed,'/api/notes',note,'POST',201);
  const todo={id:randomUUID(),title:'Generated Todo retained through failed startup'};await request(seed,'/api/todos',todo,'POST',201);
  await seed.app.close();assert.equal(timers.size,0);assert.equal(extractions,0);

  let consumerStarted=false;
  const failing:CentralDomainPlugin={
    contribution:{id:'generated-later-actions-consumer',version:'1.0.0',surface:'data',runtime:'host'},declaration:{id:'generated-later-actions-consumer',apiVersion:'1'},replacement:'hot',
    activation:{featureId:'mote.generated-later-actions-consumer',requires:{
      actions:{provider:'actions-services',service:actionsServicesContract},insights:{provider:'insight-services',service:insightServicesContract},
    },async create(context,bindings){
      const actions=await context.services.acquire(actionsServicesContract,bindings.actions!),insights=await context.services.acquire(insightServicesContract,bindings.insights!);
      assert.equal(bindings.actions!.provider.scope.activationId,activeOwner);
      context.scope.defer(async()=>{await actions.release();await insights.release();releases++;throw cleanupFailure;});
      return {
        prepare(){assert.equal(actions.value.available,true);assert.equal(insights.value.available,true);},
        async start(){consumerStarted=true;polls.push(actions.value.poll().then(()=>({ok:true}),error=>({error})));await bounded(started,'real Actions extraction');throw startupFailure;},
        quiesce(){},stop(){},dispose(){},route:{id:'mote.generated-later-actions-consumer',mount(){throw Error('The failed consumer must not mount HTTP');}},
      };
    }},
  };
  const distribution=observe({...defaultDistribution,features:[...defaultDistribution.features,'mote.generated-later-actions-consumer'],plugins:[...defaultDistribution.plugins,failing]},true);
  let rejected:unknown;try{await buildApp(config,{agent,backgroundWorker:false,distribution});}catch(error){rejected=error;}
  assert.ok(contains(rejected,startupFailure),'the original startup failure is retained');assert.ok(contains(rejected,cleanupFailure),'a true scope cleanup failure is retained');
  assert.equal(consumerStarted,true);assert.equal(releases,1);assert.equal(signal?.aborted,true);await bounded(Promise.all(polls),'accepted poll disposal');
  assert.equal(timers.size,0,'all owned Actions poll intervals are released after rollback');assert.equal(extractions,1);
  assert.ok(preparedStore);assert.throws(()=>preparedStore!.stats(),'rollback must release the owned profile vault');

  assert.equal(rollback!.proposals,0,'the failed activation cannot commit its late model response');
  assert.equal(executions.length,1);assert.equal(executions[0].responseAfterAbort,true);
  const interrupted=rollback!.steps.find(step=>step.id===executions[0].stepId)!;
  assert.equal(interrupted.state,'waiting');assert.equal(interrupted.error,'interrupted');
  const restored=await buildApp(config,{agent,backgroundWorker:false,distribution:observe(defaultDistribution)});nodes.push(restored);await restored.app.ready();
  await restored.actionsServices.poll();
  assert.equal(extractions,2,'existing enabled owner authorization permits normal interrupted-work recovery without an extra retry command');
  assert.equal(executions[1].stepId,executions[0].stepId);assert.equal(executions[1].operationId,executions[0].operationId);
  assert.notEqual(executions[1].owner,executions[0].owner);assert.notEqual(executions[1].fence,executions[0].fence);
  assert.equal(executions[1].responseAfterAbort,false);
  assert.equal(restored.actions.engine,restored.executor);assert.equal(restored.actionsServices.available,true);assert.equal(restored.insightServices.available,true);
  assert.equal((await request(restored,'/api/notes/'+note.id)).ocrText,note.text);
  assert.equal((await request(restored,'/api/todos')).items.length,1);
  assert.equal((await request(restored,'/api/insight-runs')).items.length,0);
  assert.equal(restored.store.db.prepare('SELECT count(*) n FROM action_proposals').get()!.n,1,'the new activation may publish its authorized recovered result');
  const proposal=(await request(restored,'/api/actions')).items[0];
  await restored.actionsServices.poll();assert.equal(extractions,2,'a completed recovered input is not executed twice');
  await restored.app.close();assert.equal(timers.size,0);
  const reopened=await buildApp(config,{agent,backgroundWorker:false,distribution:observe(defaultDistribution)});nodes.push(reopened);await reopened.app.ready();
  await reopened.actionsServices.poll();assert.equal(extractions,2);
  assert.equal((await request(reopened,'/api/actions')).items[0].id,proposal.id);
  assert.equal((await request(reopened,'/api/notes/'+note.id)).ocrText,note.text);
  assert.equal((await request(reopened,'/api/todos')).items.length,1);
  await reopened.app.close();assert.equal(timers.size,0);
  t.diagnostic(JSON.stringify({extractions,failedConsumerReleases:releases,remainingOwnedPolls:timers.size,rollback,executions}));
});
