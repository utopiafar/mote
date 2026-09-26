/** Opt-in fixed-parser import, provenance and completed-job restart validation. No LLM calls. */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {basename,join,relative,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {buildApp} from '../apps/server/src/app.js';
import {repositoryRoot,type Config} from '../apps/server/src/config.js';
import {sha256} from '../apps/server/src/store.js';
import type {ImportJob} from '@mote/shared';

const {values}=parseArgs({options:{input:{type:'string'},output:{type:'string'},python:{type:'string'},'time-zone-offset':{type:'string'},'expected-records':{type:'string'},'personal-data':{type:'boolean'},'confirm-preview':{type:'boolean'},resume:{type:'boolean'}}});
assert.ok(values.input&&values.output&&values.python&&values['time-zone-offset'],'Required: --input --output --python --time-zone-offset');
const directory=resolve(values.output),outside=relative(repositoryRoot,directory);
assert.ok(outside==='..'||outside.startsWith('../'),'Private reports must be outside source control');
const previous=values.resume?JSON.parse(await readFile(join(directory,'report.json'),'utf8')):undefined;
if(!previous)await mkdir(directory,{mode:0o700});
const packRoot=join(repositoryRoot,'plugins/source-packs/memex-markdown'),scriptSha256=sha256(await readFile(join(packRoot,'main.py')));
const token=randomBytes(32).toString('hex'),vault=join(directory,'vault');
const config:Config={dataKey:undefined,dataDir:vault,token,tokenPath:join(vault,'token'),host:'127.0.0.1',port:0,
  maxStorageBytes:2_000_000_000,maxExportBytes:200_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
  model:'gpt-6-sol',modelReasoningEffort:'max',modelProvider:'codex',modelProtocol:'codex-app-server',modelBaseUrl:'',apiKey:'',
  allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'warn',agentTimeoutMs:300000,
  importPythonPacks:[{id:'memex.markdown',version:'1',packRoot,script:'main.py',scriptSha256,pythonExecutable:resolve(values.python),maxInputFiles:256,maxOutputBytes:2*1024*1024,config:{timeZoneOffset:values['time-zone-offset']}}]};
let node:Awaited<ReturnType<typeof buildApp>>|undefined;
const report:Record<string,unknown>={startedAt:new Date().toISOString(),status:'running',personalDataUsed:values['personal-data']??false,
  liveLlmUsed:false,mediaProcessingTested:false,browserTested:false,physicalDeviceTested:false,scriptSha256,timeZoneOffset:values['time-zone-offset'],timeZoneBasis:'explicit_test_assumption',stages:[]};
if(previous){
  assert.equal(previous.scriptSha256,scriptSha256,'Resume requires the same pinned parser');assert.equal(previous.personalDataUsed,report.personalDataUsed);assert.equal(previous.timeZoneOffset,report.timeZoneOffset);
  assert.equal(previous.job?.status,'completed','Resume verifies an already completed import only');
  await writeFile(join(directory,`report.previous-${randomUUID()}.json`),JSON.stringify(previous,null,2)+'\n',{mode:0o600,flag:'wx'});report.resumedCompletedJob=previous.jobId;
}
const save=()=>writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
async function stage<T>(name:string,run:()=>Promise<T>){const row:Record<string,unknown>={name,startedAt:new Date().toISOString(),status:'running'};(report.stages as unknown[]).push(row);await save();console.log(JSON.stringify({stage:name}));const start=Date.now();try{const result=await run();row.status='passed';return result;}catch(error){row.status='failed';throw error;}finally{row.durationMs=Date.now()-start;await save();}}
async function start(){
  node=await buildApp(config);const settings=node.lifecycle.settings();for(const key of ['extraction','consolidation','insights','working'] as const)settings[key].enabled=false;node.lifecycle.configure(settings);await node.app.ready();
  const processing=(await request('GET','/api/file-processing')).json();await request('PUT','/api/file-processing',{revision:processing.revision,settings:{...processing.settings,enabled:false}});
}
async function request(method:'GET'|'POST'|'PUT',url:string,payload?:Record<string,unknown>){
  for(let attempt=0;;attempt++){
    const response=await node!.app.inject({method,url,headers:{authorization:'Bearer '+token},...(payload?{payload}:{})});
    if(response.statusCode===429&&method==='GET'&&attempt<2){
      const seconds=Number(response.headers['retry-after']);assert.ok(Number.isFinite(seconds)&&seconds>0&&seconds<=60,'Invalid rate-limit retry interval');
      report.rateLimitWaits=Number(report.rateLimitWaits??0)+1;await save();console.log(JSON.stringify({stage:'respect-read-rate-limit',seconds}));await new Promise(done=>setTimeout(done,seconds*1000));continue;
    }
    assert.ok(response.statusCode>=200&&response.statusCode<300,`${method} ${url}: ${response.statusCode} ${response.body.slice(0,1000)}`);return response;
  }
}
async function settled(id:string):Promise<ImportJob>{
  const deadline=Date.now()+180000;for(;;){const job=(await request('GET',`/api/imports/${id}`)).json<ImportJob>();
    if(!['queued','preparing','importing'].includes(job.status)){report.job=job;await save();return job;}
    assert.ok(Date.now()<deadline,'Import exceeded its functional validation deadline');await new Promise(done=>setTimeout(done,500));}
}
function evidence(ids:string[]){return Array.from({length:Math.ceil(ids.length/200)},(_,index)=>node!.store.evidence(ids.slice(index*200,(index+1)*200))).flat();}
try{
  await save();await start();
  const packs=(await request('GET','/api/import-source-packs')).json();assert.ok(packs.items.some((p:{id:string})=>p.id==='memex.markdown'));assert.ok(!JSON.stringify(packs).includes(packRoot));
  const bytes=await readFile(resolve(values.input));report.inputSha256=sha256(bytes);report.inputBytes=bytes.length;
  if(previous)assert.equal(previous.inputSha256,report.inputSha256,'Resume requires the same original bytes');
  const payload={requestId:previous?.jobId??randomUUID(),name:'Local diary import validation',processing:'automatic',sourcePackId:'memex.markdown',files:[{name:basename(values.input),dataBase64:bytes.toString('base64')}]};
  let job=await stage(previous?'reuse-completed-import':'upload-and-parse',async()=>{const ack=(await request('POST','/api/imports',payload)).json<ImportJob>();report.jobId=ack.id;return settled(ack.id);});
  if(job.status==='awaiting_confirmation'){
    report.preview=job;await save();assert.ok(values['confirm-preview'],'Preview retained: review the private report before publishing');
    assert.equal(job.dispositions?.counts.unsupported,0);assert.equal(job.warnings.length,0);
    assert.ok(job.dispositions?.items.filter(item=>item.status==='excluded').every(item=>item.path.split('/').includes('__MACOSX')||['.DS_Store','README.md'].includes(basename(item.path))),'Unexpected excluded originals require review');
    job=await stage('confirm-reviewed-export-metadata',async()=>{await request('POST',`/api/imports/${job.id}/confirm`,{});return settled(job.id);});
  }
  assert.equal(job.status,'completed',job.error);if(values['expected-records'])assert.equal(job.captureIds.length,Number(values['expected-records']));
  await stage('originals-and-exact-provenance',async()=>{
    const originals=new Map<string,Buffer>();
    for(const file of job.files){const response=await request('GET',`/api/archived-files/${file.id}/content`);assert.equal(sha256(response.rawPayload),file.hash);originals.set(file.id,response.rawPayload);}
    let linked=0;const records=evidence(job.captureIds);assert.equal(records.length,job.captureIds.length);
    for(const row of records){
      const doc=row.provenance!.document!,slice=doc.originalMetadata!.sourceSlice as {unit:string;start:number;end:number;sha256:string};assert.equal(slice.unit,'unicode_code_points');
      const source=originals.get(doc.fileId!)!.toString('utf8');
      assert.equal(Array.from(source).slice(slice.start,slice.end).join(''),row.ocrText);assert.equal(sha256(row.ocrText),slice.sha256);
      assert.notEqual(row.capturedAt,doc.recordedAt);assert.ok(doc.recordedAt?.endsWith(values['time-zone-offset']!));
      const attached=doc.attachments?.length?(await request('GET',`/api/captures/${row.id}/archived-files`)).json():{items:[]};
      for(const attachment of doc.attachments??[]){assert.ok(attached.items.some((file:{id:string})=>file.id===attachment.id));linked++;}
    }
    report.records=records.length;report.linkedImages=linked;report.originalFiles=job.files.length;
  });
  await stage('completed-job-restart-and-duplicate-upload',async()=>{
    await node!.app.close();node=undefined;await start();
    const saved=(await request('GET',`/api/imports/${job.id}`)).json<ImportJob>();assert.equal(saved.status,'completed');assert.deepEqual(saved.captureIds,job.captureIds);
    const replay=(await request('POST','/api/imports',payload)).json<ImportJob>();assert.equal(replay.id,job.id);assert.deepEqual(replay.captureIds,job.captureIds);
    assert.equal(evidence(saved.captureIds).length,saved.captureIds.length);
  });
  report.status='passed';
}catch(error){report.status='failed';report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await save();await node?.app.close();console.log(JSON.stringify({status:report.status,report:join(directory,'report.json')}));}
