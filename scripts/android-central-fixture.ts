import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp,type QueryAgent} from '../apps/server/src/app.js';
import type {Config} from '../apps/server/src/config.js';
import {noteCapture} from '@mote/shared';

/** Dedicated loopback node with generated evidence and a deterministic fixture agent. */
const dataDir=await mkdtemp(join(tmpdir(),'mote-android-central-'));
const token='generated-native-central-owner-token-123456';
const config:Config={dataDir,dataKey:undefined,token,tokenPath:join(dataDir,'owner-token'),host:'127.0.0.1',port:47883,profile:'test',
 tokenFromEnvironment:true,maxStorageBytes:64*1024*1024,maxExportBytes:16*1024*1024,retentionDays:0,insightIntervalHours:0,
 allowedOrigins:[],model:'generated-fixture-model',modelBaseUrl:'https://fixture.invalid',apiKey:'generated-fixture-key',
 allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:true};
const agent:QueryAgent={configured:true,close:async()=>{},query:async input=>{
 input.onProgress?.({stage:'tool',tool:'search_context',phase:'started'});
 await new Promise<void>(resolve=>setTimeout(resolve,1500));
 input.onProgress?.({stage:'tool',tool:'search_context',phase:'completed',count:1});
 return {answer:'Generated native answer · 原生回答 fixture',citations:[],trace:[],runId:randomUUID()};
}};
const value=await buildApp(config,{agent,createModelAgent:async()=>agent});
await value.store.ingest(noteCapture({id:randomUUID(),deviceId:'generated-fixture-phone',deviceName:'Generated phone',platform:'android',
 capturedAt:new Date().toISOString(),text:'Generated native note · 中文 🐾 <script>untrusted evidence</script>'}));
if (process.env.MOTE_SETTINGS_UI_FIXTURE === '1') {
 value.executor.register({kind:'settings-ui-fixture',pool:'settings-ui-fixture',concurrency:()=>1,validate:()=>true,execute:async()=>null,commit:()=>{}});
 for(let i=0;i<36;i++)value.executor.enqueue('file:generated-ui-'+i,'settings-ui-fixture',{}, {initial:{state:'succeeded',attempts:0,availableAt:0}});
}
await value.app.listen({host:config.host,port:config.port});
if (process.env.MOTE_SETTINGS_UI_FIXTURE === '1') {
 const origin=`http://127.0.0.1:${config.port}`;
 for(let i=0;i<5;i++) {
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const view=await (await fetch(origin+'/api/model-settings',{headers})).json() as {revision:number;profiles:{id:string}[]};
  const response=await fetch(origin+'/api/model-settings/profiles/'+encodeURIComponent(view.profiles[0]!.id)+'/copy',{
   method:'POST',headers,body:JSON.stringify({revision:view.revision,id:'generated-native-provider-'+i,name:'合成预设 '+(i+1),includeCredentials:false})});
  if(!response.ok)throw new Error('Generated provider fixture failed');
 }
}
await writeFile(join(dataDir,'fixture.json'),JSON.stringify({origin:`http://127.0.0.1:${config.port}`,token}));
console.log(`Generated Android central fixture listening on port ${config.port}`);
let closing=false;
async function close(){if(closing)return;closing=true;await value.app.close();await rm(dataDir,{recursive:true,force:true});}
process.on('SIGINT',()=>{void close();});process.on('SIGTERM',()=>{void close();});
