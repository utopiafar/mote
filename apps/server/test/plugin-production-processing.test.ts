import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {strToU8,zipSync} from 'fflate';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {sha256} from '../src/store.js';
import type {PluginManifest,PluginReleaseTransport} from '../src/plugin-release.js';

const source=String.raw`
import {readFile,writeFile} from 'node:fs/promises';
const control=async path=>{try{return JSON.parse(await readFile(path,'utf8'));}catch{return {};}};
const hold=async(path,key)=>{if(!(await control(path))[key])return;await writeFile(path+'.'+key,'entered');while((await control(path))[key])await new Promise(resolve=>setTimeout(resolve,5));};
export const backendPlugin={name:'generated-installed-processing',inject:['moteContextProcessors','moteFileProcessors'],async apply(ctx,config){
 await hold(config.controlFile,'activate');
 if(config.mode==='empty')return;
 const processor=id=>({id,version:'1',lane:'extract',deterministic:true,async process({observations,signal}){
   await hold(config.controlFile,'process');signal.throwIfAborted();return observations.map(row=>({kind:'normalized-text',text:config.label+':'+row.ocrText.replace(/\r\n/g,'\n'),metadata:{}}));
 }});
 const register=id=>ctx.effect(()=>ctx.get('moteContextProcessors').register(processor(id)));
 if(config.mode==='partial-failure'){register(config.processorId+'.partial');throw Error('Generated apply failure');}
 if(config.mode==='unsupported')throw Error('Generated unavailable dependency');
 if(config.mode==='collision')register(config.processorId+'.partial');
 register(config.processorId);
 if(config.mode==='duplicate')register(config.processorId);
 ctx.effect(()=>ctx.moteFileProcessors.register({id:config.processorId+'.file',version:'1',name:'Generated file extractor',stage:config.mode==='invalid-file'?'unsupported':'extract',mediaTypes:['application/vnd.generated-pack'],localOnly:true,async process(input){const bytes=[];for await(const part of input.readOriginal())bytes.push(part);return {durationMs:0,segments:[{startMs:0,endMs:0,text:config.label+':'+Buffer.concat(bytes).toString()}]};}}));
}};
`;
const until=async(check:()=>boolean|Promise<boolean>,label:string)=>{const deadline=Date.now()+8000;while(!await check()){assert.ok(Date.now()<deadline,label);await new Promise(resolve=>setTimeout(resolve,5));}};
const command=(expectedRevision:number)=>({operationId:randomUUID(),expectedRevision});

