/** Generated caption + long image + reused OCR proof. Default offline; no quality claim.
 * MOTE_COMPOSED_IMAGE_OUTPUT=/external/new-run node --import tsx scripts/test-composed-image-context.ts
 * Live additionally requires MODE=live and SEED=/external/passed-preflight. One ordinary Ask only.
 * The evaluator rubric is hashed, never parsed into model context. Frozen v1 assets stay external.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {cp,mkdir,readFile,realpath,rename,stat,writeFile} from 'node:fs/promises';
import {basename,dirname,join,relative,resolve} from 'node:path';
import {backup,DatabaseSync} from 'node:sqlite';
import type {UsageReceipt} from '@mote/shared';
import {startBridge} from '../packages/agent/dist/bridge.js';
import {buildApp} from '../apps/server/src/app.js';
import {repositoryRoot,type Config} from '../apps/server/src/config.js';
import {materialId} from '../apps/server/src/materials.js';
import {sha256} from '../apps/server/src/store.js';
import {usageTotals} from '../apps/server/src/usage.js';

const frozenManifestHash='64196b1f2cf450e2b35ed4d84ec744061feaf628d999d2e83afcceaf0e5ed900';
type Fixture={schemaVersion:1;id:string;personalDataUsed:false;heldOut:false;sourceId:string;deviceId:string;externalId:string;donorSourceId:string;donorDeviceId:string;
 image:{file:string;mimeType:'image/png';width:number;height:number};caption:string;recordedAt:string;observedAt:string;contextTime:string;question:string;
 ocr:{provenance:string;segments:{startMs:number;endMs:number;text:string;imageLocation:{width:number;height:number;polygon:number[][]}}[]}};
type Node=Awaited<ReturnType<typeof buildApp>>;
type Seed={parentId:string;attachmentId:string;childId:string;donorId:string;materialRef:string;evidenceIds:string[];required:string[];fingerprint:string;artifactId:string};
const mode=process.env.MOTE_COMPOSED_IMAGE_MODE??'preflight';assert.ok(mode==='preflight'||mode==='live');const live=mode==='live';
const json=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
function disjoint(a:string,b:string){for(const [from,to] of [[a,b],[b,a]]){const part=relative(from,to);assert.ok(part==='..'||part.startsWith('../'),'Paths must be disjoint');}}
async function external(path:string){const actual=await realpath(resolve(path));disjoint(repositoryRoot,actual);return actual;}
const fixtureRoot=await external(process.env.MOTE_COMPOSED_IMAGE_FIXTURE??'/Users/utopiafar/Documents/Codex/mote-goal-2026-09-27/generated-composed-image-v1');
const manifestBytes=await readFile(join(fixtureRoot,'manifest.json'));assert.equal(sha256(manifestBytes),frozenManifestHash,'Frozen generated v1 manifest changed');
const manifest=JSON.parse(manifestBytes.toString()) as {files:Record<string,{sha256:string;bytes:number}>};
for(const [name,file] of Object.entries(manifest.files)){assert.ok(!name.includes('..')&&!name.startsWith('/'));const bytes=await readFile(join(fixtureRoot,name));assert.equal(sha256(bytes),file.sha256);assert.equal(bytes.length,file.bytes);}
const fixture=JSON.parse(await readFile(join(fixtureRoot,'input.json'),'utf8')) as Fixture;
assert.equal(fixture.personalDataUsed,false);assert.equal(fixture.image.file,'discussion.png');assert.equal(fixture.ocr.segments.length,28);
const bytes=await readFile(join(fixtureRoot,fixture.image.file)),imageHash=sha256(bytes),token=randomBytes(32).toString('hex');
assert.ok(process.env.MOTE_COMPOSED_IMAGE_OUTPUT,'An explicit new external output directory is required');
const output=join(await external(dirname(resolve(process.env.MOTE_COMPOSED_IMAGE_OUTPUT))),basename(resolve(process.env.MOTE_COMPOSED_IMAGE_OUTPUT)));
assert.notEqual(output,fixtureRoot);await mkdir(output,{mode:0o700});
const report:Record<string,any>={status:'running',mode,startedAt:new Date().toISOString(),personalDataUsed:false,heldOut:false,semanticQualityAccepted:false,
 realModelCalls:0,stubModelCalls:0,ocrStubCalls:0,realOcrCalls:0,asrCalls:0,externalFetchAttempts:0,backgroundWorker:false,memoryGenerated:false,browserTested:false,physicalDeviceTested:false,
 fixtureRoot,manifestSha256:frozenManifestHash,fixtureFiles:manifest.files,model:{provider:'codex',protocol:'codex-app-server',model:'gpt-6-sol',reasoningEffort:'max'},
 modelConfigurationScope:live?'actual live configuration':'reserved live configuration; offline factory rejects every query',contextTimeAdapter:{value:fixture.contextTime,scope:'Same frozen host time for tool preflight and the optional ordinary Ask; no answer or rubric injected'},
 limits:{maximumOuterCalls:1,perCallTimeoutMs:300000,automaticOuterRetries:0},checks:[],toolReads:[],permissionClones:[],calls:[],usageByVault:[],
 limitations:['Generated fixed sample, not held out or personal data.','OCR is a once-only known-text stub; accuracy is not tested.','Offline preflight proves structure and authorization, not semantic/visual understanding.',
  'One outer query may contain provider-internal requests or one output-validation repair; visible turns are recorded separately.','The 300 second bound is a model call deadline, not a whole-process watchdog.'],
 head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()};
const codeFiles=['scripts/test-composed-image-context.ts','apps/server/src/app.ts','apps/server/src/evidence-reader.ts','apps/server/src/evidence-image.ts','apps/server/src/file-attachments.ts','apps/server/src/file-processing.ts',
 'packages/agent/dist/bridge.js','packages/agent/dist/codex-agent.js','packages/agent/dist/codex-session.js'];
report.codeHashes=Object.fromEntries(await Promise.all(codeFiles.map(async path=>[path,sha256(await readFile(join(repositoryRoot,path)))])));
let node:Node|undefined,currentVault='',seed:Seed,saveChain=Promise.resolve(),ocrAllowed=false;
const reportPath=join(output,'report.json');
function save(){const value=json(report);saveChain=saveChain.then(async()=>{await writeFile(reportPath+'.tmp',value,{mode:0o600});await rename(reportPath+'.tmp',reportPath);});return saveChain;}
function check(name:string){report.checks.push(name);}
const realFetch=globalThis.fetch,bridgeOrigins=new Set<string>();
globalThis.fetch=async(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 if(bridgeOrigins.has(url.origin)&&url.hostname==='127.0.0.1')return realFetch(input,init);
 // The Codex App Server uses its own stdio process; this runner never permits HTTP OCR or other fetches.
 report.externalFetchAttempts++;throw Error('Composed-image harness forbids outbound fetch: '+url.origin);};
function config(vault:string):Config{return {dataKey:undefined,dataDir:vault,token,tokenPath:join(vault,'token'),host:'127.0.0.1',port:0,maxStorageBytes:100_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
 model:live?'gpt-6-sol':'offline-composed-image',modelReasoningEffort:'max',modelProvider:live?'codex':'custom',modelProtocol:live?'codex-app-server':'openai-completions',modelBaseUrl:live?'':'http://127.0.0.1:1',apiKey:'',allowUnauthenticatedLocal:false,
 embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'warn',diagnosticsEnabled:false,agentTraceEnabled:true,agentTimeoutMs:300000,
 codexBin:live?process.env.MOTE_CODEX_BIN:'/nonexistent-offline-composed-image-provider',codexHome:live?process.env.MOTE_CODEX_HOME:join(output,'unused-codex-home')};}
async function open(vault:string){assert.equal(node,undefined);currentVault=vault;
 node=await buildApp(config(vault),{backgroundWorker:false,...(live?{}:{createModelAgent:async()=>({configured:true,close:async()=>{},query:async()=>{report.stubModelCalls++;throw Error('Offline preflight must never call a model');}})})});
 await node.processing.runtime.ready;
 node.processing.runtime.registry.get('image.http').process=async()=>{assert.ok(!live&&ocrAllowed&&report.ocrStubCalls===0,'A second OCR invocation or live OCR is forbidden');report.ocrStubCalls++;return {durationMs:0,segments:fixture.ocr.segments};};
 const settings=node.lifecycle.settings();for(const key of ['extraction','consolidation','insights','working'] as const)settings[key].enabled=false;node.lifecycle.configure(settings);
 node.perception.configure({...node.perception.settings(),allowQueryImages:true});await node.app.ready();
 if(live){const current=node.modelSettings.current();assert.equal(current.model,'gpt-6-sol');assert.equal(current.reasoningEffort,'max');assert.equal(current.agentTimeoutMs,300000);}
}
async function close(){if(!node)return;const closing=node;node=undefined;await closing.app.close();
 const db=new DatabaseSync(join(currentVault,'mote.sqlite'),{readOnly:true});try{const receipts=db.prepare('SELECT json FROM model_usage ORDER BY created_at,id').all().map(row=>JSON.parse(String(row.json)) as UsageReceipt);
 report.usageByVault.push({vault:relative(output,currentVault),readAfterAppClose:true,receipts,total:usageTotals(receipts)});
 }finally{db.close();}await save();}
async function request(method:'GET'|'POST'|'PUT'|'DELETE',url:string,payload?:unknown,binary=false){const response=await node!.app.inject({method,url,headers:{authorization:'Bearer '+token,'x-mote-ingress-version':'2',...(binary?{'content-type':'application/octet-stream'}:{})},...(payload===undefined?{}:{payload:payload as any})});
 assert.ok(response.statusCode>=200&&response.statusCode<300,`${method} ${url}: ${response.statusCode} ${response.body}`);return response.json();}
async function organize(){for(let i=0;i<30;i++)if(await node!.materialOrganizer.tick(100)===0)return;throw Error('Material organizer did not settle');}
function noDerived(){for(const table of ['memories','memory_jobs','insights'])assert.equal(node!.store.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,0,`${table} must remain empty`);}
async function seedOffline(){await open(join(output,'seed-vault'));
 await request('PUT','/api/file-processing',{revision:node!.processing.view().revision,settings:{...node!.processing.view().settings,enabled:true,imageProcessor:'image.http',imageEndpoint:'http://127.0.0.1:1/forbidden-ocr',summarize:false}});
 for(const [id,deviceId] of [[fixture.sourceId,fixture.deviceId],[fixture.donorSourceId,fixture.donorDeviceId]])await request('POST','/api/sources',{id,name:id,kind:'upload',deviceId,platform:'import',retention:'archive'});
 const upload=await request('POST','/api/file-sync/v1/uploads',{sourceId:fixture.donorSourceId,item:{externalId:'ocr-donor.png',revision:'1',observedAt:fixture.observedAt,kind:'file',layer:'original',title:'Generated OCR donor',mimeType:'image/png',text:''},sha256:imageHash,sizeBytes:bytes.length});
 await request('PUT',`/api/file-sync/v1/uploads/${upload.uploadId}/parts/0`,bytes,true);const donor=await request('POST',`/api/file-sync/v1/uploads/${upload.uploadId}/commit`);
 ocrAllowed=true;try{await node!.processing.tick();}finally{ocrAllowed=false;}assert.equal(report.ocrStubCalls,1);assert.equal(node!.files.detail(donor.id).job.state,'succeeded');
 const donorArtifact=node!.files.detail(donor.id).artifacts.find((a:any)=>a.kind==='image-text')!;assert.ok(donorArtifact);
 // The ordinary archive service owns attachment bytes; Source ingress owns the authored record.
 const archived=node!.archivedFiles.put({name:'discussion.png',mimeType:'image/png',bytes});
 const item={externalId:fixture.externalId,revision:'1',observedAt:fixture.observedAt,kind:'message',layer:'original',title:'Saved fictional repair discussion',text:fixture.caption,
  document:{contentRole:'authored',recordedAt:fixture.recordedAt,timeBasis:'recorded',attachments:[{id:archived.id,name:archived.name,mimeType:archived.mimeType}]}};
 const parent=await request('PUT',`/api/sources/${fixture.sourceId}/items`,item);node!.archivedFiles.attach(parent.id,[archived.id]);await organize();
 const id=materialId(fixture.sourceId,fixture.externalId),initial=node!.materials.input(id,['source-body'])!;assert.ok(initial.ready);
 const child=await request('POST',`/api/records/${parent.id}/attachments/${archived.id}/processing`,{mimeType:'image/png'});
 assert.equal((await request('POST',`/api/records/${parent.id}/attachments/${archived.id}/processing`,{mimeType:'image/png'})).duplicate,true);
 await organize();const required=['source-body',`attachment/${archived.id}/text`];assert.equal(node!.materials.input(id,required)!.ready,false);
 assert.equal(node!.materials.input(id,['source-body'])!.fingerprint,initial.fingerprint);check('caption stays ready while attachment processing waits');
 await node!.processing.tick();await organize();assert.equal(report.ocrStubCalls,1);assert.equal(node!.files.detail(child.captureId).job.state,'succeeded');
 const artifact=node!.files.detail(child.captureId).artifacts.find((a:any)=>a.kind==='image-text') as any;assert.equal(artifact.reuse.artifactId,donorArtifact.id);assert.equal(artifact.reuse.captureId,donor.id);
 const pin=node!.materials.input(id,required)!;assert.ok(pin.ready);const material=node!.materials.get(id)!;assert.equal(material.memberCount,2);assert.equal(material.coverage.state,'complete');
 seed={parentId:parent.id,attachmentId:archived.id,childId:child.captureId,donorId:donor.id,materialRef:material.ref,evidenceIds:pin.evidenceIds,required,fingerprint:pin.fingerprint,artifactId:artifact.id};report.seed=seed;
 check('formal attachment path reuses the donor OCR without a second processor call');verifySeed();await toolPreflight('initial');noDerived();await close();
 await open(join(output,'seed-vault'));await organize();await node!.processing.tick();verifySeed();await toolPreflight('restart');assert.equal(report.ocrStubCalls,1);noDerived();check('close and restart preserve exact composition and do not reprocess');await close();
}
function verifySeed(){const parent=node!.store.evidence([seed.parentId])[0];assert.equal(parent.ocrText,fixture.caption);assert.equal(parent.provenance!.document!.recordedAt,fixture.recordedAt);
 assert.equal(parent.provenance!.document!.attachments![0].id,seed.attachmentId);assert.equal(sha256(node!.archivedFiles.read(seed.attachmentId)),imageHash);
 assert.equal(node!.materials.input(seed.materialRef,seed.required)!.fingerprint,seed.fingerprint);
 const records=node!.materials.evidence(seed.evidenceIds),geometry=records.flatMap(record=>{const value=JSON.parse(record.ocrText);return value.imageLocation?[value]:[];});
 assert.equal(geometry.length,fixture.ocr.segments.length);for(const [i,value] of geometry.entries()){assert.equal(value.text,fixture.ocr.segments[i].text);assert.deepEqual(value.imageLocation,fixture.ocr.segments[i].imageLocation);}
 const artifact=node!.files.detail(seed.childId).artifacts.find((a:any)=>a.id===seed.artifactId) as any;assert.ok(artifact?.reuse);assert.equal(artifact.reuse.captureId,seed.donorId);
}
async function bridgeSession(label:string){const bridge=await startBridge(node!.featureServices.archiveReader,{question:fixture.question,deviceId:fixture.deviceId,contextTime:fixture.contextTime,timeZone:'Asia/Shanghai'},80);
 const origin=new URL(bridge.url).origin;bridgeOrigins.add(origin);
 const call=async(tool:string,args:Record<string,unknown>,expected=200)=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify(args)}),value=await response.json() as any;
  report.toolReads.push({label,tool,args,status:response.status,...(value.image?{image:{mimeType:value.image.mimeType,sha256:sha256(Buffer.from(value.image.data,'base64'))}}:{result:value})});
  if(expected===200)assert.equal(response.status,200,`${tool}: ${json(value)}`);else assert.notEqual(response.status,200,tool+' must be denied');return value;};
 return {call,async close(){bridgeOrigins.delete(origin);await bridge.close();}};
}
async function toolPreflight(label:string){const session=await bridgeSession(label);try{
 const found=await session.call('material_catalog',{limit:12});const material=found.data.items.find((m:any)=>m.ref===seed.materialRef);assert.ok(material);
 let offset=0,full='',pages=0;const refs=new Set<string>();do{const page=(await session.call('material_read',{ref:seed.materialRef,offset,length:900})).data;
  assert.ok(page.text.length<=900);assert.equal(page.textRange.offset,offset);full+=page.text;page.originalRefs.forEach((id:string)=>refs.add(id));pages++;offset=page.textRange.nextOffset;
  assert.ok(pages<=40,'Bounded material pages exhausted');}while(offset!==null);
 assert.ok(full.includes(fixture.caption));for(const segment of fixture.ocr.segments)assert.ok(full.includes(segment.text));assert.ok(pages>1);
 const timeline=(await session.call('timeline',{limit:12})).data;const rows=Array.isArray(timeline)?timeline:timeline.items;assert.equal(rows.length,1);const selected=rows[0].id;
 const detail=(await session.call('evidence',{ids:[selected],offset:0,length:900})).data[0];assert.ok(detail.ocrText.includes(fixture.caption));assert.equal(detail.provenance.document.attachments[0].id,seed.attachmentId);
 const image=await session.call('read_image',{id:selected,attachmentId:seed.attachmentId});assert.equal(sha256(Buffer.from(image.image.data,'base64')),imageHash);
 // Material pages authorize their original members, not every internal formal anchor.
 assert.ok(refs.has(seed.parentId)&&refs.has(seed.childId));
 for(const segment of fixture.ocr.segments)assert.ok(full.includes(JSON.stringify(segment.imageLocation)),'Image coordinates must survive the normal bounded material pages');
 check(label+': ordinary tools expose complete caption/OCR, bounded pages, coordinates and exact attachment bytes');return selected;
 }finally{await session.close();}}
async function closed(vault:string){for(const file of ['mote.sqlite-wal','logs/central.lock'])try{assert.equal((await stat(join(vault,file))).size,0,'Snapshot source is not closed');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
async function clone(source:string,target:string){await closed(source);const before=sha256(await readFile(join(source,'mote.sqlite')));
 await cp(source,target,{recursive:true,errorOnExist:true,force:false,filter:path=>!['mote.sqlite','mote.sqlite-wal','mote.sqlite-shm','logs','token'].includes(basename(path))});
 const db=new DatabaseSync(join(source,'mote.sqlite'),{readOnly:true});try{assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check,'ok');await backup(db,join(target,'mote.sqlite'));}finally{db.close();}
 const targetDb=new DatabaseSync(join(target,'mote.sqlite'));try{targetDb.exec('PRAGMA journal_mode=DELETE');assert.equal(targetDb.prepare('PRAGMA quick_check').get()!.quick_check,'ok');}finally{targetDb.close();}
 assert.equal(sha256(await readFile(join(source,'mote.sqlite'))),before);return {sourceDatabaseSha256:before,method:'sqlite.backup'};}
async function permissionClone(kind:'deleted-parent'|'image-disclosure-revoked'){const source=join(output,'seed-vault'),target=join(output,kind+'-vault'),copy=await clone(source,target);await open(target);verifySeed();const session=await bridgeSession(kind);
 try{const rows=(await session.call('timeline',{})).data;const selected=(Array.isArray(rows)?rows:rows.items)[0].id;await session.call('evidence',{ids:[selected]});
  if(kind==='deleted-parent')await request('DELETE',`/api/captures/${seed.parentId}`);else node!.perception.configure({...node!.perception.settings(),allowQueryImages:false});
  await session.call('read_image',{id:selected,attachmentId:seed.attachmentId},403);await assert.rejects(node!.featureServices.archiveReader.readImage!({id:seed.childId}));
  if(kind==='deleted-parent'){assert.equal(node!.store.evidence([seed.parentId]).length,0);assert.equal(node!.files.version(seed.donorId).object_hash,imageHash);}
  noDerived();report.permissionClones.push({kind,...copy,deniedAfterExpansion:true,donorPreserved:kind==='deleted-parent'});check(kind+': stale tool grant cannot read image');
 }finally{await session.close();await close();}
 assert.equal(sha256(await readFile(join(source,'mote.sqlite'))),copy.sourceDatabaseSha256,'Destructive check changed the normal seed');}
async function liveAsk(){assert.ok(process.env.MOTE_COMPOSED_IMAGE_SEED,'Live requires a passed offline seed directory');const source=await external(process.env.MOTE_COMPOSED_IMAGE_SEED);disjoint(source,output);
 const original=await readFile(join(source,'report.json')),prior=JSON.parse(original.toString());assert.equal(prior.status,'passed');assert.equal(prior.mode,'preflight');assert.equal(prior.manifestSha256,frozenManifestHash);assert.equal(prior.realModelCalls,0);assert.equal(prior.ocrStubCalls,1);assert.equal(prior.externalFetchAttempts,0);
 assert.equal(sha256(await readFile(join(source,'seed-vault/mote.sqlite'))),prior.seedDatabaseSha256,'Offline seed changed after preflight');
 seed=prior.seed;report.seed=seed;report.source={reportSha256:sha256(original),...await clone(join(source,'seed-vault'),join(output,'live-vault'))};await open(join(output,'live-vault'));verifySeed();noDerived();await toolPreflight('live-before-admission');
 const query=node!.agent.query.bind(node!.agent);node!.agent.query=async input=>{assert.equal(report.realModelCalls,0,'Single outer Ask only');assert.ok(!input.skill&&!input.evidenceIds&&!input.evidenceRanges&&!input.directImages?.length&&!input.conversation&&!input.taskContext&&!input.openingMemories?.length,'Use the normal fresh read-only Ask');assert.equal(input.question,fixture.question);report.realModelCalls++;
  const call:Record<string,any>={status:'running',startedAt:new Date().toISOString(),input:{...input,contextTime:fixture.contextTime,signal:undefined,onTrace:undefined,onProgress:undefined,validateOutput:undefined},trace:[]};report.calls.push(call);await save();
  const deadline=AbortSignal.timeout(300000),signal=input.signal?AbortSignal.any([input.signal,deadline]):deadline;
  try{const result=await query({...input,contextTime:fixture.contextTime,signal,onTrace:event=>{call.trace.push(event);input.onTrace?.(event);}});call.status='completed';call.result=result;return result;}
  catch(error){call.status='failed';call.error=errorText(error);throw error;}finally{call.durationMs=Date.now()-Date.parse(call.startedAt);call.visibleModelTurns=call.trace.filter((e:any)=>e.type==='model.started').length;call.visibleRepairTurns=call.trace.filter((e:any)=>e.type==='model.started'&&e.payload?.repair===true).length;await save();}};
 const start=Date.now(),response=await node!.app.inject({method:'POST',url:'/api/query',headers:{authorization:'Bearer '+token,'accept-language':'zh-CN'},payload:{question:fixture.question,deviceId:fixture.deviceId,timeZone:'Asia/Shanghai'}});
 report.httpStatus=response.statusCode;report.durationMs=Date.now()-start;report.result=response.json();await save();assert.equal(response.statusCode,200,'Ask failed; no automatic retry');
 const reads=report.result.trace.filter((event:any)=>event.tool==='read_image'&&event.arguments.attachmentId===seed.attachmentId);assert.ok(reads.length,'No successful ordinary read_image of the exact attachment');report.modelImageReadVerified=true;
 verifySeed();noDerived();assert.equal(report.ocrStubCalls,0);assert.equal(report.realModelCalls,1);assert.equal(sha256(await readFile(join(source,'report.json'))),sha256(original));assert.equal(sha256(await readFile(join(source,'seed-vault/mote.sqlite'))),report.source.sourceDatabaseSha256);
 check('one ordinary Ask completed with source image read; semantic verdict remains pending independent rubric review');}
try{await save();if(live)await liveAsk();else{await seedOffline();await permissionClone('deleted-parent');await permissionClone('image-disclosure-revoked');assert.equal(report.stubModelCalls,0);assert.equal(report.ocrStubCalls,1);report.seedDatabaseSha256=sha256(await readFile(join(output,'seed-vault/mote.sqlite')));}
 assert.equal(report.externalFetchAttempts,0);report.status='passed';
}catch(error){report.status='failed';report.failure=errorText(error);process.exitCode=1;}
finally{try{await close();}catch(error){report.status='failed';report.closeFailure=errorText(error);process.exitCode=1;}globalThis.fetch=realFetch;report.finishedAt=new Date().toISOString();await save();console.log(json({status:report.status,mode,report:reportPath,realModelCalls:report.realModelCalls,stubModelCalls:report.stubModelCalls,ocrStubCalls:report.ocrStubCalls}));}
