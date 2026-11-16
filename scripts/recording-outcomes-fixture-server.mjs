// Generated owner-API and execution fixtures; never reads a saved profile or calls a model.
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {buildApp} from '../apps/server/dist/app.js';
const connection=process.argv[2];if(!connection)throw Error('Private fixture connection path required');
const directory=await mkdtemp(join(tmpdir(),'mote-recording-outcomes-ui-')),token=randomBytes(32).toString('hex');
const provider={id:'feishu',version:'generated-ui@1',account:async()=>({id:'generated-owner',name:'Generated owner'}),discover:async()=>({ids:['empty','unsupported','full']}),metadata:async(_account,id)=>({id,title:'Generated '+id,durationMs:5000}),transcript:async(_account,item)=>item.id==='full'?{rawText:'Generated speech',transcript:{durationMs:5000,coverage:'full',segments:[{startMs:0,endMs:5000,text:'Generated speech'}]}}:item.id==='empty'?{rawText:'2026-09-20 08:00:00 CST|5s\n\nKeywords:\n',transcript:null}:{rawText:'Unknown generated export',transcript:null,formatError:'recording_transcript_format_unsupported'},media:async()=>({mimeType:'audio/wav',bytes:Buffer.concat([Buffer.from('RIFF0000WAVE'),Buffer.alloc(200)])})};
const node=await buildApp({dataDir:directory,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxExportBytes:16*1024*1024,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',allowUnauthenticatedLocal:false},{backgroundWorker:false,connectorTesting:{recordings:[provider]},agent:{configured:false,query:async()=>{throw Error('Generated fixture forbids model calls');},close:async()=>{}}});
const {app,executor}=node;
// Declared UI readiness stub, separate from the real worker lifecycle tests.
app.addHook('onRequest',async(req,reply)=>{if(req.url==='/api/media-models'&&req.headers.authorization==='Bearer '+token)return reply.send({dialogue:{state:'ready',bytes:10,totalBytes:10,runtimeReady:false,missingDependencies:['ffmpeg']},ocr:{state:'ready',bytes:10,totalBytes:10,runtimeReady:true}});});
executor.register({kind:'generated.ui',pool:'generated.ui',concurrency:()=>1,validate:()=>true,execute:async()=>null,commit:()=>{}});
for(const [id,error,optional] of [['file:generated-archive','archive_only',true],['file:generated-unknown','processor_response_unknown',false],['import:generated-confirm','awaiting_confirmation',false]])executor.enqueue(id,'generated.ui',{}, {optional,initial:{state:'blocked',attempts:0,availableAt:0,error}});
for(const suffix of ['/connect','/selection']){const result=await app.inject({method:suffix==='/connect'?'POST':'PUT',url:'/api/connectors/feishu-recordings'+suffix,headers:{authorization:'Bearer '+token},...(suffix==='/selection'?{payload:{enabled:true,start:'2026-09-01T00:00:00Z',end:'2026-10-01T00:00:00Z',autoSync:false,backupAudio:true}}:{})});if(result.statusCode!==200)throw Error(result.body);}
for(let i=0;i<30;i++){const steps=node.store.db.prepare("SELECT id FROM execution_steps WHERE kind LIKE 'recording.feishu.%' AND state IN ('waiting','running')").all();if(!steps.length)break;await executor.drain(steps.map(step=>String(step.id)));}
await app.listen({host:'127.0.0.1',port:0});await writeFile(connection,JSON.stringify({url:app.listeningOrigin,token}),{mode:0o600,flag:'wx'});
let closing=false;async function close(){if(closing)return;closing=true;await app.close();await rm(directory,{recursive:true,force:true});await rm(connection,{force:true});process.exit(0);}process.once('SIGTERM',close);process.once('SIGINT',close);