async function fixture(t:TestContext,entry=source){
 const directory=await mkdtemp(join(tmpdir(),'mote-production-processing-')),controlFile=join(directory,'control.json');
 const repository='generated/processing',tag='v1.0.0',base=`https://github.com/${repository}/releases/download/${tag}/`,archive=zipSync({'plugin.mjs':strToU8(entry)});
 const manifest:PluginManifest={schemaVersion:1,id:'generated.processing',name:'Generated processing package',version:'1.0.0',trust:'external',runtime:'service',entry:'plugin.mjs',archive:{asset:'processing.zip',sha256:sha256(archive)},contributions:[{id:'generated.processing.pack',version:'1',surface:'processing',runtime:'service',entry:'plugin.mjs',capabilities:['processing.pack']}],capabilities:['processing.pack'],configuration:['processorId','label','mode','controlFile'].map(id=>({id,label:id,type:'text' as const,required:true})),dependencies:[],access:['Generated deterministic processing only']};
 const transport:PluginReleaseTransport=async url=>{
  if(url.endsWith('/releases/tags/'+tag))return {bytes:strToU8(JSON.stringify({tag_name:tag,draft:false,assets:[{name:'mote-plugin.json',browser_download_url:base+'mote-plugin.json'},{name:'processing.zip',browser_download_url:base+'processing.zip'}]}))};
  if(url.endsWith('/commits/'+tag))return {bytes:strToU8(JSON.stringify({sha:'a'.repeat(40)}))};
  if(url===base+'mote-plugin.json')return {bytes:strToU8(JSON.stringify(manifest))};
  if(url===base+'processing.zip')return {bytes:archive};throw Error('Unexpected generated release URL');
 };
 const config:Config={dataDir:join(directory,'data'),token:'generated-processing-owner',tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 const start=async()=>{const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,async close(){},async query(){throw Error('No model call in processing fixture');}}});Object.defineProperty(node.pluginCenter.releases,'transport',{value:transport});return node;};
 let node=await start();const headers={authorization:'Bearer '+config.token};
 t.after(async()=>{await writeFile(controlFile,'{}');await node.app.close();await rm(directory,{recursive:true,force:true});});
 const request=async(method:'GET'|'POST'|'PUT'|'PATCH',url:string,payload?:unknown)=>{const response=await node.app.inject({method,url,headers,...(payload===undefined?{}:{payload:payload as object})});assert.ok(response.statusCode<400,response.body);return response.json();};
 const preview=await request('POST','/api/plugins/resolve',{repository,tag});await request('POST','/api/plugins/install',{...command(node.pluginCenter.revision()),previewId:preview.id});await until(()=>node.pluginCenter.view().packages[0]?.state==='installed','the generated service archive installs');
 const pkg=node.pluginCenter.view().packages[0]!;assert.equal(sha256(await readFile(join(config.dataDir,'plugins/packages',preview.source.digest,'mote-source.zip'))),preview.source.digest);
 const configure=async(id?:string,processorId='generated.installed',mode='normal',label='first')=>request(id?'PATCH':'POST','/api/plugin-instances'+(id?'/'+id:''),{...command(id?node.pluginCenter.instanceView(id).revision:node.pluginCenter.revision()),...(id?{}:{packageId:pkg.id}),name:processorId,scope:'default',configuration:{processorId,mode,label,controlFile}});
 const action=async(id:string,kind:'check'|'enable'|'disable')=>request('POST','/api/plugin-instances/'+id+'/'+kind,command(node.pluginCenter.instanceView(id).revision));
 const check=async(id:string)=>{await action(id,'check');await until(()=>node.pluginCenter.instanceView(id).observed!=='checking','check settles');const result=node.pluginCenter.instanceView(id);if(result.observed==='blocked')t.diagnostic(JSON.stringify(result.issues));return result;};
 const enable=async(id:string)=>{const response=await action(id,'enable');assert.equal(response.observed,'checking','enable never reports ready before activation');await until(()=>node.pluginCenter.instanceView(id).observed!=='checking','activation settles');return node.pluginCenter.instanceView(id);};
 const submit=async(processor:string)=>{const id=randomUUID();await node.store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-01-01T00:00:00Z',durationMs:0,ocrText:'Generated\r\noriginal'});const job=await request('POST','/api/processing/workflows',{steps:[{name:'one',processor,inputs:[id]}]});return job.one as string;};
 return {directory,controlFile,request,configure,action,check,enable,submit,get node(){return node;},async control(value:object){await writeFile(controlFile,JSON.stringify(value));},async entered(key:string){await until(async()=>Boolean(await readFile(controlFile+'.'+key).catch(()=>undefined)),'generated '+key+' gate reached');},async restart(){await node.app.close();node=await start();}};
}

