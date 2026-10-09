/** Offline-by-default reuse of a completed caption/image Material. Private
 * source access and one live Ask require separate explicit host switches. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {cp,mkdir,readFile,realpath,stat,writeFile} from 'node:fs/promises';
import {basename,dirname,join,relative,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {backup,DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import sharp from 'sharp';
import {ComposedImageDisclosure} from './composed-image-disclosure.js';
import type {UsageReceipt} from '@mote/shared';
import {buildApp} from '../apps/server/src/app.js';
import {repositoryRoot,type Config} from '../apps/server/src/config.js';
import {codexModels} from '../apps/server/src/model-catalog.js';
import {sha256} from '../apps/server/src/store.js';
import {usageTotals} from '../apps/server/src/usage.js';
import {startBridge} from '../packages/agent/dist/bridge.js';
import {contextToolDefinitions} from '../packages/agent/dist/tool-contributions.js';

function outside(path:string){const value=resolve(path),part=relative(repositoryRoot,value);assert.ok(part==='..'||part.startsWith('../'),'Private files must stay outside Git');return value;}
assert.ok(process.env.MOTE_IMAGE_CONTEXT_MANIFEST,'Set MOTE_IMAGE_CONTEXT_MANIFEST');
const manifestBytes=await readFile(outside(process.env.MOTE_IMAGE_CONTEXT_MANIFEST));
const mode=z.enum(['preflight','live']).parse(process.env.MOTE_IMAGE_CONTEXT_MODE??'preflight');
const manifest=z.object({sourceRun:z.string(),sourceKind:z.enum(['one-record-import','composed-material']).default('one-record-import'),sourceVault:z.enum(['vault','seed-vault']).default('vault'),sourceReportSha256:z.string().length(64).optional(),sourceDatabaseSha256:z.string().length(64).optional(),output:z.string(),personalDataUsed:z.boolean(),imageDisclosureProtocol:z.enum(['one-original','bounded-views']).default('one-original'),imageSha256:z.string().length(64),captionBodySha256:z.string().length(64),question:z.string().min(1).max(2000),scope:z.object({after:z.string().datetime({offset:true}),before:z.string().datetime({offset:true}),timeZone:z.literal('Asia/Shanghai')}).optional(),maximumQueries:z.literal(1),queryTimeoutMs:z.union([z.literal(120000),z.literal(300000)]),model:z.literal('gpt-6-sol'),reasoningEffort:z.literal('max')}).passthrough().parse(JSON.parse(manifestBytes.toString()));
if(mode==='live')assert.equal(process.env.MOTE_IMAGE_CONTEXT_LIVE_AUTHORIZED,'1','Live requires explicit authorization for one Ask');
if(manifest.personalDataUsed){
 assert.equal(process.env.MOTE_PRIVATE_IMAGE_ACCESS,'1','Private source access requires a conscious-access switch before reading or cloning the source');
 if(mode==='live')assert.equal(process.env.MOTE_PRIVATE_IMAGE_CONSENT,'1','Private image transmission requires explicit user consent');
}
if(manifest.sourceKind==='composed-material'||manifest.imageDisclosureProtocol==='bounded-views')assert.equal(manifest.queryTimeoutMs,300000);
const source=outside(await realpath(outside(manifest.sourceRun))),directory=outside(join(await realpath(dirname(outside(manifest.output))),basename(manifest.output)));
for(const [from,to] of [[source,directory],[directory,source]]){const part=relative(from,to);assert.ok(part==='..'||part.startsWith('../'),'Source and destination must be disjoint');}
const seedBytes=await readFile(join(source,'report.json')),seed=JSON.parse(seedBytes.toString());
assert.equal(seed.status,'passed');assert.equal(seed.personalDataUsed,manifest.personalDataUsed);
const composition=manifest.sourceKind==='composed-material'?(seed.composition??seed.seed):undefined;
if(composition){assert.ok(manifest.sourceReportSha256&&manifest.sourceDatabaseSha256&&manifest.scope,'Composed reuse requires frozen source hashes and scope');assert.ok(seed.liveLlmUsed===false||seed.mode==='preflight');assert.equal(seed.modelCalls??seed.realModelCalls,0);assert.ok(composition.parentId&&composition.childId&&composition.attachmentId&&composition.materialRef);}
else{assert.equal(manifest.sourceKind,'one-record-import');assert.equal(seed.records,1);assert.equal(seed.linkedImages,1);assert.equal(seed.liveLlmUsed,false);}
const sourceVault=join(source,manifest.sourceVault),sourceDatabase=join(sourceVault,'mote.sqlite'),sourceDatabaseSha256=sha256(await readFile(sourceDatabase));
if(manifest.sourceReportSha256)assert.equal(sha256(seedBytes),manifest.sourceReportSha256);if(manifest.sourceDatabaseSha256)assert.equal(sourceDatabaseSha256,manifest.sourceDatabaseSha256);
// A read-only SQLite connection may leave a shared-memory index after close;
// it contains no committed data and must not be mistaken for a live writer.
for(const name of ['mote.sqlite-wal','logs/central.lock'])try{assert.equal((await stat(join(sourceVault,name))).size,0,'Source must be closed');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
await mkdir(directory,{mode:0o700});await writeFile(join(directory,'manifest.json'),manifestBytes,{mode:0o600,flag:'wx'});
await cp(sourceVault,join(directory,'vault'),{recursive:true,errorOnExist:true,filter:path=>!['mote.sqlite','mote.sqlite-wal','mote.sqlite-shm','logs','token'].includes(basename(path))});
const sourceDb=new DatabaseSync(sourceDatabase,{readOnly:true});try{assert.equal(sourceDb.prepare('PRAGMA quick_check').get()!.quick_check,'ok');await backup(sourceDb,join(directory,'vault','mote.sqlite'));}finally{sourceDb.close();}
const dataDir=join(directory,'vault'),token=randomBytes(32).toString('hex');
const config:Config={dataKey:undefined,dataDir,token,tokenPath:join(dataDir,'token'),host:'127.0.0.1',port:0,maxStorageBytes:500_000_000,maxExportBytes:20_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'gpt-6-sol',modelReasoningEffort:'max',modelProvider:'codex',modelProtocol:'codex-app-server',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'warn',diagnosticsEnabled:true,agentTraceEnabled:true,agentTimeoutMs:manifest.queryTimeoutMs,codexBin:mode==='live'?process.env.MOTE_CODEX_BIN:'/nonexistent-offline-image-provider',codexHome:mode==='live'?process.env.MOTE_CODEX_HOME:join(directory,'unused-codex-home')};
const report:Record<string,any>={status:'running',mode,startedAt:new Date().toISOString(),personalDataUsed:manifest.personalDataUsed,heldOut:false,model:'gpt-6-sol',reasoningEffort:'max',modelCalls:0,stubModelCalls:0,processorCalls:0,externalFetchAttempts:0,blockedLoopbackFetchAttempts:0,queryTimeoutMs:manifest.queryTimeoutMs,maximumQueries:1,imageDisclosureProtocol:manifest.imageDisclosureProtocol,maximumUniqueImagePayloads:manifest.imageDisclosureProtocol==='bounded-views'?4:1,automaticOuterRetries:0,semanticQualityAccepted:false,memoryGenerated:false,mediaProcessingTested:false,browserTested:false,physicalDeviceTested:false,sourceReportSha256:sha256(seedBytes),sourceDatabaseSha256,manifestSha256:sha256(manifestBytes),head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()};
report.codeHashes=Object.fromEntries(await Promise.all(['scripts/test-image-context-live.ts','scripts/composed-image-disclosure.ts','apps/server/src/evidence-image.ts','apps/server/src/evidence-reader.ts','apps/server/src/evidence-scope-record.ts','apps/server/src/file-raw-reader.ts','apps/server/src/app.ts','packages/agent/dist/bridge.js','packages/agent/dist/context-tools.js','packages/agent/dist/codex-agent.js','packages/agent/dist/codex-session.js'].map(async path=>[path,sha256(await readFile(join(repositoryRoot,path)))])));
let node:Awaited<ReturnType<typeof buildApp>>|undefined;
const priorUsageIds=new Set<string>();
const save=()=>writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
const realFetch=globalThis.fetch,manualBridges=new Map<string,string>(),modelTools=new Set<string>();let liveQueryActive=false,modelBridgeIdentity:string|undefined;
let activeImageAudit:ComposedImageDisclosure|undefined,activeImageAbort:AbortController|undefined;
let assertImageSelection:((selection:{id:string;attachmentId?:string})=>void)|undefined;
globalThis.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url),headers=new Headers(init?.headers),authorization=headers.get('authorization')??'';
 const local=url.protocol==='http:'&&url.hostname==='127.0.0.1'&&!!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&init?.method==='POST'&&headers.get('content-type')==='application/json';
 if(local&&manualBridges.get(url.origin)===authorization&&['timeline','evidence','read_image'].includes(url.pathname.slice(1)))return realFetch(input,init);
 if(local&&liveQueryActive&&/^Bearer [a-f0-9]{64}$/.test(authorization)&&modelTools.has(url.pathname.slice(1))){const identity=url.origin+' '+authorization;if(!modelBridgeIdentity||identity===modelBridgeIdentity){modelBridgeIdentity=identity;
  if(activeImageAudit&&url.pathname==='/read_image'){try{assert.equal(typeof init?.body,'string');assert.ok(assertImageSelection,'Image scope must be installed before transport');assertImageSelection(JSON.parse(init!.body as string));}catch(error){activeImageAbort?.abort(error);throw error;}}
  report.modelBridgeRequests=(report.modelBridgeRequests??0)+1;const response=await realFetch(input,init);
  if(activeImageAudit&&url.pathname==='/read_image'&&response.ok){try{await activeImageAudit.observeSuccessfulRead(JSON.parse(init!.body as string),await response.clone().json());}catch(error){activeImageAbort?.abort(error);throw error;}}
  return response;}}
 if(url.hostname==='127.0.0.1')report.blockedLoopbackFetchAttempts++;else report.externalFetchAttempts++;
 throw Error('Image reuse harness forbids this fetch');
};
try{
 await save();if(mode==='live'){const catalog=await codexModels(undefined,{executable:config.codexBin,home:config.codexHome});assert.ok(catalog.items.find(m=>m.id==='gpt-6-sol')?.reasoningEfforts?.includes('max'));}
 node=await buildApp(config,{backgroundWorker:false,...(mode==='preflight'?{createModelAgent:async()=>({configured:true,close:async()=>{},query:async()=>{report.stubModelCalls++;throw Error('Preflight forbids model calls');}})}:{})});
 for(const row of node.store.db.prepare('SELECT id FROM model_usage').all())priorUsageIds.add(String(row.id));report.inheritedUsageReceipts=priorUsageIds.size;
 for(const [name] of contextToolDefinitions({question:manifest.question,toolContributions:node.featureServices.archiveReader.contextTools?.()??[]}))modelTools.add(name);
 for(const entry of node.processing.runtime.registry.list())node.processing.runtime.registry.get(entry.id).process=async()=>{report.processorCalls++;throw Error('Reprocessing is forbidden');};
 for(const entry of node.workflows.registry.list())node.workflows.registry.get(entry.id)!.process=async()=>{report.processorCalls++;throw Error('Context processing is forbidden');};
 for(const field of ['model','reasoningEffort'] as const)assert.equal(node.modelSettings.current()[field],manifest[field]);
 assert.equal(node.modelSettings.current().agentTimeoutMs,manifest.queryTimeoutMs);
 assert.equal(node.modelSettings.current().protocol,'codex-app-server');assert.equal(node.modelSettings.current().provider,'codex');
 const settings=node.lifecycle.settings();for(const key of ['consolidation','insights','working'] as const)settings[key].enabled=false;node.lifecycle.configure(settings);
 node.perception.configure({...node.perception.settings(),allowQueryImages:true});
 const processing=node.processing.view();const disabled=await node.app.inject({method:'PUT',url:'/api/file-processing',headers:{authorization:'Bearer '+token},payload:{revision:processing.revision,settings:{...processing.settings,enabled:false,summarize:false}}});assert.equal(disabled.statusCode,200);
 const records=node.store.evidence(composition?[composition.parentId]:seed.job.captureIds);assert.equal(records.length,1);const parent=records[0],attachment=parent.provenance!.document!.attachments!.find(item=>!composition||item.id===composition.attachmentId)!;assert.ok(attachment);
 assert.equal(sha256(parent.ocrText),manifest.captionBodySha256);
 const image=node.archivedFiles.get(attachment.id!);assert.equal(image.hash,manifest.imageSha256);const originalBytes=node.archivedFiles.read(image.id);assert.equal(sha256(originalBytes),manifest.imageSha256);
 const geometry=await sharp(originalBytes,{limitInputPixels:40_000_000}).metadata();assert.ok(geometry.width&&geometry.height);
 const newImageAudit=()=>new ComposedImageDisclosure(manifest.imageDisclosureProtocol,originalBytes,geometry.width!,geometry.height!);
 report.parent={id:parent.id,bodySha256:sha256(parent.ocrText),bodyCharacters:parent.ocrText.length};report.image={id:image.id,sha256:image.hash,sizeBytes:image.sizeBytes};
 for(let i=0;i<100;i++)if(await node.materialOrganizer.tick(100)===0)break;
 if(composition){const material=node.materials.get(composition.materialRef);assert.ok(material&&material.ref===composition.materialRef);const ids=node.materials.evidenceIds(composition.materialRef);assert.equal(ids.length,composition.evidenceBlocks??composition.evidenceIds.length);report.composition={materialRef:material.ref,evidenceBlocks:ids.length};}
 const scope={...(manifest.scope??{after:'2026-04-13T00:00:00+08:00',before:'2026-04-14T00:00:00+08:00',timeZone:'Asia/Shanghai'}),deviceId:parent.deviceId};
 // This zero-model bridge is closed before the ordinary Ask and never supplies model context.
 const preflightAudit=newImageAudit(),bridge=await startBridge(node.featureServices.archiveReader,{question:manifest.question,...scope},manifest.imageDisclosureProtocol==='bounded-views'?12:6);
 manualBridges.set(bridge.url,'Bearer '+bridge.token);
 let selectedId:string;
 try{
  const call=async(tool:string,args:Record<string,unknown>)=>{const result=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify(args)});assert.equal(result.status,200,'Private image preflight failed before model admission');const value=await result.json() as any;if(tool==='read_image'){await preflightAudit.observeSuccessfulRead(args,value);if(value.imageDelivery)bridge.imageDelivery(value.imageDelivery,true);}return value;};
  const found=await call('timeline',{}),rows=Array.isArray(found.data)?found.data:found.data.items;assert.equal(rows.length,1);selectedId=rows[0].id;
  const expanded=await call('evidence',{ids:[selectedId]});assert.deepEqual(expanded.data[0].provenance.document,parent.provenance!.document);
  const imageSelection={id:selectedId,attachmentId:image.id};
  if(manifest.imageDisclosureProtocol==='bounded-views'){
   await call('read_image',{...imageSelection,view:'metadata'});
   // Generated-only, fixed geometry checks transport. No semantic choice or
   // pre-cropped image is ever supplied to a model, including a later live run.
   if(mode==='preflight'&&!manifest.personalDataUsed){const region={x:0,y:0,width:Math.min(64,Math.max(1,geometry.width!-1)),height:Math.min(64,Math.max(1,geometry.height!-1))},args={...imageSelection,expectedImageSha256:manifest.imageSha256,region};await call('read_image',args);await call('read_image',args);}
  }
  const original=await call('read_image',imageSelection);assert.equal(sha256(Buffer.from(original.image.data,'base64')),manifest.imageSha256);
  if(manifest.imageDisclosureProtocol==='bounded-views')await call('read_image',imageSelection);
  report.preflight={status:'passed',selectedId,parentId:parent.id,attachmentId:image.id,mimeType:original.image.mimeType,sha256:manifest.imageSha256,modelCalls:0,imageDisclosure:preflightAudit.snapshot(),separateFromLiveContext:true,generatedGeometryChecked:mode==='preflight'&&!manifest.personalDataUsed&&manifest.imageDisclosureProtocol==='bounded-views'};await save();
 }finally{manualBridges.delete(bridge.url);await bridge.close();}
 // Archive readers are immutable. Guard the existing callback transport before
 // forwarding a read; the image audit separately verifies original/output bytes.
 assertImageSelection=selection=>{assert.ok([parent.id,selectedId,composition?.childId].filter(Boolean).includes(selection.id),'Only the frozen parent or image child may disclose pixels');assert.ok(selection.attachmentId===undefined||selection.attachmentId===image.id,'Only the frozen attachment is authorized');};
 if(mode==='preflight'&&!manifest.personalDataUsed){
  // Generated-only proof of the separate Agent callback transport. This bridge
  // is deliberately absent from manualBridges and does not invoke an adapter/model.
  const audit=newImageAudit(),agentBridge=await startBridge(node.featureServices.archiveReader,{question:manifest.question,...scope},6);
  liveQueryActive=true;modelBridgeIdentity=undefined;activeImageAudit=audit;activeImageAbort=new AbortController();
  try{
   const call=async(tool:string,args:Record<string,unknown>)=>{const response=await fetch(agentBridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+agentBridge.token,'content-type':'application/json'},body:JSON.stringify(args)});assert.equal(response.status,200);const result=await response.json() as any;if(result.imageDelivery)agentBridge.imageDelivery(result.imageDelivery,true);return result;};
   const timeline=(await call('timeline',{})).data,rows=Array.isArray(timeline)?timeline:timeline.items;assert.equal(rows.length,1);assert.equal(rows[0].id,selectedId);
   await call('evidence',{ids:[selectedId]});const selected={id:selectedId,attachmentId:image.id};
   if(manifest.imageDisclosureProtocol==='bounded-views')await call('read_image',{...selected,view:'metadata'});
   await call('read_image',selected);
   if(manifest.imageDisclosureProtocol==='bounded-views')await call('read_image',selected);
   assert.equal(audit.snapshot().imagePayloads,1);const requestsBeforeInvalid=report.modelBridgeRequests;
   await assert.rejects(call('read_image',{id:'generated-out-of-scope'}),/Only the frozen parent/);
   await assert.rejects(call('read_image',{...selected,attachmentId:'generated-other-attachment'}),/Only the frozen attachment/);
   assert.equal(report.modelBridgeRequests,requestsBeforeInvalid,'Rejected selections must not reach the archive reader');
   report.agentBridgePreflight={...audit.snapshot(),realModelCalls:0,imageSelectionRejectedBeforeRead:true,transport:'Generated unregistered Agent callback bridge; no adapter or model invocation'};
  }finally{liveQueryActive=false;modelBridgeIdentity=undefined;activeImageAudit=undefined;activeImageAbort=undefined;await agentBridge.close();}
 }
 if(mode==='live'){
 const imageAudit=newImageAudit();
 const query=node.agent.query.bind(node.agent);node.agent.query=async input=>{
  assert.equal(report.modelCalls,0,'Only one query is authorized');assert.ok(!input.skill&&!input.evidenceIds&&!input.evidenceRanges&&!input.directImages?.length&&!input.conversation&&!input.taskContext&&!input.openingMemories?.length,'Use a fresh normal archive Ask');assert.equal(input.question,manifest.question);report.modelCalls++;report.trace=[];await save();
  const deadline=AbortSignal.timeout(manifest.queryTimeoutMs),auditAbort=new AbortController(),signal=AbortSignal.any([deadline,auditAbort.signal,...(input.signal?[input.signal]:[])]);
  liveQueryActive=true;modelBridgeIdentity=undefined;activeImageAudit=imageAudit;activeImageAbort=auditAbort;try{return await query({...input,signal,onTrace:event=>{report.trace.push(event);input.onTrace?.(event);}});}finally{liveQueryActive=false;activeImageAudit=undefined;activeImageAbort=undefined;modelBridgeIdentity=undefined;report.imageDisclosure=imageAudit.snapshot();report.visibleModelTurns=report.trace.filter((event:any)=>event.type==='model.started').length;report.visibleRepairTurns=report.trace.filter((event:any)=>event.type==='model.started'&&event.payload?.repair===true).length;await save();}
 };
 await node.app.ready();report.question=manifest.question;await save();console.log(JSON.stringify({stage:'query-started',model:report.model,reasoningEffort:report.reasoningEffort}));
 const start=Date.now(),response=await node.app.inject({method:'POST',url:'/api/query',headers:{authorization:'Bearer '+token,'accept-language':'zh-CN'},payload:{question:manifest.question,...scope}});
 report.durationMs=Date.now()-start;report.httpStatus=response.statusCode;report.result=response.json();await save();assert.equal(response.statusCode,200,'Ask did not complete; preserve the failure without retry');
 report.imageDisclosure=imageAudit.verifyModelDelivery(report.result.trace,report.trace);report.imagePayloads=report.imageDisclosure.imagePayloads;report.modelImageReadVerified=true;assert.equal(report.modelCalls,1);
 }
 assert.equal(report.processorCalls,0);assert.equal(report.stubModelCalls,0);assert.equal(report.externalFetchAttempts,0);assert.equal(report.blockedLoopbackFetchAttempts,0);assert.equal(report.modelCalls,mode==='live'?1:0);
 assert.equal(sha256(node.store.evidence([parent.id])[0].ocrText),manifest.captionBodySha256);assert.equal(sha256(node.archivedFiles.read(image.id)),manifest.imageSha256);
 assert.equal(node.memoryPipeline.list().length,0);report.originalsUnchanged=true;report.status='passed';
}catch(error){report.status='failed';report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{
 if(node){
  if(report.parent&&report.image)report.originalsUnchanged=sha256(node.store.evidence([report.parent.id])[0].ocrText)===manifest.captionBodySha256&&sha256(node.archivedFiles.read(report.image.id))===manifest.imageSha256;
  // The HTTP deadline can return before cancellation settles its usage receipt.
  // Drain the app before taking the authoritative terminal usage snapshot.
  await node.app.close();const db=new DatabaseSync(join(dataDir,'mote.sqlite'),{readOnly:true});
  try{const receipts=db.prepare('SELECT json FROM model_usage').all().map(row=>JSON.parse(String(row.json)) as UsageReceipt).filter(receipt=>!priorUsageIds.has(receipt.id));report.usage={total:usageTotals(receipts),items:receipts};}finally{db.close();}
 }
 globalThis.fetch=realFetch;assert.equal(sha256(await readFile(join(source,'report.json'))),sha256(seedBytes));assert.equal(sha256(await readFile(sourceDatabase)),sourceDatabaseSha256);report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({stage:'finished',status:report.status,mode,modelCalls:report.modelCalls,report:join(directory,'report.json')}));
}
