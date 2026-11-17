import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import sharp from 'sharp';
import {buildApp} from '../../server/src/app.js';

// Generated profiles and small real Central responses. No capture helper, device or model.
const root=fileURLToPath(new URL('../../../',import.meta.url));
const directory=await mkdtemp(join(tmpdir(),'mote-android-readback-'));
const token=randomBytes(32).toString('hex');let modelCalls=0,child:ChildProcess|undefined;
let central:Awaited<ReturnType<typeof buildApp>>|undefined;
let release:()=>void=()=>{};
const faults={hold:'',started:false,corrupt:'',offline:'',wrongRevision:'',paths:[] as string[]};
const terminate=()=>{if(child?.pid&&child.exitCode===null&&child.signalCode===null)try{process.kill(-child.pid,'SIGTERM');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}};
const interrupt=()=>{release();terminate();};process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
try {
 central=await buildApp({dataDir:join(directory,'central'),token,tokenPath:'generated-only',host:'127.0.0.1',port:0,maxExportBytes:1_000_000,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'},
  {backgroundWorker:false,agent:{configured:false,async query(){modelCalls++;throw Error('Models are forbidden in the readback contract');},async close(){}}});
 central.app.addHook('onRequest',async(req,reply)=>{const path=req.url.split('?')[0]!;if(!path.startsWith('/api/generated-readback'))faults.paths.push(req.method+' '+path);if(faults.offline===path)reply.raw.destroy();});
 central.app.addHook('onSend',async(req,_reply,payload)=>{
  const path=req.url.split('?')[0]!;
  if(req.method==='GET'&&faults.hold===path){faults.started=true;await new Promise<void>(done=>{release=done;});faults.hold='';}
  if(req.method==='GET'&&faults.corrupt===path){
   const chunks:Buffer[]=[];for await(const part of payload as Readable)chunks.push(Buffer.from(part));const bytes=Buffer.concat(chunks);assert.ok(bytes.length>44&&bytes.length<1_000_000);bytes[44]^=0x7f;return bytes;
  }
  if(req.method==='GET'&&faults.wrongRevision===path){const value=JSON.parse(String(payload));value.item.revision='0'.repeat(64);return JSON.stringify(value);}
  return payload;
 });
 central.app.post('/api/generated-readback/control',async req=>{const input=req.body as {hold?:string;corrupt?:string;offline?:string;wrongRevision?:string;release?:boolean;reset?:boolean};
  if(input.reset){release();faults.hold='';faults.started=false;faults.corrupt='';faults.offline='';faults.wrongRevision='';faults.paths=[];}
  for(const key of ['hold','corrupt','offline','wrongRevision'] as const)if(typeof input[key]==='string')faults[key]=input[key]!;
  if(input.release)release();return faults;
 });
 central.app.get('/api/generated-readback/control',async()=>faults);
 const origin=await central.app.listen({host:'127.0.0.1',port:0});
 const image=join(directory,'generated.jpg');await writeFile(image,await sharp({create:{width:5,height:4,channels:3,background:'#236785'}}).jpeg().toBuffer(),{mode:0o600});
 child=spawn(resolve(root,'apps/android/gradlew'),['-p','apps/android','--no-daemon',':app:testDebugUnitTest','--rerun','--tests','dev.mote.collector.LocalContentReadbackHostTest','--tests','dev.mote.collector.LocalContentReleaseTest','--tests','dev.mote.collector.meeting.MeetingContentReleaseTest'],
  {cwd:root,stdio:'inherit',detached:true,env:{...process.env,MOTE_READBACK_ORIGIN:origin,MOTE_READBACK_TOKEN:token,MOTE_READBACK_IMAGE:image}});
 await new Promise<void>((done,reject)=>{let timedOut=false;const timeout=setTimeout(()=>{timedOut=true;interrupt();},15*60_000);child!.once('error',error=>{clearTimeout(timeout);reject(error);});child!.once('close',code=>{clearTimeout(timeout);code===0&&!timedOut?done():reject(Error('Android readback Gradle failed: '+code));});});
 const report=await readFile(resolve(root,'apps/android/app/build/test-results/testDebugUnitTest/TEST-dev.mote.collector.LocalContentReadbackHostTest.xml'),'utf8');
 const suite=report.match(/<testsuite\b[^>]*>/)?.[0]??'';assert.ok(Number(suite.match(/\btests="(\d+)"/)?.[1])>=9);
 for(const attribute of ['failures','errors','skipped'])assert.match(suite,new RegExp(`\\b${attribute}="0"`));
 assert.equal(modelCalls,0);console.log('Android Activity/Store/Library owner → real Central readback passed; modelCalls=0 (generated data, no device).');
} finally {
 process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);release();terminate();await central?.app.close();await rm(directory,{recursive:true,force:true});
}
