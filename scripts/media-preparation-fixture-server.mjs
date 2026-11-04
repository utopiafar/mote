import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {buildApp} from '../apps/server/dist/app.js';
import {configFromDocument} from '../apps/server/dist/config.js';
import {centralServices} from '../apps/server/dist/plugins/central-contracts.js';
async function port(){const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const output=process.argv[2],modelDirectory=process.argv[3];if(!output||!modelDirectory)throw Error('Generated connection output and prepared test model directory required');
const directory=await mkdtemp(join(tmpdir(),'mote-media-ui-')),token=randomBytes(32).toString('hex'),ocrPort=await port(),asrPort=await port();
const document={version:1,revision:1,server:{profile:'test',runtime:'native',host:'127.0.0.1',port:0,token},storage:{dataDir:directory},media:{modelDirectory:resolve(modelDirectory),workerToken:randomBytes(32).toString('hex'),ocrPort,asrPort,ocrEndpoint:`http://127.0.0.1:${ocrPort}/ocr`,asrEndpoint:`http://127.0.0.1:${asrPort}/transcribe`}};
const configPath=join(directory,'mote.yaml');await writeFile(configPath,JSON.stringify(document),{mode:0o600});
const node=await buildApp(configFromDocument(document,configPath),{backgroundWorker:false,createModelAgent:async()=>({configured:false,query:async()=>{throw Error('No model in media UI test');},close:async()=>{}})});
const contribution=node.bootstrap.snapshot().contributions.find(value=>value.identity.contributionId==='ocr-asr-readiness');
if(!contribution)throw Error('OCR/ASR readiness contribution is unavailable');
const readinessLease=await node.bootstrap.host.acquire(centralServices.mediaReadiness,{service:{id:centralServices.mediaReadiness.id,apiVersion:'1'},provider:contribution.identity,revision:0});
const preparation=readinessLease.value,realStatuses=preparation.statuses.bind(preparation),before={authorization:node.modelAuthorization.view(),perception:node.perception.settings()};
let controlled=null,starts=0,cancels=0;
node.app.addHook('onRequest',async(req,reply)=>{if(req.url==='/api/media-preparation/ocr'&&req.method==='POST')starts++;if(req.url==='/api/media-preparation/ocr/cancel'&&req.method==='POST')cancels++;if(controlled&&req.url.startsWith('/api/media-preparation')){if(req.method==='GET')return reply.send(controlled);if(req.url.endsWith('/cancel')){controlled.ocr={...controlled.ocr,state:'cancelled'};return reply.send(controlled.ocr);}return reply.send(controlled.ocr);}});
node.app.post('/api/fixture/media-state',async(req)=>{const state=req.body?.state;if(state==='actual'){controlled=null;return {ok:true};}const base=await realStatuses();controlled={...base,ocr:{...base.ocr,state,runtimeReady:state==='ready',error:state==='failed'?'worker_start_failed':undefined,model:{...base.ocr.model,state:state==='idle'?'not_installed':'downloading',bytes:10,totalBytes:100}}};return {ok:true};});
node.app.get('/api/fixture/receipt',async()=>({starts,cancels,before,after:{authorization:node.modelAuthorization.view(),perception:node.perception.settings()},actual:await realStatuses()}));
await node.app.listen({host:'127.0.0.1',port:0});await writeFile(output,JSON.stringify({url:node.app.listeningOrigin,token}),{mode:0o600});
let closing=false;async function close(){if(closing)return;closing=true;await readinessLease.release();await node.app.close();await rm(directory,{recursive:true,force:true});await rm(output,{force:true});process.exit(0);}
process.once('SIGTERM',close);process.once('SIGINT',close);
