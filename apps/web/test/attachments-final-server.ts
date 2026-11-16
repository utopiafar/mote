import {buildApp} from '../../server/src/app.js';
import {randomBytes} from 'node:crypto';import {join} from 'node:path';import {existsSync,readFileSync,writeFileSync,rmSync} from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';
const directory=process.argv[2];if(!directory)throw Error('Private generated profile required');const token=randomBytes(32).toString('hex');let modelCalls=0;
const node=await buildApp({dataDir:join(directory,'central'),token,tokenPath:join(directory,'owner.private'),host:'127.0.0.1',port:0,maxExportBytes:1000000,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'},{backgroundWorker:false,createModelAgent:async()=>({configured:process.env.MOTE_ATTACHMENT_READY==='1',query:async()=>{modelCalls++;throw Error('No model invocation allowed');},close:async()=>{}}),agent:{configured:process.env.MOTE_ATTACHMENT_READY==='1',query:async()=>{modelCalls++;throw Error('No models permitted in attachment acceptance');},close:async()=>{}}});
node.app.addHook('preHandler',async(req,reply)=>{
 if(['POST','PUT','DELETE'].includes(req.method)&&!req.url.startsWith('/api/session'))writeFileSync(join(directory,'trace.jsonl'),JSON.stringify({method:req.method,path:req.url,...req.body&&typeof req.body==='object'&&!Buffer.isBuffer(req.body)?{body:req.body}:{}})+'\n',{flag:'a',mode:0o600});
 if(req.method==='POST'&&req.url==='/api/query-runs'){modelCalls++;return reply.code(403).send({error:'forbidden'});}
 if(req.method==='POST'&&/\/api\/file-sync\/v1\/uploads\/[^/]+\/commit$/.test(req.url)){
  if(existsSync(join(directory,'fail-next-commit'))){rmSync(join(directory,'fail-next-commit'));return reply.code(503).send({error:'service_unavailable'});}
  if(existsSync(join(directory,'hold-commit'))){writeFileSync(join(directory,'held'),'true');while(existsSync(join(directory,'hold-commit'))&&!req.raw.destroyed)await delay(20);}
 }
 // The catalog transport is controlled; selecting a model performs no inference.
 if(req.method==='GET'&&req.url.startsWith('/api/model-settings/profiles/')&&req.url.endsWith('/models'))return reply.send({items:[{id:'generated-model-id',name:'Generated catalog model'}]});
});
const headers={authorization:'Bearer '+token},initial=(await node.app.inject({method:'GET',url:'/api/model-settings',headers})).json();
const configured=await node.app.inject({method:'PUT',url:'/api/model-settings/profiles/generated-attachment-selection',headers,payload:{revision:initial.revision,name:'Generated selection only',settings:{provider:'custom',protocol:'openai-completions',baseUrl:'https://generated.invalid/v1',model:'generated-base',reasoningEffort:'auto',maxTokens:4096,modelRequestTimeoutMs:120000,agentTimeoutMs:120000,allowUnauthenticatedLocal:false,apiKey:'',headers:{},extraBody:{}}}});if(configured.statusCode!==200)throw Error(configured.body);
const url=await node.app.listen({host:'127.0.0.1',port:0});console.log(JSON.stringify({generatedOnly:true,url,token,modelCalls:0}));
process.once('SIGTERM',()=>{rmSync(join(directory,'hold-commit'),{force:true});void node.app.close().then(()=>{writeFileSync(join(directory,'final.json'),JSON.stringify({modelCalls}));process.exit(0);});});
