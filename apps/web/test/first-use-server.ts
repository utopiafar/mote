import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {buildApp} from '../../server/src/app.js';
const directory=process.argv[2];if(!directory)throw Error('Generated private directory required');const token=randomBytes(32).toString('hex');
const runtime=await buildApp({path:(join(directory,'data'))+'/mote.yaml',privateCredential:{token:token,tokenPath:'fixture-only'},initialDocument:{version:1,revision:0,storage:{dataDir:join(directory,'data'),maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}}}},{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('This journey never invokes a model');},close:async()=>{}}});
runtime.app.addHook('onRequest',async(req,reply)=>{if(req.url==='/api/devices/first-data'&&existsSync(join(directory,'first-data-fault')))return reply.code(503).send({error:'service_unavailable',message:'Controlled first-data failure'});});
await runtime.app.listen({host:'127.0.0.1',port:0});console.log(JSON.stringify({server:runtime.app.server.address(),token,directory,generatedOnly:true,modelCalls:0,empty:true}));process.on('SIGTERM',()=>void runtime.app.close().then(()=>process.exit(0)));
