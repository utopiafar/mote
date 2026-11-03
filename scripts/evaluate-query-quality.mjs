#!/usr/bin/env node
// Run with: node --import tsx scripts/evaluate-query-quality.mjs ...
// The caller prepares each disposable vault from the same frozen dataset.
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {parseArgs} from 'node:util';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const {values}=parseArgs({options:{'isolated-data-dir':{type:'string'},'config-file':{type:'string'},questions:{type:'string'},output:{type:'string'},strategy:{type:'string',default:'base'},'context-time':{type:'string'},'profile-id':{type:'string',default:'env:deployment'},model:{type:'string',default:'gpt-6.1-sol'},'fixture-records':{type:'string'},'prepare-only':{type:'boolean',default:false},'allow-live-model':{type:'boolean',default:false},help:{type:'boolean',default:false}}});
if(values.help){process.stdout.write('Usage: node --import tsx scripts/evaluate-query-quality.mjs --isolated-data-dir ABS --config-file ABS --questions ABS --output ABS --strategy base|review|research-writer|both --allow-live-model\nUse --prepare-only instead of --allow-live-model to settle deterministic startup with model execution disabled.\nVault requires .query-quality-isolated.json: {"purpose":"mote-query-quality","frozenAt":"ISO","datasetFingerprint":"optional shared prepared fingerprint"}. Questions: {"cases":[{"id":"case","turns":[{"question":"..."},{"question":"follow-up"}]}]}. Each case uses real Ask API conversation continuation. Never pass the running vault.\n');process.exit(0);}
for(const key of ['isolated-data-dir','config-file','questions','output'])if(!values[key])throw new Error('Missing --'+key);
if(!values['allow-live-model']&&!values['prepare-only'])throw new Error('Live model work requires the explicit --allow-live-model execution flag');
if(!['base','review','research-writer','both'].includes(values.strategy))throw new Error('Invalid experiment strategy');
const dataDir=await realpath(resolve(values['isolated-data-dir'])),marker=JSON.parse(await readFile(join(dataDir,'.query-quality-isolated.json'),'utf8'));
if(marker.purpose!=='mote-query-quality')throw new Error('This vault has no isolated quality experiment receipt');
const contextTime=values['context-time']??marker.frozenAt;if(!Number.isFinite(Date.parse(contextTime)))throw new Error('A fixed valid context time is required');
const input=JSON.parse(await readFile(resolve(values.questions),'utf8'));
const cases=Array.isArray(input)?[{id:'conversation',turns:input.map(turn=>typeof turn==='string'?{question:turn}:turn)}]:input.cases;
if(!Array.isArray(cases)||!cases.length||cases.some(c=>typeof c.id!=='string'||!Array.isArray(c.turns)||!c.turns.length||c.turns.some(t=>typeof t.question!=='string')))throw new Error('Invalid question cases');
for(const key of Object.keys(process.env))if(key.startsWith('MOTE_'))delete process.env[key];
const {configFromFile}=await import('../apps/server/src/config.ts'),{buildApp}=await import('../apps/server/src/app.ts');
// The selected YAML owns model settings; only the isolated experiment runtime is overridden.
const config=configFromFile(resolve(values['config-file']),{initializeCredentials:false});
Object.assign(config,{dataDir,tokenPath:join(dataDir,'access-token'),profile:'quality',token:randomBytes(32).toString('hex'),host:'127.0.0.1',port:47852,
  logDirectory:join(dataDir,'logs'),logLevel:'info',agentTraceEnabled:true,retentionDays:0,insightIntervalHours:0,embeddingModel:'',fileProcessorModules:[],backendPluginModules:[]});
config.connectors={...config.connectors,directory:join(dataDir,'.quality-empty-connectors'),modules:[],mcpEnabled:false,mcpWriteEnabled:false};
const output=resolve(values.output),report={version:1,strategy:values.strategy,contextTime,dataDir,startedAt:new Date().toISOString(),cases:[]};
await mkdir(dirname(output),{recursive:true,mode:0o700});
const save=()=>writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
const node=await buildApp(config,{queryQualityExperiment:values.strategy,semanticContextTime:()=>contextTime,backgroundWorker:false,
  ...(values['prepare-only']?{createModelAgent:async()=>({configured:false,query:async()=>{throw new Error('Preparation cannot execute a model');},close:async()=>{}})}:{})});
