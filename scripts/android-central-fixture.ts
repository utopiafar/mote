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
await value.app.listen({host:config.host,port:config.port});
await writeFile(join(dataDir,'fixture.json'),JSON.stringify({origin:`http://127.0.0.1:${config.port}`,token}));
console.log(`Generated Android central fixture listening on port ${config.port}`);
let closing=false;
async function close(){if(closing)return;closing=true;await value.app.close();await rm(dataDir,{recursive:true,force:true});}
process.on('SIGINT',()=>{void close();});process.on('SIGTERM',()=>{void close();});
