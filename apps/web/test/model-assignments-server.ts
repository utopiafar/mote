import {join} from 'node:path';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {buildApp} from '../../server/src/app.js';
const directory=process.argv[2];if(!directory)throw Error('Private generated directory required');
const token=randomBytes(32).toString('hex');let modelCalls=0;
const node=await buildApp({path:(join(directory,'data'))+'/mote.yaml',privateCredential:{token:token,tokenPath:'generated'},initialDocument:{version:1,revision:0,storage:{dataDir:join(directory,'data'),maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'}}},{backgroundWorker:false,agent:{configured:false,query:async()=>{modelCalls++;throw Error('Models forbidden in module assignment fixture');},close:async()=>{}}});
const writes:unknown[]=[];node.app.addHook('preHandler',async(req,reply)=>{
 if(req.method==='PUT'&&req.url==='/api/model-settings/defaults'){writes.push(req.body);writeFileSync(join(directory,'writes.json'),JSON.stringify(writes));if(existsSync(join(directory,'save503')))return reply.code(503).send({error:'service_unavailable',message:'Generated assignment save unavailable'});}
 if(req.method==='GET'&&req.url==='/api/model-settings'){
  if(existsSync(join(directory,'read503')))return reply.code(503).send({error:'service_unavailable',message:'Generated assignment read unavailable'});
  if(existsSync(join(directory,'read403')))return reply.code(403).send({error:'forbidden',message:'Generated assignment permission withdrawn'});
 }
 // Provider catalog is the only controlled external boundary. It never calls a provider.
 if(req.method==='GET'&&req.url.startsWith('/api/model-settings/profiles/')&&req.url.endsWith('/models'))return reply.send({items:[{id:'generated-choice',name:'Generated model catalog'}]});
});
const headers={authorization:'Bearer '+token};
const initial=(await node.app.inject({method:'GET',url:'/api/model-settings',headers})).json();
const response=await node.app.inject({method:'PUT',url:'/api/model-settings/profiles/generated-connection',headers,payload:{revision:initial.revision,name:'Generated independent connection',settings:{provider:'custom',protocol:'openai-completions',baseUrl:'https://generated.invalid/v1',model:'generated-base-model',reasoningEffort:'auto',maxTokens:4096,modelRequestTimeoutMs:120000,agentTimeoutMs:120000,allowUnauthenticatedLocal:false,apiKey:'',headers:{},extraBody:{}}}});
if(response.statusCode!==200)throw Error(response.body);
await node.app.listen({host:'127.0.0.1',port:0});console.log(JSON.stringify({generatedOnly:true,server:node.app.server.address(),token,profileId:'generated-connection',modelCalls:0}));
process.on('SIGTERM',()=>{void node.app.close().then(()=>{writeFileSync(join(directory,'model-calls.json'),JSON.stringify({modelCalls}));process.exit(0);});});
