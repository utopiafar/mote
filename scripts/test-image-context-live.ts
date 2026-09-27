/** Opt-in single Ask on a completed one-record image import. Keeps all private
 * evidence and output outside Git; no parsing, OCR or Memory is repeated. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {cp,mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import type {UsageReceipt} from '@mote/shared';
import {buildApp} from '../apps/server/src/app.js';
import {repositoryRoot,type Config} from '../apps/server/src/config.js';
import {codexModels} from '../apps/server/src/model-catalog.js';
import {sha256} from '../apps/server/src/store.js';
import {usageTotals} from '../apps/server/src/usage.js';
import {startBridge} from '../packages/agent/dist/bridge.js';

function outside(path:string){const value=resolve(path),part=relative(repositoryRoot,value);assert.ok(part==='..'||part.startsWith('../'),'Private files must stay outside Git');return value;}
assert.ok(process.env.MOTE_IMAGE_CONTEXT_MANIFEST,'Set MOTE_IMAGE_CONTEXT_MANIFEST');
const manifestBytes=await readFile(outside(process.env.MOTE_IMAGE_CONTEXT_MANIFEST));
const manifest=z.object({sourceRun:z.string(),output:z.string(),personalDataUsed:z.boolean(),imageSha256:z.string().length(64),captionBodySha256:z.string().length(64),question:z.string().min(1).max(2000),maximumQueries:z.literal(1),queryTimeoutMs:z.literal(120000),model:z.literal('gpt-6-sol'),reasoningEffort:z.literal('max')}).passthrough().parse(JSON.parse(manifestBytes.toString()));
const source=outside(manifest.sourceRun),directory=outside(manifest.output);
for(const [from,to] of [[source,directory],[directory,source]]){const part=relative(from,to);assert.ok(part==='..'||part.startsWith('../'),'Source and destination must be disjoint');}
const seedBytes=await readFile(join(source,'report.json')),seed=JSON.parse(seedBytes.toString());
assert.equal(seed.status,'passed');assert.equal(seed.records,1);assert.equal(seed.linkedImages,1);assert.equal(seed.liveLlmUsed,false);assert.equal(seed.personalDataUsed,manifest.personalDataUsed);
for(const name of ['mote.sqlite-wal','mote.sqlite-shm'])try{assert.equal((await stat(join(source,'vault',name))).size,0,'Source must be closed');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
await mkdir(directory,{mode:0o700});await writeFile(join(directory,'manifest.json'),manifestBytes,{mode:0o600,flag:'wx'});await cp(join(source,'vault'),join(directory,'vault'),{recursive:true,errorOnExist:true});
const dataDir=join(directory,'vault'),token=randomBytes(32).toString('hex');
const config:Config={dataKey:undefined,dataDir,token,tokenPath:join(dataDir,'token'),host:'127.0.0.1',port:0,maxStorageBytes:500_000_000,maxExportBytes:20_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'gpt-6-sol',modelReasoningEffort:'max',modelProvider:'codex',modelProtocol:'codex-app-server',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'warn',diagnosticsEnabled:true,agentTraceEnabled:true,agentTimeoutMs:120000,codexBin:process.env.MOTE_CODEX_BIN,codexHome:process.env.MOTE_CODEX_HOME};
const report:Record<string,any>={status:'running',startedAt:new Date().toISOString(),personalDataUsed:manifest.personalDataUsed,heldOut:false,model:'gpt-6-sol',reasoningEffort:'max',modelCalls:0,queryTimeoutMs:120000,semanticQualityAccepted:false,memoryGenerated:false,mediaProcessingTested:false,browserTested:false,physicalDeviceTested:false,sourceReportSha256:sha256(seedBytes),manifestSha256:sha256(manifestBytes),head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()};
report.codeHashes=Object.fromEntries(await Promise.all(['scripts/test-image-context-live.ts','apps/server/src/evidence-image.ts','apps/server/src/evidence-reader.ts','apps/server/src/evidence-scope-record.ts','apps/server/src/file-raw-reader.ts','apps/server/src/app.ts','packages/agent/dist/bridge.js','packages/agent/dist/context-tools.js','packages/agent/dist/codex-agent.js','packages/agent/dist/codex-session.js'].map(async path=>[path,sha256(await readFile(join(repositoryRoot,path)))])));
let node:Awaited<ReturnType<typeof buildApp>>|undefined;
const save=()=>writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
try{
 await save();const catalog=await codexModels(undefined,{executable:config.codexBin,home:config.codexHome});assert.ok(catalog.items.find(m=>m.id==='gpt-6-sol')?.reasoningEfforts?.includes('max'));
 node=await buildApp(config,{backgroundWorker:false});
 for(const field of ['model','reasoningEffort'] as const)assert.equal(node.modelSettings.current()[field],manifest[field]);
 assert.equal(node.modelSettings.current().agentTimeoutMs,120000);
 const settings=node.lifecycle.settings();for(const key of ['extraction','consolidation','insights','working'] as const)settings[key].enabled=false;node.lifecycle.configure(settings);
 node.perception.configure({...node.perception.settings(),allowQueryImages:true});
 const records=node.store.evidence(seed.job.captureIds);assert.equal(records.length,1);const parent=records[0],attachment=parent.provenance!.document!.attachments![0];
 assert.equal(sha256(parent.ocrText),manifest.captionBodySha256);
 const image=node.archivedFiles.get(attachment.id!);assert.equal(image.hash,manifest.imageSha256);assert.equal(sha256(node.archivedFiles.read(image.id)),manifest.imageSha256);
 report.parent={id:parent.id,text:parent.ocrText,document:parent.provenance!.document};report.image={id:image.id,sha256:image.hash,sizeBytes:image.sizeBytes};
 for(let i=0;i<100;i++)if(await node.materialOrganizer.tick(100)===0)break;
 const scope={after:'2026-04-13T00:00:00+08:00',before:'2026-04-14T00:00:00+08:00',deviceId:parent.deviceId,timeZone:'Asia/Shanghai'};
 const bridge=await startBridge(node.featureServices.archiveReader,{question:manifest.question,...scope},6);
 let selectedId:string;
 try{
  const call=async(tool:string,args:Record<string,unknown>)=>{const result=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify(args)});assert.equal(result.status,200,'Private image preflight failed before model admission');return result.json() as Promise<any>;};
  const found=await call('timeline',{});assert.equal(found.data.length,1);selectedId=found.data[0].id;
  const expanded=await call('evidence',{ids:[selectedId]});assert.deepEqual(expanded.data[0].provenance.document,parent.provenance!.document);
  const original=await call('read_image',{id:selectedId,attachmentId:image.id});assert.equal(sha256(Buffer.from(original.image.data,'base64')),manifest.imageSha256);
  report.preflight={status:'passed',selectedId,parentId:parent.id,attachmentId:image.id,mimeType:original.image.mimeType,sha256:manifest.imageSha256,modelCalls:0};await save();
 }finally{await bridge.close();}
 const query=node.agent.query.bind(node.agent);node.agent.query=async input=>{
  assert.equal(report.modelCalls,0,'Only one query is authorized');assert.ok(!input.skill&&!input.directImages?.length,'Use normal archive retrieval, not a dialogue attachment or extraction');report.modelCalls++;await save();return query(input);
 };
 await node.app.ready();report.question=manifest.question;await save();console.log(JSON.stringify({stage:'query-started',model:report.model,reasoningEffort:report.reasoningEffort}));
 const start=Date.now(),response=await node.app.inject({method:'POST',url:'/api/query',headers:{authorization:'Bearer '+token,'accept-language':'zh-CN'},payload:{question:manifest.question,...scope}});
 report.durationMs=Date.now()-start;report.httpStatus=response.statusCode;report.result=response.json();await save();assert.equal(response.statusCode,200,'Ask did not complete; preserve the failure without retry');
 const reads=report.result.trace.filter((event:any)=>event.tool==='read_image');assert.ok(reads.some((event:any)=>[parent.id,selectedId].includes(event.arguments.id)&&event.arguments.attachmentId===image.id),'No verified parent attachment read');
 assert.equal(sha256(node.store.evidence([parent.id])[0].ocrText),manifest.captionBodySha256);assert.equal(sha256(node.archivedFiles.read(image.id)),manifest.imageSha256);
 assert.equal(node.memoryPipeline.list().length,0);report.originalsUnchanged=true;report.status='passed';
}catch(error){report.status='failed';report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{
 if(node){
  if(report.parent&&report.image)report.originalsUnchanged=sha256(node.store.evidence([report.parent.id])[0].ocrText)===manifest.captionBodySha256&&sha256(node.archivedFiles.read(report.image.id))===manifest.imageSha256;
  // The HTTP deadline can return before cancellation settles its usage receipt.
  // Drain the app before taking the authoritative terminal usage snapshot.
  await node.app.close();const db=new DatabaseSync(join(dataDir,'mote.sqlite'),{readOnly:true});
  try{const receipts=db.prepare('SELECT json FROM model_usage').all().map(row=>JSON.parse(String(row.json)) as UsageReceipt);report.usage={total:usageTotals(receipts),items:receipts};}finally{db.close();}
 }
 assert.equal(sha256(await readFile(join(source,'report.json'))),sha256(seedBytes));report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({stage:'finished',status:report.status,report:join(directory,'report.json')}));
}
