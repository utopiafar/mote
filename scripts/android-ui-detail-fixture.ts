import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {strToU8,zipSync} from 'fflate';
import type {buildApp} from '../apps/server/src/app.js';
import {materialId} from '../apps/server/src/materials.js';
import {sha256} from '../apps/server/src/evidence-store.js';
import type {PluginReleaseTransport,PluginManifest} from '../apps/server/src/plugin-release.js';
import {fixtureFilePolicy} from '../apps/server/test/fixtures/file-policy.js';
import {fixtureMemoryResult} from '../apps/server/test/fixtures/memory-result.js';
import {Actions} from '../apps/server/src/actions.js';
import {reviewMemory,memoryReviewReceipt} from '../apps/server/src/memory-review.js';

/** Isolated populated detail pages. Every original, package and model result is generated. */
export async function prepareAndroidDetailFixture(node:Awaited<ReturnType<typeof buildApp>>,directory:string) {
  node.memoryAutomation.command('pause',{operationId:randomUUID(),expectedRevision:node.memoryAutomation.state().revision});
  const at=new Date().toISOString(),sourceId='generated-android-detail-source',text='Generated owner statement · 中文 🐾. Preserve this exact original evidence. Generated appointment: September 18, 2099, 15:00–16:00 Asia/Shanghai.';
  node.sources.register({id:sourceId,name:'Generated detail source',kind:'local-files',deviceId:'generated-detail-device',platform:'import',retention:'archive'});
  node.sources.updateContext(sourceId,{expectedVersion:0,description:'Generated source ownership description. All originals belong to this fixture.'});
  const bytes=Buffer.from(text),begun=node.files.begin({sourceId,item:{externalId:'generated-original.txt',revision:'1',observedAt:at,title:'Generated original.txt',kind:'file',layer:'original',text:'',mimeType:'text/plain',deleted:false},sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});
  node.files.part(begun.uploadId,0,bytes,()=>{});const ack=await node.files.commit(begun.uploadId,()=>{});
  await node.processing.runtime.ready;
  const processing={...node.processing.view().settings,enabled:true,summarize:false};
  node.processing.update({revision:node.processing.view().revision,settings:processing,policy:fixtureFilePolicy(processing,node.processing.runtime.registry)});
  await node.processing.tick();
  if(!node.files.chunks(ack.id).length)throw new Error('Generated original must finish actual native text processing');
  const memberId='generated-detail-member';
  const material=node.materials.publish({id:materialId(sourceId,'generated-detail-material'),kind:'mote.file',schemaVersion:1,title:'Generated detail material',origin:{sourceId,externalId:'generated-detail-material'},members:[{id:memberId,kind:'capture',ref:'capture:'+ack.id}],blocks:[{id:'generated-detail-block',kind:'text',format:'plain',text,memberIds:[memberId]}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
  const evidence=node.files.chunks(ack.id)[0];
  const draft=fixtureMemoryResult(node.memories,{answer:JSON.stringify({memories:[{title:'Generated detail memory',statement:`Generated owner statement [${evidence.id}]`,uncertainty:'Generated fixture only',evidenceIds:[evidence.id]}]}),citations:[{id:evidence.id,capturedAt:evidence.capturedAt,appName:evidence.appName,excerpt:evidence.ocrText}],trace:[],runId:'generated-detail-memory'});
  const reviewed=await reviewMemory({question:'Review generated fixture evidence',skill:'memory-extraction',responseMode:'memory-extraction',evidenceIds:[evidence.id]},draft,async()=>({...draft,runId:'generated-independent-detail-review'}),{deletions:node.memories.deletions});
  const memory=node.memories.publish(node.memories.extract(reviewed,'generated-no-live-model',{reviewReceipt:memoryReviewReceipt(reviewed)}).items[0]!.id);
  // A deterministic generated model proposes the known fixture appointment;
  // the real host validates its literal quote and persists the proposal gate.
  const calendar=new Actions(node.store,node.files,async input=>({answer:JSON.stringify({actions:input.evidenceIds?.includes(evidence.id)?[{kind:'calendar.create',event:{title:'Generated calendar review',start:'2099-09-18T15:00:00+08:00',end:'2099-09-18T16:00:00+08:00',allDay:false,timeZone:'Asia/Shanghai',location:'Generated room',description:'Generated fixture only'},uncertainty:'Generated schedule fixture',sameAs:null,evidence:[{id:evidence.id,quote:text}]}]:[]}),citations:[{id:evidence.id,capturedAt:evidence.capturedAt,appName:evidence.appName,excerpt:text}],trace:[],runId:'generated-calendar-proposal'}),()=>true);
  calendar.configure({enabled:true,timeZone:'Asia/Shanghai',reviewDeviceIds:[]});await calendar.tick();
  if(!calendar.list().some(item=>item.event.title==='Generated calendar review'))throw new Error('Generated calendar proposal must pass actual host evidence validation');
  await calendar.close();
  const generatedPixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const imported=await node.imports.create({name:'Generated preview import',processing:'preview',files:[{name:'generated-preview.png',mimeType:'image/png',dataBase64:generatedPixel}]});
  const preview=await node.imports.prepare(imported.id);
  if(preview.status!=='awaiting_confirmation')throw new Error('Generated import must retain actual confirmation gate');
  const headers={authorization:'Bearer generated-native-central-owner-token-123456'};
  const todo=await node.app.inject({method:'POST',url:'/api/todos',headers,payload:{id:randomUUID(),title:'Generated detail todo',description:'Generated task scope',dueAt:null,evidenceIds:[ack.id]}});
  if(todo.statusCode<200||todo.statusCode>=300)throw new Error('Generated Todo failed: '+todo.body);
  const models=node.modelSettings.view();
  const copied=await node.app.inject({method:'POST',url:'/api/model-settings/profiles/'+encodeURIComponent(models.profiles[0]!.id)+'/copy',headers,payload:{revision:models.revision,id:'generated-detail-editable',name:'Generated editable provider',includeCredentials:false}});
  if(copied.statusCode<200||copied.statusCode>=300)throw new Error('Generated editable provider failed: '+copied.body);

  // Reuse the repository's executable generated provider fixture. Never fetch a real release.
  const workerSource=readFileSync(new URL('../apps/server/test/plugin-control-journeys.test.ts',import.meta.url),'utf8');
  const worker=workerSource.match(/const generatedWorker = String\.raw`([\s\S]*?)`;/)?.[1];
  if(!worker)throw new Error('Executable generated worker fixture is missing');
  const repository='generated/android-ui-adapter',tag='v1.0.0',commit='b'.repeat(40),archive=Buffer.from(zipSync({'provider.mjs':strToU8(worker)}));
  const manifest:PluginManifest={schemaVersion:1,id:'generated.android-ui-adapter',name:'Generated Android UI adapter',version:'1.0.0',runtime:'worker',entry:'provider.mjs',archive:{asset:'adapter.zip',sha256:sha256(archive)},capabilities:['repository','retrieval'],configuration:[{id:'recordFile',label:'Generated record file',type:'text',required:true},{id:'controlFile',label:'Generated control file',type:'text',required:true},{id:'label',label:'Generated runtime revision',type:'text',required:true}],dependencies:[],access:['Generated fixture directory only']};
  const base=`https://github.com/${repository}/releases/download/${tag}/`;
  const transport:PluginReleaseTransport=async url=>{
    if(url===`https://api.github.com/repos/${repository}/releases/tags/${tag}`)return {bytes:strToU8(JSON.stringify({tag_name:tag,draft:false,assets:[{name:'mote-plugin.json',browser_download_url:base+'mote-plugin.json'},{name:'adapter.zip',browser_download_url:base+'adapter.zip'}]}))};
    if(url===`https://api.github.com/repos/${repository}/commits/${tag}`)return {bytes:strToU8(JSON.stringify({sha:commit}))};
    if(url===base+'mote-plugin.json')return {bytes:strToU8(JSON.stringify(manifest))};
    if(url===base+'adapter.zip')return {bytes:archive};
    throw new Error('Generated release transport rejects unregistered URL: '+url);
  };
  Object.defineProperty(node.pluginCenter.releases,'transport',{value:transport});
  const release=await node.pluginCenter.resolve({repository,tag});
  node.pluginCenter.install({operationId:randomUUID(),expectedRevision:node.pluginCenter.revision(),previewId:release.id});
  const until=Date.now()+10000;
  while(node.pluginCenter.view().packages[0]?.state==='installing'&&Date.now()<until){await node.executor.tick();await new Promise(resolve=>setTimeout(resolve,20));}
  const installed=node.pluginCenter.view().packages[0];if(installed?.state!=='installed')throw new Error('Generated release installation did not finish');
  const instance=node.pluginCenter.configure(undefined,{operationId:randomUUID(),expectedRevision:node.pluginCenter.revision(),packageId:installed.id,name:'Generated UI memory plan',scope:'default',configuration:{recordFile:join(directory,'generated-memory-records.json'),controlFile:join(directory,'generated-memory-control.json'),label:'generated-UI-only'}});
  node.pluginCenter.action(instance.id,'check',{operationId:randomUUID(),expectedRevision:instance.revision});
  while(node.pluginCenter.instanceView(instance.id).observed==='checking'&&Date.now()<until){await node.executor.tick();await new Promise(resolve=>setTimeout(resolve,20));}
  const checked=node.pluginCenter.instanceView(instance.id);if(checked.observed!=='ready')throw new Error('Generated executable provider capability check did not finish');
  node.pluginCenter.action(instance.id,'enable',{operationId:randomUUID(),expectedRevision:checked.revision});
  node.pluginCenter.configure(undefined,{operationId:randomUUID(),expectedRevision:node.pluginCenter.revision(),packageId:installed.id,name:'Generated editable instance',scope:'default',configuration:{recordFile:join(directory,'generated-editable-records.json'),controlFile:join(directory,'generated-editable-control.json'),label:'generated-disabled-UI-only'}});
  return {generatedOnly:true,sourceId,fileId:ack.id,materialId:material.id,memoryId:memory.id,importId:imported.id,repository,tag,pluginInstanceId:instance.id};
}
