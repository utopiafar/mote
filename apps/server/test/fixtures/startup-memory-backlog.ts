import assert from 'node:assert/strict';
import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {serializeConfigDocument} from '@mote/shared/config-file';
import {buildApp} from '../../src/app.js';
import {configurationFromFile} from '../../src/config.js';
import {startServer} from '../../src/start-server.js';
import {MemoryInputAuthorization} from '../../src/memory-input-authorization.js';
import type {QueryAgent} from '../../src/query-agent.js';
import {seedMemoryControlBacklog} from './memory-control-backlog.js';
import {authorizeFixtureModels,withFixtureOwnerModelWork} from './model-authorization.js';

const [mode,directory,port]=process.argv.slice(2),configFile=join(directory,'mote.yaml');
const webRoot=process.env.MOTE_STARTUP_WEB_ROOT??join(directory,'web');
const agent:QueryAgent={configured:true,close:async()=>{},query:async input=>{
 process.send?.({type:'model'});
 assert.ok(input.signal,'generated model transport must be cancellable');input.signal.throwIfAborted();
 return new Promise((_resolve,reject)=>input.signal!.addEventListener('abort',()=>reject(input.signal!.reason),{once:true}));
}};
if(mode==='seed'){
 await writeFile(configFile,serializeConfigDocument({version:1,revision:0,
  server:{profile:'test',runtime:'native',host:'127.0.0.1',port:Number(port),token:'generated-startup-backlog-owner-only'},
  storage:{dataDir:directory,maxExportBytes:1024**2,},
  models:{deployment:{provider:'custom',protocol:'openai-completions',model:'generated-startup-model',baseUrl:'https://generated.invalid/v1',apiKey:'generated-model-fixture-only'}},
  diagnostics:{enabled:false,level:'silent'},
 }),{mode:0o600});
 if(!process.env.MOTE_STARTUP_WEB_ROOT){
  await mkdir(join(webRoot,'assets'),{recursive:true});
  await writeFile(join(webRoot,'index.html'),'<!doctype html><title>Generated startup web</title>');
  await writeFile(join(webRoot,'build-info.json'),await readFile(new URL('../../package.json',import.meta.url),'utf8'));
  for(let index=0;index<175;index++)await writeFile(join(webRoot,'assets',`generated-${index}.js`),'/* Generated static startup asset */'.repeat(100));
 }
 const node=await buildApp(configurationFromFile(configFile),{backgroundWorker:false,webRoot,agent});
 try{
  await node.app.ready();
  const grants=new MemoryInputAuthorization(node.store,()=>true,Date.now,node.memoryRecipeSettings);
  const {ids,receipt,text,evidenceRanges}=await seedMemoryControlBacklog({store:node.store,sources:node.sources,pipeline:node.memoryPipeline,grants});
  await authorizeFixtureModels(node);
  // Persist a real owner-authorized manual job through start/stop. Receipt
  // claims above remain unactivated. Recovering this independent manual job
  // exercises the same native-stage binding read against the whole backlog.
  const manualId=await withFixtureOwnerModelWork(node,async()=>{
   const job=node.memoryPipeline.create({evidenceIds:[receipt.id],evidenceRanges});void node.memoryPipeline.run(job.id).catch(()=>{});return job.id;
  });
  await writeFile(join(directory,'expected.json'),JSON.stringify({ids,manualId,receiptId:receipt.id,text}),{mode:0o600});
 }finally{await node.app.close();}
 const files=await readdir(join(webRoot,'assets'));
 process.send?.({type:'seeded',jobs:540,ranges:261,staticAssets:files.length});
 process.disconnect?.();
}else if(mode==='serve'){
 await startServer({dependencies:{webRoot,agent}});
}else throw Error('Unknown generated startup fixture mode');
