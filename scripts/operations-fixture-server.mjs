// Isolated generated operations for renderer validation. Never uses personal data/providers.
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {buildApp} from '../apps/server/dist/app.js';
const path=process.argv[2];if(!path)throw Error('Private connection output path required');
const directory=await mkdtemp(join(tmpdir(),'mote-operation-fixture-')),token=randomBytes(32).toString('hex');
const {app,executor,store,sources,materials,materialMemoryWork}=await buildApp({dataDir:directory,token,tokenPath:'unused',profile:'test',host:'127.0.0.1',port:0,maxStorageBytes:64*1024*1024,maxExportBytes:16*1024*1024,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',connectors:{mcpEnabled:false}},{agent:{configured:false,query:async()=>{throw Error('Fixture does not run models');},close:async()=>{}}});
executor.register({kind:'fixture',pool:'fixture',concurrency:()=>2,validate:()=>true,execute:async()=>null,commit:()=>{}});
let latest;
for(let i=0;i<400;i++)latest=executor.enqueue('file:generated-'+i,'fixture',{capturedAt:new Date(Date.UTC(2024,0,1+i)).toISOString()},{initial:{state:i===399?'blocked':'succeeded',attempts:0,availableAt:0,error:i===399?'provider_not_configured':undefined}});
if(process.argv.includes('--activity')){
 const {randomUUID}=await import('node:crypto'),{materialId}=await import('../apps/server/dist/materials.js');
 const at=new Date().toISOString();sources.register({id:'generated-activity-diaries',name:'合成日记',kind:'custom',deviceId:'fixture-diaries',platform:'import'});
 const pins=[],inputKeys=[],inputScopes=[];
 for(let index=0;index<4;index++){
  const capture=await sources.upsert('generated-activity-diaries',{externalId:'diary-'+index,revision:'1',observedAt:at,kind:'file',layer:'original',text:'Generated diary evidence '+index+'; this is a synthetic fixture.'});
  const published=materials.publish({id:materialId('generated-activity-diaries','diary-'+index),kind:'mote.file',schemaVersion:1,title:'合成日记 '+(index+1),origin:{sourceId:'generated-activity-diaries',externalId:'diary-'+index},members:[{id:'original',kind:'capture',ref:'capture:'+capture.id}],blocks:[{id:'body',kind:'text',format:'plain',text:'Generated diary evidence '+index+'; this is a synthetic fixture.',memberIds:['original']}],coverage:{state:'complete'},artifacts:[{key:'body',state:'ready'}],fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
  store.db.prepare('UPDATE memory_input_authorizations SET authorized=1 WHERE source_id=? AND input_key=?').run('generated-activity-diaries',capture.id);inputKeys.push(capture.id);
  inputScopes.push(materialMemoryWork.inputs.list('generated-activity-diaries',capture.id).find(grant=>grant.authorized).scope);
  pins.push(materials.input(published.ref,['body']));
 }
 const jobId='generated-activity-memory',job={id:jobId,createdAt:at,updatedAt:at,status:'running',evidenceIds:pins.slice(0,3).flatMap(pin=>pin.evidenceIds),materialInputs:pins.slice(0,3),materialRefs:{},memoryIds:[],automaticGrants:pins.slice(0,3).map((_,index)=>({sourceId:'generated-activity-diaries',inputKey:inputKeys[index],scope:inputScopes[index]})),workPackage:{id:'generated-history',goal:'核对合成日记中的经历',instruction:'Generated fixture only',inputs:pins.slice(0,3).map((pin,index)=>({materialId:pin.materialId,ref:'generated-'+index,sourceId:'generated-activity-diaries',inputKey:inputKeys[index],scope:inputScopes[index],contextTime:at,fingerprint:pin.fingerprint}))}};
 store.db.exec('BEGIN IMMEDIATE');try{
  store.db.prepare('INSERT INTO memory_jobs VALUES(?,?,?)').run(jobId,at,JSON.stringify(job));
  if(!materialMemoryWork.inputs.claimMany(job.automaticGrants,jobId))throw Error('Generated fixture input grants are unavailable');
  store.db.exec('COMMIT');
 }catch(error){store.db.exec('ROLLBACK');throw error;}
 for(let index=0;index<2;index++){const selected=index===0?pins.slice(0,1):pins.slice(1,3),batch={id:'generated-activity-branch-'+index,index,status:index===0?'completed':'running',evidenceRanges:selected.flatMap(pin=>pin.evidenceIds.map(id=>({id,offset:0,length:50}))),memoryIds:[],coverage:selected.flatMap(pin=>pin.evidenceIds.map(id=>({id,key:id,offset:0,length:50,fingerprint:pin.fingerprint,state:index===0?'no_candidates':'pending',memoryIds:[]})))};store.db.prepare('INSERT INTO memory_batches VALUES(?,?,?,?)').run(batch.id,jobId,index,JSON.stringify(batch));}
 const importId='generated-activity-import',importJob={id:importId,name:'合成资料包',sourceId:'generated-activity-diaries',status:'importing',processingStatus:'saving',createdAt:at,updatedAt:at,progress:{total:5,processed:2,imported:2,duplicates:0},captureIds:[],files:[],archive:{files:1,bytes:100,expandedFiles:1}};store.db.prepare('INSERT INTO import_jobs VALUES(?,?,?,?)').run(importId,at,at,JSON.stringify(importJob));executor.enqueue('import:'+importId,'fixture',{}, {initial:{state:'waiting',attempts:0,availableAt:Number.MAX_SAFE_INTEGER}});
 const queryId='generated-activity-query';store.db.prepare('INSERT INTO query_runs VALUES(?,?,?)').run(queryId,'generated',JSON.stringify({id:queryId,status:'running',createdAt:at,updatedAt:at,events:[{stage:'tool',tool:'search_context',phase:'completed',count:7,at},{stage:'validating',at}]}));executor.enqueue('query:'+queryId,'fixture',{}, {initial:{state:'waiting',attempts:0,availableAt:Number.MAX_SAFE_INTEGER}});
 app.post('/api/fixture/activity-complete',async()=>{store.db.prepare("UPDATE memory_batches SET json=json_set(json,'$.status','completed','$.coverage',json(?)) WHERE id=?").run(JSON.stringify(pins.slice(1,3).flatMap(pin=>pin.evidenceIds.map(id=>({id,key:id,offset:0,length:50,fingerprint:pin.fingerprint,state:'no_candidates',memoryIds:[]})))),'generated-activity-branch-1');store.db.prepare("UPDATE memory_jobs SET json=json_set(json,'$.status','completed') WHERE id=?").run(jobId);return {ok:true};});
}
app.post('/api/fixture/advance',async()=>{executor.retry(latest);await executor.drain([latest]);return {ok:true};});
await app.listen({host:'127.0.0.1',port:0});await writeFile(path,JSON.stringify({url:app.listeningOrigin,token}),{mode:0o600,flag:'wx'});
let closing=false;async function close(){if(closing)return;closing=true;await app.close();await rm(directory,{recursive:true,force:true});await rm(path,{force:true});process.exit(0);}
process.once('SIGTERM',close);process.once('SIGINT',close);
