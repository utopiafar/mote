import assert from 'node:assert/strict';
import {join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {buildApp} from '../../server/src/app.js';
import {hostRun} from '../../server/test/fixtures/host-run.js';

// A small generated Central for the hidden browser. All work is admitted through
// product commands; the model boundary alone is controlled locally.
const directory=process.argv[2];assert.ok(directory);
const token=randomBytes(32).toString('hex'),headers={authorization:'Bearer '+token};
const at='2026-11-13T08:00:00.000Z',text='Generated browser evidence: prepare the review after the owner chooses an option.';
let evidenceId='',failure:unknown;
const node=await buildApp({dataDir:join(directory,'central'),token,tokenPath:'fixture',host:'127.0.0.1',port:0,
 maxStorageBytes:30000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelMaxTokens:512,
 modelBaseUrl:'https://generated.invalid',apiKey:'generated-only',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'},
 {backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async input=>{
  try{
   const citation={id:evidenceId,capturedAt:at,appName:'Generated browser source',excerpt:text};
   const common={citations:[],trace:[],runId:hostRun(input),evidenceDependencies:{version:1 as const,complete:true,ids:[...(input.contextEvidenceDependencies?.ids??[])]}};
   if(input.taskContext?.materials){
    const original=(input.taskContext as any).originals.find((value:any)=>value.quote===text);assert.ok(original);
    return {...common,answer:JSON.stringify({reason:'Generated review needs an owner choice.',cards:[{action:'new',cardId:null,relatedCardIds:[],
     title:'Generated browser review',body:'Generated review can start after choosing the owner option.',reason:'A useful review is available.',evidence:[original],matterId:null}],commitments:[]})};
   }
   if(input.executionLane==='background')return {...common,citations:[citation],answer:JSON.stringify({state:'needs_owner_input',question:{
    prompt:'Generated browser choice: which review option?',reason:'The original leaves the choice open.',choices:[{id:'first',label:'Generated first option',answer:'Generated first option'}],evidence:[{id:evidenceId,quote:text}]}})};
   return {...common,answer:'Generated browser answer: '+input.question,...(input.question==='Generated UI prepare'?{draftProposal:{goal:'Generated UI review task'}}:{})};
  }catch(error){failure=error;throw error;}
 }}});
const call=async(method:'GET'|'POST'|'PUT',url:string,payload?:unknown)=>{
 const response=await node.app.inject({method,url,headers,payload});assert.ok(response.statusCode<300,url+': '+response.body);return response.json();
};
const config=await call('GET','/api/configuration');
await call('PUT','/api/configuration/conversations',{revision:config.revision,value:{context:{contextWindow:32000,contextWindowSource:'configured'}}});
evidenceId=randomUUID();
await call('POST','/api/notes',{id:evidenceId,deviceId:'generated-ui',deviceName:'Generated browser',platform:'import',capturedAt:at,text});
await node.materialOrganizer.tick(100);
const material=node.materials.list({kind:'mote.note'}).items.find(value=>value.origin.externalId===evidenceId);assert.ok(material);
const analysis=await node.featureServices.assistantFollowup.start({operationId:'generated-ui',requestId:randomUUID(),scope:{kind:'all'},materialRefs:[material.ref],mode:{kind:'change'}},
 {identities:[],connections:node.featureServices.availableModelConnections()});
const batchId=node.featureServices.assistantFollowup.progress(analysis.id).batch!.task.id;
const until=async(read:()=>boolean)=>{const end=Date.now()+10000;while(!read()){if(failure)throw failure;assert.ok(Date.now()<end,'generated UI work must settle');await new Promise(resolve=>setTimeout(resolve,10));}};
await until(()=>node.batchProcessing.progress(batchId).task.state==='succeeded');await node.featureServices.assistantFollowup.finish(analysis.id);
const matter=await call('POST','/api/assistant/matter-commands',{type:'create',requestId:randomUUID(),goal:'Generated UI meeting review',scope:{kind:'all'},evidenceIds:[evidenceId]});
const rule=await call('POST','/api/assistant/routines',{requestId:randomUUID(),goal:'Generated UI daily review',scope:{kind:'all'},timeZone:'UTC',trigger:{kind:'daily',localTime:'09:00'},matterId:matter.id});
const main=await call('GET','/api/conversations/main');
for(let index=0;index<21;index++){
 const message=await call('POST','/api/conversations/messages',{conversationId:main.id,clientRequestId:randomUUID(),question:'Generated short history '+index,scope:{kind:'all'}});
 await until(()=>node.conversations.message(message.id).status==='completed');
}
const url=await node.app.listen({host:'127.0.0.1',port:0});
process.stdout.write(JSON.stringify({generatedOnly:true,url,token,conversationId:main.id,ruleId:rule.id,matterId:matter.id})+'\n');
process.once('SIGTERM',()=>{void node.app.close().then(()=>process.exit(0));});
