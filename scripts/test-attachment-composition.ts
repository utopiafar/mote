/** Opt-in composition proof using a closed OCR vault and an explicitly selected
 * import. No live models or extraction requests; private output stays outside Git. */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {cp,mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {basename,join,relative,resolve} from 'node:path';
import {z} from 'zod';
import type {ImportJob} from '@mote/shared';
import {buildApp} from '../apps/server/src/app.js';
import {repositoryRoot,type Config} from '../apps/server/src/config.js';
import {sha256} from '../apps/server/src/store.js';
import {materialId} from '../apps/server/src/materials.js';

function outside(path:string){const value=resolve(path),part=relative(repositoryRoot,value);assert.ok(part==='..'||part.startsWith('../'),'Private files must stay outside Git');return value;}
assert.ok(process.env.MOTE_ATTACHMENT_COMPOSITION_MANIFEST,'Set MOTE_ATTACHMENT_COMPOSITION_MANIFEST');
const manifestBytes=await readFile(outside(process.env.MOTE_ATTACHMENT_COMPOSITION_MANIFEST));
const manifest=z.object({sourceRun:z.string(),input:z.string(),output:z.string(),python:z.string(),timeZoneOffset:z.string(),personalDataUsed:z.boolean(),imageSha256:z.string().length(64),captionBodySha256:z.string().length(64)}).strict().parse(JSON.parse(manifestBytes.toString()));
const source=outside(manifest.sourceRun),input=outside(manifest.input),output=outside(manifest.output);
for(const [from,to] of [[source,output],[output,source]]){const part=relative(from,to);assert.ok(part==='..'||part.startsWith('../'),'Source and destination must be disjoint');}
const seedBytes=await readFile(join(source,'report.json'));assert.equal(JSON.parse(seedBytes.toString()).status,'passed');
// A read-only SQLite inspection can leave an empty WAL and a nonempty SHM index.
// The selected source must be checkpointed; SHM bytes are not pending writes.
try{assert.equal((await stat(join(source,'vault/mote.sqlite-wal'))).size,0,'Source must be checkpointed');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
await mkdir(output,{mode:0o700});await writeFile(join(output,'manifest.json'),manifestBytes,{mode:0o600,flag:'wx'});await cp(join(source,'vault'),join(output,'vault'),{recursive:true,errorOnExist:true});
const dataDir=join(output,'vault'),token=randomBytes(32).toString('hex'),packRoot=join(repositoryRoot,'plugins/source-packs/memex-markdown');
const config:Config={dataKey:undefined,dataDir,token,tokenPath:join(dataDir,'token'),host:'127.0.0.1',port:0,maxStorageBytes:500_000_000,maxExportBytes:20_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'gpt-6-sol',modelReasoningEffort:'max',modelProvider:'codex',modelProtocol:'codex-app-server',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'warn',importPythonPacks:[{id:'memex.markdown',version:'1',packRoot,script:'main.py',scriptSha256:sha256(await readFile(join(packRoot,'main.py'))),pythonExecutable:resolve(manifest.python),maxInputFiles:256,maxOutputBytes:2*1024*1024,config:{timeZoneOffset:manifest.timeZoneOffset}}]};
const report:Record<string,any>={status:'running',startedAt:new Date().toISOString(),personalDataUsed:manifest.personalDataUsed,liveLlmUsed:false,modelCalls:0,extractionCalls:0,memoryGenerated:false,semanticQualityAccepted:false,browserTested:false,physicalDeviceTested:false,timeZoneBasis:'explicit_test_assumption',sourceReportSha256:sha256(seedBytes)};
let node:Awaited<ReturnType<typeof buildApp>>|undefined;
const save=()=>writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
async function start(){
 node=await buildApp(config,{backgroundWorker:false,createModelAgent:async()=>({configured:false,close:async()=>{},query:async()=>{report.modelCalls++;throw Error('Live models are not authorized by this composition check');}})});
 await node.processing.runtime.ready;
 node.processing.runtime.registry.get('image.http').process=async()=>{report.extractionCalls++;throw Error('Expected existing compatible extraction; do not reprocess');};
 const settings=node.lifecycle.settings();for(const key of ['extraction','consolidation','insights','working'] as const)settings[key].enabled=false;node.lifecycle.configure(settings);
 node.perception.configure({...node.perception.settings(),allowQueryImages:true});await node.app.ready();
}
async function request(method:'GET'|'POST',url:string,payload?:Record<string,unknown>){const response=await node!.app.inject({method,url,headers:{authorization:'Bearer '+token},...(payload?{payload}:{})});assert.ok(response.statusCode>=200&&response.statusCode<300,`${method} ${url}: ${response.statusCode}`);return response;}
async function settled(id:string){const deadline=Date.now()+60000;for(;;){const job=(await request('GET',`/api/imports/${id}`)).json<ImportJob>();if(!['queued','preparing','importing'].includes(job.status))return job;assert.ok(Date.now()<deadline,'Import did not settle');await new Promise(done=>setTimeout(done,500));}}
async function organize(){for(let i=0;i<100;i++)if(await node!.materialOrganizer.tick(100)===0)return;throw Error('Organizer did not settle');}
try{
 await save();await start();
 const before=node!.store.db.prepare('SELECT COUNT(*) n FROM model_usage').get()!.n;
 const donor=node!.store.db.prepare('SELECT capture_id FROM file_versions WHERE object_hash=?').get(manifest.imageSha256);assert.ok(donor);
 const existing=node!.files.detail(String(donor.capture_id)).artifacts.find((a:any)=>a.kind==='image-text');assert.ok(existing);
 const bytes=await readFile(input);report.inputSha256=sha256(bytes);
 const ack=(await request('POST','/api/imports',{requestId:randomUUID(),name:'Selected attachment composition validation',processing:'automatic',sourcePackId:'memex.markdown',files:[{name:basename(input),dataBase64:bytes.toString('base64')}]})).json<ImportJob>();
 let job=await settled(ack.id);
 if(job.status==='awaiting_confirmation'){
  assert.equal(job.dispositions?.counts.unsupported,0);assert.equal(job.warnings.length,0);
  assert.ok(job.dispositions?.items.filter(item=>item.status==='excluded').every(item=>item.path.split('/').includes('__MACOSX')||['.DS_Store','README.md'].includes(basename(item.path))));
  await request('POST',`/api/imports/${job.id}/confirm`,{});job=await settled(job.id);
 }
 assert.equal(job.status,'completed');assert.equal(job.captureIds.length,1);
 const parent=node!.store.evidence(job.captureIds)[0];assert.equal(sha256(parent.ocrText),manifest.captionBodySha256);
 const declared=parent.provenance!.document!.attachments!;assert.equal(declared.length,1);
 const original=node!.archivedFiles.get(declared[0].id!);assert.equal(original.hash,manifest.imageSha256);assert.equal(sha256(node!.archivedFiles.read(original.id)),manifest.imageSha256);
 await organize();const id=materialId(parent.provenance!.sourceId,parent.provenance!.externalId),body=node!.materials.input(id,['source-body'])!;assert.ok(body.ready);
 const child=(await request('POST',`/api/records/${parent.id}/attachments/${original.id}/processing`,{mimeType:'image/jpeg'})).json().captureId;
 await node!.processing.tick();await organize();assert.equal(node!.files.detail(child).job.state,'succeeded');
 const artifact=node!.files.detail(child).artifacts.find((a:any)=>a.kind==='image-text') as any;assert.equal(artifact.reuse.artifactId,existing.id);
 const required=['source-body',`attachment/${original.id}/text`],pin=node!.materials.input(id,required)!;assert.equal(pin.ready,true);assert.equal(node!.materials.input(id,['source-body'])!.fingerprint,body.fingerprint);
 const evidence=node!.materials.evidence(pin.evidenceIds),geometry=evidence.filter(r=>r.ocrText.includes('"imageLocation"'));assert.ok(geometry.length>0);
 const material=node!.materials.get(id)!;assert.equal(material.memberCount,2);
 const timeline=await node!.featureServices.archiveReader.timeline({deviceId:parent.deviceId}),items=Array.isArray(timeline)?timeline:timeline.items;assert.equal(items.length,1);
 const image=await node!.featureServices.archiveReader.readImage!({id:items[0].id,attachmentId:original.id});assert.equal(sha256(Buffer.from(image.data!,'base64')),manifest.imageSha256);
 assert.equal(node!.store.db.prepare('SELECT COUNT(*) n FROM model_usage').get()!.n,before);
 report.composition={parentId:parent.id,attachmentId:original.id,childId:child,materialRef:material.ref,evidenceBlocks:evidence.length,geometryBlocks:geometry.length,required,originalsUnchanged:true,ocrReused:true};
 await node!.app.close();node=undefined;await start();await organize();await node!.processing.tick();
 assert.equal(node!.materials.input(id,required)!.fingerprint,pin.fingerprint);assert.equal(report.extractionCalls,0);assert.equal(report.modelCalls,0);
 report.restartStable=true;report.status='passed';
}catch(error){report.status='failed';report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{await node?.app.close();assert.equal(sha256(await readFile(join(source,'report.json'))),sha256(seedBytes));report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({status:report.status,modelCalls:report.modelCalls,extractionCalls:report.extractionCalls,report:join(output,'report.json')}));}
