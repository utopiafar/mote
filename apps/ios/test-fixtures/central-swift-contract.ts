import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildApp} from '../../server/src/app.js';
import type {Config} from '../../server/src/config.js';

const root=fileURLToPath(new URL('../../../',import.meta.url));
assert.equal(process.argv.length,2,'Expected no arguments');
const directory=await mkdtemp(join(tmpdir(),'mote-swift-contract-'));
const token=randomBytes(32).toString('hex');
const deviceId='generated-iphone';
const config:Config={dataDir:directory,token,tokenPath:'generated-only',host:'127.0.0.1',port:0,
  maxStorageBytes:50_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,
  allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,
  embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
let central:Awaited<ReturnType<typeof buildApp>>|undefined;
let child:ChildProcess|undefined;
let interrupted=false;
let failure:unknown;
const terminate=()=>{
  if(!child?.pid||child.exitCode!==null||child.signalCode!==null)return;
  try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGTERM');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
};
const interrupt=()=>{interrupted=true;terminate();};
process.once('SIGINT',interrupt);
process.once('SIGTERM',interrupt);
try{
  central=await buildApp(config,{backgroundWorker:false,agent:{configured:false,
    query:async()=>{throw Error('No model belongs in the Swift contract');},close:async()=>{}}});
  const evidenceId=randomUUID();
  await central.store.ingest({id:evidenceId,deviceId,deviceName:'Generated iPhone',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'Generated saved source body'});
  const history=central.conversations.append(undefined,{question:'Generated saved question',evidenceIds:[evidenceId]},
    {answer:'Generated saved answer',citations:[{id:evidenceId,appName:'Generated source',capturedAt:'2026-10-01T00:00:00Z',excerpt:'Generated saved excerpt'}],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[evidenceId]}});
  const saved=central.memories.extract({answer:JSON.stringify({memories:[{title:'Generated Swift memory',statement:'Generated Swift statement ['+evidenceId+']',uncertainty:'Generated fixture only',evidenceIds:[evidenceId],evidence:[{id:evidenceId,quote:'Generated saved source body'}],admission:{layer:'memory',reason:'Generated Swift contract',scope:'Generated fixture only',attribution:'observed'}}]}),
    citations:[{id:evidenceId,appName:'Generated source',capturedAt:'2026-10-01T00:00:00Z',excerpt:'Generated saved excerpt'}],trace:[],runId:randomUUID()},'generated-fixture');
  const memory=central.memories.publish(saved.items[0]!.id);
  const origin=await central.app.listen({host:'127.0.0.1',port:0});
  const response=await central.app.inject({method:'POST',url:'/api/connections/invitations',headers:{authorization:'Bearer '+token},payload:{serverUrl:origin,label:'Generated Swift contract',deviceId}});
  assert.equal(response.statusCode,200,'Generated iOS invitation failed');
  const invitation=JSON.stringify(response.json().invitation);
  if(interrupted)throw Error('Swift contract interrupted before swift test started');
  child=spawn('swift',['test','--package-path','apps/ios/MoteKit','--filter','MoteCentralTests'],{cwd:root,stdio:['inherit','pipe','pipe'],detached:process.platform!=='win32',
    env:{...process.env,MOTE_SWIFT_CONTRACT_INVITATION:invitation,MOTE_SWIFT_CONTRACT_DEVICE_ID:deviceId,
      MOTE_SWIFT_CONTRACT_CONVERSATION:history.conversationId,MOTE_SWIFT_CONTRACT_MEMORY:memory.id}});
  let output='';
  child.stdout?.on('data',(chunk:Buffer)=>{const text=chunk.toString();output+=text;process.stdout.write(text);});
  child.stderr?.on('data',(chunk:Buffer)=>{const text=chunk.toString();output+=text;process.stderr.write(text);});
  await new Promise<void>((done,reject)=>{
    let failure:Error|undefined;
    let force:ReturnType<typeof setTimeout>|undefined;
    const timeout=setTimeout(()=>{
      failure=Error('Swift contract test exceeded 5 minutes');terminate();
      force=setTimeout(()=>{
        if(child?.pid&&child.exitCode===null&&child.signalCode===null){
          try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGKILL');}
          catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')failure=new AggregateError([failure,error],'Swift timeout and termination failed');}
        }
      },5000);
    },5*60*1000);
    child!.once('error',error=>{failure=error;});
    child!.once('close',(code,signal)=>{
      clearTimeout(timeout);clearTimeout(force);
      if(failure)reject(failure);
      else if(code!==0||interrupted)reject(Error(`Swift contract test failed (${signal??code})`));
      else done();
    });
  });
  assert.match(output,/testRealCentralResponsesDecodeThroughProductionClient.*passed/,'The real Central contract case must execute');
  assert.doesNotMatch(output,/testRealCentralResponsesDecodeThroughProductionClient.*skipped/,'The real Central contract case cannot be skipped');
  console.log('Real Fastify → Swift Central contract passed (generated SQLite/HTTP; no device or model).');
}catch(error){failure=error;}
finally{
  process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);
  for(const cleanup of [async()=>{terminate();},async()=>{await central?.app.close();},async()=>{await rm(directory,{recursive:true,force:true});}]){
    try{await cleanup();}
    catch(error){failure=failure?new AggregateError([failure,error],'Swift contract failed; cleanup also failed'):error;}
  }
}
if(failure)throw failure;
