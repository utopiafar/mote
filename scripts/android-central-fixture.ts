import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp,type QueryAgent} from '../apps/server/src/app.js';
import type {ContextReader} from '@mote/agent';
import type {ConfigurationPlatformOptions} from '../apps/server/src/config.js';
import {noteCapture} from '@mote/shared';
import {prepareAndroidDetailFixture} from './android-ui-detail-fixture.js';

/** Dedicated loopback node with generated evidence and a deterministic fixture agent. */
const dataDir=await mkdtemp(join(tmpdir(),'mote-android-central-'));
const token='generated-native-central-owner-token-123456';
const detailFixture=process.env.MOTE_ANDROID_UI_DETAIL_FIXTURE==='1';
const firstDataFixture=process.env.MOTE_ANDROID_FIRST_DATA_FIXTURE==='1';
const fixturePort=firstDataFixture?47889:detailFixture?47884:47883;
const config:ConfigurationPlatformOptions={path:(dataDir)+'/mote.yaml',privateCredential:{token:token,tokenPath:join(dataDir,'owner-token')},initialDocument:{version:1,revision:0,storage:{dataDir:dataDir,dataKey:undefined,maxExportBytes:16*1024*1024},server:{host:'127.0.0.1',port:fixturePort,profile:'test',allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'generated-fixture-model',baseUrl:'https://fixture.invalid',apiKey:'generated-fixture-key',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{enabled:true}}};
const relatedId=randomUUID();
// A file-analysis factory receives its own scoped reader. Never share that reader
// with the normal query agent or another concurrent generated operation.
function fixtureAgent(fixtureReader:ContextReader):QueryAgent { return {configured:true,close:async()=>{},query:async input=>{
 input.onProgress?.({stage:'tool',tool:'search_context',phase:'started'});
 await new Promise<void>(resolve=>setTimeout(resolve,1500));
 input.onProgress?.({stage:'tool',tool:'search_context',phase:'completed',count:1});
 const anchors=input.anchorEvidenceIds??input.evidenceIds;
 if(anchors?.length){
  const ids=[...new Set([...anchors,...(input.evidenceIds?[]:[relatedId])])];
  const records=await fixtureReader.evidence({ids,after:input.after,before:input.before,deviceId:input.deviceId});
  if(records.length!==ids.length)throw Error(`Generated fixture originals are not readable (${records.length}/${ids.length})`);
  return {answer:'Generated native answer · 原生回答 fixture\n'+records.map(record=>record.ocrText+' ['+record.id+']').join('\n'),citations:records.map(record=>({id:record.id,capturedAt:record.capturedAt,appName:record.appName,excerpt:record.ocrText.slice(0,200)})),trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids}};
 }
 return {answer:'Generated native answer · 原生回答 fixture',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[]}};
}}; }
const value=await buildApp(config,{createModelAgent:async(_settings,reader)=>fixtureAgent(reader),...(detailFixture?{backgroundWorker:false}:{})});
if(!firstDataFixture)await value.store.ingest(noteCapture({id:relatedId,deviceId:'generated-fixture-phone',deviceName:'Generated phone',platform:'android',
 capturedAt:new Date().toISOString(),text:'Generated native note · 中文 🐾 <script>untrusted evidence</script>'}));
const detail=detailFixture?await prepareAndroidDetailFixture(value,dataDir):undefined;
if(detail)await writeFile(join(dataDir,'generated-ui-detail-identity.json'),JSON.stringify(detail));
if (process.env.MOTE_SETTINGS_UI_FIXTURE === '1') {
 value.executor.register({kind:'settings-ui-fixture',pool:'settings-ui-fixture',concurrency:()=>1,validate:()=>true,execute:async()=>null,commit:()=>{}});
 for(let i=0;i<36;i++)value.executor.enqueue('file:generated-ui-'+i,'settings-ui-fixture',{}, {initial:{state:'succeeded',attempts:0,availableAt:0}});
}
await value.app.listen({host:config.initialDocument!.server.host,port:config.initialDocument!.server.port});
if (process.env.MOTE_SETTINGS_UI_FIXTURE === '1') {
 const origin=`http://127.0.0.1:${config.initialDocument!.server.port}`;
 for(let i=0;i<5;i++) {
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const view=await (await fetch(origin+'/api/model-settings',{headers})).json() as {revision:number;profiles:{id:string}[]};
  const response=await fetch(origin+'/api/model-settings/profiles/'+encodeURIComponent(view.profiles[0]!.id)+'/copy',{
   method:'POST',headers,body:JSON.stringify({revision:view.revision,id:'generated-native-provider-'+i,name:'合成预设 '+(i+1),includeCredentials:false})});
  if(!response.ok)throw new Error('Generated provider fixture failed');
 }
}
await writeFile(join(dataDir,'fixture.json'),JSON.stringify({origin:`http://127.0.0.1:${config.initialDocument!.server.port}`,token}));
console.log(`Generated Android central fixture listening on port ${config.initialDocument!.server.port}; isolated agent readers`);
let closing=false;
async function close(){if(closing)return;closing=true;await value.app.close();await rm(dataDir,{recursive:true,force:true});}
process.on('SIGINT',()=>{void close();});process.on('SIGTERM',()=>{void close();});
