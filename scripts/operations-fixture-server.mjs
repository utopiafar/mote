// Isolated generated operations for renderer validation. Never uses personal data/providers.
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {buildApp} from '../apps/server/dist/app.js';
const path=process.argv[2];if(!path)throw Error('Private connection output path required');
const directory=await mkdtemp(join(tmpdir(),'mote-operation-fixture-')),token=randomBytes(32).toString('hex');
const {app,executor}=await buildApp({dataDir:directory,token,tokenPath:'unused',profile:'test',host:'127.0.0.1',port:0,maxStorageBytes:64*1024*1024,maxExportBytes:16*1024*1024,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',connectors:{mcpEnabled:false}},{agent:{configured:false,query:async()=>{throw Error('Fixture does not run models');},close:async()=>{}}});
executor.register({kind:'fixture',pool:'fixture',concurrency:()=>2,validate:()=>true,execute:async()=>null,commit:()=>{}});
let latest;
for(let i=0;i<400;i++)latest=executor.enqueue('file:generated-'+i,'fixture',{capturedAt:new Date(Date.UTC(2024,0,1+i)).toISOString()},{initial:{state:i===399?'blocked':'succeeded',attempts:0,availableAt:0,error:i===399?'provider_not_configured':undefined}});
app.post('/api/fixture/advance',async()=>{executor.retry(latest);await executor.drain([latest]);return {ok:true};});
await app.listen({host:'127.0.0.1',port:0});await writeFile(path,JSON.stringify({url:app.listeningOrigin,token}),{mode:0o600,flag:'wx'});
let closing=false;async function close(){if(closing)return;closing=true;await app.close();await rm(directory,{recursive:true,force:true});await rm(path,{force:true});process.exit(0);}
process.once('SIGTERM',close);process.once('SIGINT',close);