const headers={authorization:'Bearer '+config.token,'accept-language':'zh-CN'};
const api=async(method,url,payload)=>{const response=await node.app.inject({method,url,headers,payload});if(response.statusCode>=400)throw new Error('Experiment API rejected '+url+' ('+response.statusCode+'): '+response.body);return response.json();};
const dataset=()=>{
  const hash=createHash('sha256');
  for(const table of ['captures','material_heads','memory_catalog'])for(const row of node.store.db.prepare('SELECT * FROM '+table+' ORDER BY id').iterate())hash.update(JSON.stringify(row)+'\n');
  return hash.digest('hex');
};
const failure=value=>{(report.failures??=[]).push(value);report.failure??=value;process.exitCode=1;};
// Settle deterministic startup/backfill through the real organizers before
// freezing evidence. A quiet window spans two normal five-second ticks; it is
// an experiment readiness check, not a product reading or execution quota.
const settleDataset=async()=>{
  const before=dataset(),started=performance.now();let last=before,quietSince=performance.now();
  for(;;){
    await node.sourcePipelines.tick(20000);await node.materialOrganizer.tick(20000);
    const current=dataset(),status=node.materialOrganizer.status();
    const pending=node.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE kind IN ('material.organizer','source.archive-group') AND state IN ('waiting','running')").get().n;
    if(current!==last||pending||status.pendingChanges||status.backfills.some(row=>!row.complete))quietSince=performance.now();
    last=current;
    if(performance.now()-quietSince>=11000){
      if(status.failedSteps||status.blockedSteps)throw new Error('Original Material organization is not ready for a frozen comparison');
      return {before,after:current,changed:before!==current,durationMs:performance.now()-started,materialStatus:status};
    }
    if(performance.now()-started>120000)throw new Error('Original Material startup did not settle; no comparison was started');
    await delay(250);
  }
};
try{
  await node.app.ready();
  const selected=node.modelSettings.select('chat',values['profile-id']);
  if(selected.settings.model!==values.model||selected.settings.reasoningEffort!=='high')throw new Error('Selected connection must already use '+values.model+' at high reasoning; the harness never changes or substitutes model settings');
  report.model={profileId:selected.id,provider:selected.settings.provider,protocol:selected.settings.protocol,model:values.model,reasoningEffort:selected.settings.reasoningEffort};
  if(values['fixture-records']){
    const fixtures=JSON.parse(await readFile(resolve(values['fixture-records']),'utf8'));
    if(node.store.db.prepare('SELECT count(*) n FROM captures').get().n!==0)throw new Error('Generated fixture import requires an empty isolated vault');
    for(const {items,...source} of fixtures.sources){await api('POST','/api/sources',source);await api('POST','/api/sources/'+encodeURIComponent(source.id)+'/items/batch',{items});}
    await node.materialOrganizer.tick(20000);
  }
  report.preparation=await settleDataset();
  report.datasetFingerprint=dataset();await save();
  if(marker.datasetFingerprint&&report.datasetFingerprint!==marker.datasetFingerprint)throw new Error('Prepared dataset differs from the shared frozen comparison receipt');
  scenarios: for(const scenario of values['prepare-only']?[]:cases){
    const observed={id:scenario.id,turns:[]};report.cases.push(observed);let conversationId;
    for(const requested of scenario.turns){
      const id=randomUUID(),payload={...requested,modelProfileId:selected.id,modelOverride:values.model,...(conversationId?{conversationId}:{})},started=performance.now();
      await api('POST','/api/query-runs',{id,input:payload});let run;
      do{await delay(100);run=await api('GET','/api/query-runs/'+id);}while(run.status==='running');
      conversationId=run.conversationId??conversationId;
      const conversation=run.conversationId?await api('GET','/api/conversations/'+run.conversationId+'?limit=50'):undefined;
      const turn=conversation?.turns?.find(turn=>turn.id===run.turnId);
      observed.turns.push({question:requested.question,input:payload,run,status:run.status,wallDurationMs:performance.now()-started,result:turn?.result,error:run.error});await save();
      if(run.status!=='completed'){
        failure({name:'QueryRunFailure',message:'Ask run did not complete',runId:id,status:run.status,error:run.error});break scenarios;
      }
    }
  }
  report.datasetFingerprintAfter=dataset();report.datasetUnchanged=report.datasetFingerprintAfter===report.datasetFingerprint;
  if(!report.datasetUnchanged)throw new Error('Original/Material/Memory dataset changed during the comparison');
}catch(error){failure({name:error.name,message:error.message});}
finally{report.finishedAt=new Date().toISOString();await save();await node.app.close();}
process.stdout.write(JSON.stringify({output,strategy:report.strategy,cases:report.cases.length,status:report.failure?'failed':'completed'})+'\n');