test('a verified service archive reaches the real processing registry, commits products, restores selection and releases a disabled in-flight instance',async t=>{
 const f=await fixture(t),before=f.node.modelAuthorization.view(),one=await f.configure(),two=await f.configure(undefined,'generated.sibling');
 assert.equal((await f.check(one.id)).observed,'ready');assert.equal((await f.check(two.id)).observed,'ready');
 assert.equal(f.node.workflows.registry.get('generated.installed'),undefined,'check never publishes a processing entry');
 assert.equal((await f.enable(one.id)).observed,'ready');assert.equal((await f.enable(two.id)).observed,'ready');
 const settings=await f.request('GET','/api/file-processing');settings.policy.profiles.push({id:'generated-profile',name:'Generated file pack',processorId:'generated.installed.file',parameters:{},diarizationProcessor:'audio.diarize',summarize:false});settings.policy.rules.unshift({type:'application/vnd.generated-pack',profileId:'generated-profile'});
 await f.request('PUT','/api/file-processing',{revision:settings.revision,settings:settings.settings,policy:settings.policy});
 f.node.sources.register({id:'generated-plugin-files',kind:'local-files',name:'Generated files',deviceId:'generated',platform:'import',retention:'archive'});
 const bytes=Buffer.from('Generated file original'),upload=f.node.files.begin({sourceId:'generated-plugin-files',item:{externalId:'generated-file',revision:'1',observedAt:'2026-01-01T00:00:00Z',title:'Generated file',kind:'file',layer:'original',text:'',mimeType:'application/vnd.generated-pack',deleted:false},sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});
 f.node.files.part(upload.uploadId,0,bytes,()=>{});const receipt=await f.node.files.commit(upload.uploadId,()=>{});
 for(let n=0;n<20&&f.node.files.detail(receipt.id).job?.state!=='succeeded';n++)await f.node.processingServices.tick();
 const detail=f.node.files.detail(receipt.id);assert.equal(detail.job?.state,'succeeded',JSON.stringify(detail.job));const transcript=detail.artifacts.find(value=>value.kind==='text');assert.ok(transcript);assert.match(JSON.stringify(f.node.processing.artifact(transcript.id).transcript),/first:Generated file original/);
 const job=await f.submit('generated.installed');await f.node.processingServices.tick();assert.equal(f.node.workflows.engine.get(job)?.state,'succeeded');
 const output=f.node.workflows.view().jobs.find(value=>value.id===job)!.outputs[0]!;assert.equal(f.node.store.archive.get(output)?.text,'first:Generated\noriginal');assert.deepEqual(f.node.modelAuthorization.view(),before);
 await f.restart();await until(()=>f.node.pluginCenter.instanceView(one.id).observed==='ready','persisted processing instance restores');assert.ok(f.node.workflows.registry.get('generated.installed'));
 await f.control({process:true});const slow=await f.submit('generated.installed'),running=f.node.processingServices.tick();await f.entered('process');
 await f.action(one.id,'disable');assert.equal(f.node.workflows.registry.get('generated.installed'),undefined,'disable immediately withdraws the registration');assert.ok(f.node.workflows.registry.get('generated.sibling'),'a sibling instance stays available');
 await f.control({});await running;assert.notEqual(f.node.workflows.engine.get(slow)?.state,'succeeded');assert.deepEqual(f.node.workflows.view().jobs.find(value=>value.id===slow)!.outputs,[]);
 await until(()=>!f.node.pluginCenter.buildView(one.id).active,'disable drains the owned host scope');
 await f.configure(one.id,'generated.reconfigured','normal','second');assert.equal((await f.check(one.id)).observed,'ready');assert.equal((await f.enable(one.id)).observed,'ready');
 const next=await f.submit('generated.reconfigured');await f.node.processingServices.tick();assert.equal(f.node.workflows.engine.get(next)?.state,'succeeded');assert.equal(f.node.workflows.registry.get('generated.installed'),undefined);
});

test('processing checks reject empty, failed and duplicate declarations; a live collision rolls back only the failing instance',async t=>{
 const f=await fixture(t);
 for(const mode of ['empty','partial-failure','unsupported','duplicate','invalid-file']){const instance=await f.configure(undefined,'generated.'+mode,mode),checked=await f.check(instance.id);assert.equal(checked.observed,'blocked',mode);assert.ok(!checked.allowedActions.includes('enable'));assert.equal(f.node.workflows.registry.get('generated.'+mode),undefined);assert.equal(f.node.workflows.registry.get('generated.'+mode+'.partial'),undefined);}
 const good=await f.configure(undefined,'generated.collision');await f.check(good.id);await f.enable(good.id);
 const bad=await f.configure(undefined,'generated.collision','collision');assert.equal((await f.check(bad.id)).observed,'ready');assert.equal((await f.enable(bad.id)).observed,'blocked');
 assert.equal(f.node.workflows.registry.get('generated.collision.partial'),undefined,'partial publication rolls back');assert.ok(f.node.workflows.registry.get('generated.collision'),'the already enabled provider is retained');
 const job=await f.submit('generated.collision');await f.node.processingServices.tick();assert.equal(f.node.workflows.engine.get(job)?.state,'succeeded');
});

