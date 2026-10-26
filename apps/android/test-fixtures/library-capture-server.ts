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
const config:Config={dataDir,token,tokenPath:join(dataDir,'token'),host:'127.0.0.1',port:0,profile:'test',tokenFromEnvironment:true,
  dataKey:'31'.repeat(32),maxStorageBytes:20_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,
  allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
const value=await buildApp(config,{agent:{configured:false,query:async()=>{throw Error('No model calls in library fixture');},close:async()=>{}}});
let denial:{status:401|403;code:string}|undefined;
value.app.addHook('onRequest',async(req,reply)=>{
  if(denial&&req.url==='/api/library/device-view')return reply.code(denial.status).send({error:denial.code});
});
value.app.post('/api/fixture/library-denial',async req=>{
  const input=z.object({mode:z.enum(['none','forbidden','revoked'])}).strict().parse(req.body);
  denial=input.mode==='none'?undefined:input.mode==='forbidden'?{status:403,code:'connection_scope_denied'}:{status:401,code:'connection_revoked'};
  return {mode:input.mode};
});
await value.app.listen({host:config.host,port:config.port});
const address=value.app.server.address();if(!address||typeof address==='string')throw Error('Missing listener');
await writeFile(readyPath,JSON.stringify({port:address.port,token,generatedOnly:true}),{mode:0o600});
console.log('Generated library fixture ready');
let closing=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void (async()=>{if(closing)return;closing=true;await value.app.close();await rm(dataDir,{recursive:true,force:true});process.exit(0);})();});
