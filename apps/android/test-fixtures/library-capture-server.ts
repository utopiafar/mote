import {materialId} from '../../server/src/materials.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {buildApp} from '../../server/src/app.js';
import type {Config} from '../../server/src/config.js';

/** Loopback-only generated library fixture; denial is an HTTP fault, not a product permission change. */
const readyPath=process.argv[2];
if(!readyPath)throw Error('Provide a private readiness JSON path');
const dataDir=await mkdtemp(join(tmpdir(),'mote-library-native-'));
const token='generated-library-recovery-owner-123456';
const config:Config={dataDir,token,tokenPath:join(dataDir,'token'),host:'127.0.0.1',port:process.argv[3]?z.coerce.number().int().min(1024).max(65535).parse(process.argv[3]):0,profile:'test',tokenFromEnvironment:true,
  dataKey:'31'.repeat(32),maxStorageBytes:20_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,
  allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
const value=await buildApp(config,{agent:{configured:false,query:async()=>{throw Error('No model calls in library fixture');},close:async()=>{}}});
// Hold automatic organization so the explicit generated Material revision stays pinned.
value.materialOrganizer.tick=async()=>0;
let delayMs=0;
let denial:{status:401|403|503;code:string}|undefined;
value.app.addHook('onRequest',async(req,reply)=>{
  if(req.url==='/api/library/source-view'&&delayMs)await new Promise(resolve=>setTimeout(resolve,delayMs));
  if(denial&&['/api/library/device-view','/api/library/source-view'].includes(req.url))return reply.code(denial.status).send({error:denial.code});
});
value.app.post('/api/fixture/library-denial',async req=>{
  const input=z.object({mode:z.enum(['none','forbidden','revoked','offline']),delayMs:z.number().int().min(0).max(3000).default(0)}).strict().parse(req.body);
  delayMs=input.delayMs;
  denial=input.mode==='none'?undefined:input.mode==='offline'?{status:503,code:'fixture_offline'}:input.mode==='forbidden'?{status:403,code:'connection_scope_denied'}:{status:401,code:'connection_revoked'};
  return {mode:input.mode};
});
// Test-only explicit organizer stand-in: generated text, actual Material store and readers.
value.app.post('/api/fixture/library-material',async req=>{
  const q=z.object({sourceId:z.string().startsWith('generated-b1-'),externalId:z.string(),captureId:z.string().uuid(),text:z.string().max(10000)}).strict().parse(req.body);
  const capture=value.featureServices.evidenceReader.archivedEvidence(['capture:'+q.captureId])[0];
  if(capture?.provenance?.sourceId!==q.sourceId||capture.provenance.externalId!==q.externalId)throw Error('Generated source mismatch');
  return value.materials.publish({id:materialId(q.sourceId,q.externalId),kind:'mote.document',schemaVersion:1,title:'Generated B1 organized material',origin:{sourceId:q.sourceId,externalId:q.externalId,deviceId:capture.deviceId,lastAt:capture.capturedAt},members:[{id:'original',kind:'capture',ref:'capture:'+capture.id}],blocks:[{id:'body',kind:'text',format:'plain',text:q.text,memberIds:['original']}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}},{expectedRevision:value.materials.get(materialId(q.sourceId,q.externalId))?.revision});
});
await value.app.listen({host:config.host,port:config.port});
const address=value.app.server.address();if(!address||typeof address==='string')throw Error('Missing listener');
await writeFile(readyPath,JSON.stringify({port:address.port,token,generatedOnly:true}),{mode:0o600});
console.log('Generated library fixture ready');
let closing=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void (async()=>{if(closing)return;closing=true;await value.app.close();await rm(dataDir,{recursive:true,force:true});process.exit(0);})();});
