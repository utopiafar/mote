/** Real HTTP central node for generated-only browser folder upload validation. */
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {buildApp} from '../apps/server/src/app.js';
const directory=process.argv[2];if(!directory)throw Error('Fixture directory required');
const token=randomBytes(32).toString('hex');
const runtime=await buildApp({path:(join(directory,'data'))+'/mote.yaml',privateCredential:{token:token,tokenPath:'generated'},initialDocument:{version:1,revision:0,storage:{dataKey:undefined,dataDir:join(directory,'data'),maxExportBytes:10_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}}}},{agent:{configured:false,query:async()=>{throw Error('No model calls allowed');},close:async()=>{}}});
const settings=runtime.lifecycle.settings();for(const key of ['consolidation','insights','working'] as const)settings[key].enabled=false;await runtime.lifecycle.save({revision:runtime.configService.revision,settings});
runtime.app.get('/__fixture-bootstrap',async(_request,reply)=>reply.type('text/html').send('<!doctype html><html><body>Generated folder upload fixture</body></html>'));
await runtime.app.listen({host:'127.0.0.1',port:0});console.log(JSON.stringify({server:runtime.app.server.address(),token,generatedOnly:true,modelCalls:0}));
process.on('SIGTERM',()=>{void runtime.app.close().then(()=>process.exit(0));});
