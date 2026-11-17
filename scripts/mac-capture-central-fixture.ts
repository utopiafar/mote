/** Isolated generated-data Central for the real Chrome collector journey. */
import {buildApp} from '../apps/server/src/app.js';
import type {ConfigurationPlatformOptions} from '../apps/server/src/config.js';
import {join} from 'node:path';
import {setImmediate as yieldTurn} from 'node:timers/promises';
const dataDir=process.env.MOTE_FIXTURE_DATA!,token=process.env.MOTE_FIXTURE_TOKEN!;
if(!process.send||!dataDir||!token)throw Error('This fixture requires a private IPC parent');
const config:ConfigurationPlatformOptions={path:(dataDir)+'/mote.yaml',privateCredential:{token:token,tokenPath:join(dataDir,'token')},initialDocument:{version:1,revision:0,storage:{dataDir:dataDir,maxExportBytes:10_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',provider:'custom',protocol:'openai-completions',baseUrl:'http://127.0.0.1:1234/v1',apiKey:'',allowUnauthenticatedLocal:true,reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{enabled:false}}};
const node=await buildApp(config,{backgroundWorker:false});
const url=await node.app.listen({host:'127.0.0.1',port:0});process.send({type:'ready',url});
process.on('message',message=>{if((message as {type?:string}).type==='inspect')void(async()=>{
 // Exercise the plugin timer overlap deliberately instead of depending on
 // whether the runner happens to inspect during a background tick.
 const inFlight=node.materialOrganizer.tick();
 try{
 // tick() may return immediately while the plugin's existing tick owns the
 // work. Wait for durable organizer progress, then join actual FTS indexing.
 const deadline=performance.now()+15000;
 for(;;){
  await node.materialOrganizer.tick();const status=node.materialOrganizer.status();
  if(status.failedSteps||status.blockedSteps)throw Error('Material projection failed: '+JSON.stringify(status));
  if(!status.pendingChanges&&!status.pendingSteps&&status.backfills.every(item=>item.complete)){
   await node.materials.index?.tick();break;
  }
  if(performance.now()>=deadline)throw Error('Material projection did not settle: '+JSON.stringify(status));
  await yieldTurn();
 }
 const materials=node.materials.list({query:'Visible generated article body',kind:'mote.ui-page-object'}).items;
 process.send?.({type:'inspection',wechatMaterials:node.materials.list({query:'Generated repeated message',kind:'mote.ui-page-object'}).items.map(m=>({id:m.id,text:node.materials.read(m.ref).text})),materials:materials.map(m=>({id:m.id,text:node.materials.read(m.ref).text})),memoryJobs:node.store.db.prepare('SELECT count(*) n FROM memory_jobs').get()!.n,activityGrants:node.store.db.prepare('SELECT count(*) n FROM activity_input_grants').get()!.n});
 }finally{await inFlight;}
})().catch(error=>{process.send?.({type:'failure',error:String(error)});});});
process.once('SIGTERM',()=>void node.app.close().finally(()=>process.exit(0)));
