import {join} from 'node:path';
import {existsSync,readFileSync} from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import {buildApp} from '../../server/src/app.js';
import {materialId} from '../../server/src/materials.js';

// Generated loopback fixture only. Controls affect this private process, never a profile.
const directory=process.argv[2];if(!directory)throw Error('Generated fixture directory required');
const token=randomBytes(32).toString('hex'),at='2026-11-01T08:00:00.000Z',headers={authorization:'Bearer '+token};
let modelCalls=0;
const runtime=await buildApp({dataDir:join(directory,'data'),token,tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxExportBytes:1_000_000,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'},
 {backgroundWorker:false,agent:{configured:false,query:async()=>{modelCalls++;throw Error('No model in generated Home fixture');},close:async()=>{}}});
const fault=()=>existsSync(join(directory,'fault.json'))?JSON.parse(readFileSync(join(directory,'fault.json'),'utf8')) as {features?:'missing'|'failed';onboarding?:'denied';cards?:'failed';work?:'failed'}:{};
runtime.app.addHook('onRequest',async(request,reply)=>{
 const state=fault();
 if(request.method==='GET'&&(request.url==='/api/features'&&state.features==='failed'||request.url.startsWith('/api/assistant-cards?')&&state.cards==='failed'||request.url.startsWith('/api/work-activity?')&&state.work==='failed'))return reply.code(503).send({error:'unavailable',message:'Generated read failure'});
 if(request.method==='GET'&&request.url.startsWith('/api/assistant/onboarding/')&&state.onboarding==='denied')return reply.code(403).send({error:'forbidden',message:'Generated onboarding permission boundary'});
});
runtime.app.addHook('onSend',async(request,reply,payload)=>{
 if(request.url==='/api/features'&&reply.statusCode===200&&fault().features==='missing'){
  const inventory=JSON.parse(String(payload));inventory.capabilities=inventory.capabilities.filter((entry:{id:string})=>!['assistant','memories','context-trees','conversations','work-activity'].some(value=>entry.id.includes('/api/'+value)));
  return JSON.stringify(inventory);
 }
 return payload;
});
let material:ReturnType<typeof runtime.materials.publish>|undefined,evidenceId:string|undefined,cardId:string|undefined;
const publish=(failed=false)=>{
 const id=materialId('generated-assistant-source','selected');
 material=runtime.materials.publish({id,kind:'mote.file',schemaVersion:1,title:'Generated acquaintance notes.txt',origin:{sourceId:'generated-assistant-source',externalId:'selected',deviceId:'generated-home',firstAt:at,lastAt:at},members:[{id:'original',kind:'capture',ref:'capture:'+evidenceId}],blocks:[{id:'body',kind:'text',format:'plain',text:'Generated project needs a preparation checklist.',memberIds:['original']}],artifacts:[{key:'source-body',state:'ready',blockIds:['body']},{key:'extracted-text',state:failed?'failed':'pending',blockIds:[]}],coverage:{state:'partial'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}},{expectedRevision:material?.revision??null});
};
runtime.app.post('/__fixture/control',async(request,reply)=>{
 if(request.headers.authorization!==headers.authorization)return reply.code(403).send({error:'forbidden'});
 const {action}=request.body as {action:string};
 if(action==='seed'){
  runtime.sources.register({id:'generated-assistant-source',name:'Generated assistant files',kind:'custom',deviceId:'generated-home',platform:'import'});
  evidenceId=(await runtime.sources.upsert('generated-assistant-source',{externalId:'selected',revision:'1',observedAt:at,title:'Generated acquaintance notes.txt',text:'Generated project needs a preparation checklist.',kind:'file',layer:'snapshot'})).id;publish();
 }
 if(action==='suggestion'){
  const scope={kind:'all' as const},matter=runtime.featureServices.assistantMatters.command({type:'create',requestId:randomUUID(),goal:'Generated ongoing project',scope},{currentEvidence:()=>[],currentTask:()=>undefined});
  const card=runtime.featureServices.assistantCards.publish({id:randomUUID(),kind:'suggestion',matterId:matter.id,version:'v1',state:'open',title:'Generated checklist suggestion',body:'Generated suggestion: prepare a checklist from the selected notes.',evidence:[{id:evidenceId!,quote:'Generated project needs a preparation checklist.'}],evidenceDependencies:{version:1,complete:true,ids:[evidenceId!]}},undefined,scope,()=>{});cardId=card.id;
 }
 if(action==='fail-extraction'){publish(true);await runtime.featureServices.assistantOnboarding.tick();}
 if(action==='revoke-source')runtime.sources.reportStatus('generated-assistant-source',{state:'permission_required',code:'generated_permission_required'});
 return {materialRef:material?.ref,cardId,modelCalls};
});
await runtime.app.listen({host:'127.0.0.1',port:0});
console.log(JSON.stringify({server:runtime.app.server.address(),token,generatedOnly:true,modelCalls}));
process.on('SIGTERM',()=>{void runtime.app.close().then(()=>process.exit(0));});
