import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {buildApp} from '../../server/src/app.js';
const directory=process.argv[2];if(!directory)throw Error('Generated private directory required');const token=randomBytes(32).toString('hex');
const runtime=await buildApp({dataDir:join(directory,'data'),token,tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxExportBytes:1_000_000,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('This journey never invokes a model');},close:async()=>{}}});
runtime.app.addHook('onRequest',async(req,reply)=>{if(req.url==='/api/devices/first-data'&&existsSync(join(directory,'first-data-fault')))return reply.code(503).send({error:'service_unavailable',message:'Controlled first-data failure'});});
await runtime.app.listen({host:'127.0.0.1',port:0});console.log(JSON.stringify({server:runtime.app.server.address(),token,directory,generatedOnly:true,modelCalls:0,empty:true}));process.on('SIGTERM',()=>void runtime.app.close().then(()=>process.exit(0)));
