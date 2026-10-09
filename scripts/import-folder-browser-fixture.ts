/** Real HTTP central node for generated-only browser folder upload validation. */
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {buildApp} from '../apps/server/src/app.js';
const directory=process.argv[2];if(!directory)throw Error('Fixture directory required');
const token=randomBytes(32).toString('hex');
const runtime=await buildApp({dataKey:undefined,dataDir:join(directory,'data'),token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:100_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{agent:{configured:false,query:async()=>{throw Error('No model calls allowed');},close:async()=>{}}});
const settings=runtime.lifecycle.settings();for(const key of ['consolidation','insights','working'] as const)settings[key].enabled=false;runtime.lifecycle.configure(settings);
runtime.app.get('/__fixture-bootstrap',async(_request,reply)=>reply.type('text/html').send('<!doctype html><html><body>Generated folder upload fixture</body></html>'));
await runtime.app.listen({host:'127.0.0.1',port:0});console.log(JSON.stringify({server:runtime.app.server.address(),token,generatedOnly:true,modelCalls:0}));
process.on('SIGTERM',()=>{void runtime.app.close().then(()=>process.exit(0));});
