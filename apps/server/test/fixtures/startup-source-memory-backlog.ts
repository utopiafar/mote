import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {serializeConfigDocument} from '@mote/shared/config-file';
import {buildApp} from '../../src/app.js';
import {configFromFile} from '../../src/config.js';
import {startServer} from '../../src/start-server.js';
import {MaterialMemoryWork} from '../../src/material-memory-work.js';
import {MemoryPipeline} from '../../src/memory-pipeline.js';
import type {Store} from '../../src/store.js';
import type {QueryAgent} from '../../src/query-agent.js';
import {authorizeFixtureModels} from './model-authorization.js';
import {seedSourceMemoryBacklog} from './source-memory-backlog.js';

const [mode,directory,port]=process.argv.slice(2),configFile=join(directory,'mote.yaml');
const webRoot=process.env.MOTE_STARTUP_WEB_ROOT??join(directory,'web');
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const agent:QueryAgent={configured:true,close:async()=>{},query:async input=>{
 process.send?.({type:'model'});assert.ok(input.signal);input.signal.throwIfAborted();
 return new Promise((_resolve,reject)=>input.signal!.addEventListener('abort',()=>reject(input.signal!.reason),{once:true}));
}};
if(mode==='seed'){
 await writeFile(configFile,serializeConfigDocument({version:1,revision:0,
  server:{profile:'test',runtime:'native',host:'127.0.0.1',port:Number(port),token:'generated-source-backlog-owner-only'},
  storage:{dataDir:directory,maxExportBytes:1024**2,},
  models:{deployment:{provider:'custom',protocol:'openai-completions',model:'generated-source-model',baseUrl:'https://generated.invalid/v1',apiKey:'generated-model-fixture-only'}},
  diagnostics:{enabled:true,level:'debug',debug:true},
 }),{mode:0o600});
 if(!process.env.MOTE_STARTUP_WEB_ROOT){
  await mkdir(join(webRoot,'assets'),{recursive:true});
  await writeFile(join(webRoot,'index.html'),'<!doctype html><title>Generated source startup web</title>');
  await writeFile(join(webRoot,'build-info.json'),await readFile(new URL('../../package.json',import.meta.url),'utf8'));
  for(let index=0;index<175;index++)await writeFile(join(webRoot,'assets',`generated-${index}.js`),'/* Generated static source startup asset */'.repeat(100));
 }
 const node=await buildApp(configFromFile(configFile),{backgroundWorker:false,webRoot,agent});
 try{
  await node.app.ready();await authorizeFixtureModels(node);
  const {ids,receipts,text,sourceId}=await seedSourceMemoryBacklog(node);
  // Reproduce saved work that has not yet had a native transport allowance.
  // Reopening it must measure the real native request/review envelope while
  // retaining the entire frozen job catalog and all source claims.
  const {apiKey:_apiKey,headers:_headers,extraBody:_extraBody,...settings}=node.modelSettings.current();
  await node.modelSettings.update({revision:node.modelSettings.view().revision,settings:{...settings,provider:'codex',protocol:'codex-app-server',baseUrl:'',model:'gpt-6.1-terra',reasoningEffort:'auto',serviceTier:'default',maxTokens:65536,modelRequestTimeoutMs:null,agentTimeoutMs:null,apiKey:''}});
  await authorizeFixtureModels(node);
  // Persist a full dormant page ahead of a resumed request, plus completed
  // history. These are generated lifecycle snapshots, never owner originals.
  for(const id of ids.slice(0,65)){
   node.store.db.prepare("UPDATE memory_jobs SET json=json_set(json,'$.status','paused') WHERE id=?").run(id);
   node.store.db.prepare("UPDATE material_memory_requests SET ready_at=?,error='memory_job_paused' WHERE job_id=?").run(Number.MAX_SAFE_INTEGER,id);
  }
  for(const id of ids.slice(65,205)){
   node.store.db.prepare("UPDATE memory_batches SET json=json_set(json,'$.status','completed') WHERE job_id=?").run(id);
   node.store.db.prepare("UPDATE memory_jobs SET json=json_set(json,'$.status','completed') WHERE id=?").run(id);
   node.store.db.prepare('UPDATE material_memory_requests SET ready_at=?,error=NULL WHERE job_id=?').run(Number.MAX_SAFE_INTEGER,id);
  }
  const material=String(node.store.db.prepare('SELECT material_id FROM material_memory_requests WHERE job_id=?').get(ids[0])!.material_id);
  const asset=(await readdir(join(webRoot,'assets'))).filter(name=>name.endsWith('.js')).sort().at(-1)!;assert.ok(asset);
  await writeFile(join(directory,'expected.json'),JSON.stringify({ids,resumedId:ids[64],receipts,text,sourceId,material,range:node.materials.read(material,{offset:27,length:81}),webHash:digest(await readFile(join(webRoot,'index.html'))),asset:'/assets/'+asset,assetHash:digest(await readFile(join(webRoot,'assets',asset)))}),{mode:0o600});
 }finally{await node.app.close();}
 process.send?.({type:'seeded',jobs:540,ranges:261});process.disconnect?.();
}else if(mode==='serve'){
 const expected=JSON.parse(await readFile(join(directory,'expected.json'),'utf8')) as {resumedId:string};
 let insideDrain=0,drains=0,rejoins=0,fullDetailReads=0;
 const get=MemoryPipeline.prototype.get;
 MemoryPipeline.prototype.get=function(...args){if(insideDrain)fullDetailReads++;return get.apply(this,args);};
 const prototype=MaterialMemoryWork.prototype as unknown as {rejoinResumed:(...args:unknown[])=>void};
 const rejoin=prototype.rejoinResumed;
 prototype.rejoinResumed=function(...args){rejoins++;return rejoin.apply(this,args);};
 const drain=MaterialMemoryWork.prototype.drainPlanned;
 MaterialMemoryWork.prototype.drainPlanned=async function(...args){
  const began=performance.now(),cpu=process.cpuUsage();insideDrain++;
  try{return await drain.apply(this,args);}finally{
   insideDrain--;drains++;
   const store=(this as unknown as {store:Store}).store;
   const request=store.db.prepare('SELECT ready_at,error FROM material_memory_requests WHERE job_id=?').get(expected.resumedId)!;
   const used=process.cpuUsage(cpu);
   process.send?.({type:'drain',drains,rejoins,fullDetailReads,durationMs:performance.now()-began,cpuMs:(used.user+used.system)/1000,resumed:request.error===null&&Number(request.ready_at)<Number.MAX_SAFE_INTEGER});
  }
 };
 await startServer({dependencies:{webRoot,agent}});
}else throw Error('Unknown generated source startup fixture mode');