test('disabling a service during suspended apply prevents late registration and never projects the candidate ready',async t=>{
 const f=await fixture(t),instance=await f.configure();await f.check(instance.id);await f.control({activate:true});await f.action(instance.id,'enable');await f.entered('activate');
 assert.equal(f.node.pluginCenter.instanceView(instance.id).observed,'checking');assert.equal(f.node.workflows.registry.get('generated.installed'),undefined);
 assert.equal(f.node.pluginCenter.buildView(instance.id).active,null,'a suspended activation has no active selection');
 const build=f.node.pluginCenter.buildView(instance.id),stopping=f.request('PATCH','/api/plugin-builds/'+instance.id,{...command(build.revision),selection:null});
 await until(()=>!f.node.pluginCenter.instanceView(instance.id).desired,'disable revokes the pending selection before apply finishes');await f.control({});assert.equal((await stopping).observed,'stopped');
 assert.equal(f.node.workflows.registry.get('generated.installed'),undefined);assert.equal(f.node.pluginCenter.instanceView(instance.id).desired,false);
 assert.equal((await f.enable(instance.id)).observed,'ready','a later explicit enable can publish the new scope');
});

test('an invalid processing export or unsupported registration dependency is blocked by the real package check',async t=>{
 for(const entry of ['export const backendPlugin={};','export const backendPlugin={inject:["moteStore"],apply(){throw Error("Unsupported code must not run");}};']){
  const f=await fixture(t,entry),instance=await f.configure(),checked=await f.check(instance.id);assert.equal(checked.observed,'blocked');assert.ok(!checked.allowedActions.includes('enable'));assert.ok(checked.capabilities.every(value=>value.state!=='verified'));assert.equal(f.node.workflows.registry.get('generated.installed'),undefined);
 }
});

test('a packaged file extension publishes its format, typed output and recipe into the actual file pipeline',async t=>{
 const entry=await readFile(new URL('../../../examples/media-intake-plugin/plugin.mjs',import.meta.url),'utf8'),f=await fixture(t,entry),instance=await f.configure();
 assert.equal((await f.check(instance.id)).observed,'ready');assert.equal((await f.enable(instance.id)).observed,'ready');
 const settings=await f.request('GET','/api/file-processing');settings.policy.profiles.push({id:'generated-recipe',name:'Generated recipe',processorId:'community.text-extract',parameters:{},diarizationProcessor:'audio.diarize',summarize:false});settings.policy.rules.unshift({type:'application/vnd.mote.text',profileId:'generated-recipe'});await f.request('PUT','/api/file-processing',{revision:settings.revision,settings:settings.settings,policy:settings.policy});
 f.node.sources.register({id:'generated-recipe-files',kind:'local-files',name:'Generated recipe files',deviceId:'generated',platform:'import',retention:'archive'});
 const bytes=Buffer.from('MOTE-TEXT\nGenerated\r\nrecipe'),upload=f.node.files.begin({sourceId:'generated-recipe-files',item:{externalId:'generated-recipe',revision:'1',observedAt:'2026-01-01T00:00:00Z',title:'Generated recipe',kind:'file',layer:'original',text:'',mimeType:'application/vnd.mote.text',deleted:false},sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});f.node.files.part(upload.uploadId,0,bytes,()=>{});const receipt=await f.node.files.commit(upload.uploadId,()=>{});
 for(let n=0;n<20&&f.node.files.detail(receipt.id).job?.state!=='succeeded';n++)await f.node.processingServices.tick();
 const detail=f.node.files.detail(receipt.id);assert.equal(detail.job?.state,'succeeded',JSON.stringify(detail.job));assert.ok(detail.artifacts.some(value=>value.kind==='text'));assert.ok(f.node.processing.runtime.intake.list().formats.some(value=>value.id==='community.text-format'));
 const text=detail.artifacts.filter(value=>value.kind==='text').map(value=>JSON.stringify(f.node.processing.artifact(value.id).transcript)).join('\n');assert.match(text,/Generated\\nrecipe/);
 await f.action(instance.id,'disable');assert.ok(!f.node.processing.runtime.intake.list().formats.some(value=>value.id==='community.text-format'));assert.ok(!f.node.processing.runtime.recipes.list().recipes.some(value=>value.id==='community.text-pipeline'));
});
